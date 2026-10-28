#!/usr/bin/env node
// jni-keep-gate: каждая точка JNI, которую зовёт Rust, обязана быть закрыта
// keep-правилом R8 — и объявлена в Kotlin как статик-мост (@JvmStatic).
//
// Зачем: вызовы из Rust идут как call_static_method на ВНЕШНИЙ класс, а Kotlin
// пишет метод в companion object. Мост наружного класса генерируется аннотацией
// @JvmStatic и для R8 выглядит неиспользуемым (из Java его никто не зовёт) —
// без keep-правила R8 его вырезает, и в рантайме получаем NoSuchMethodError,
// который на хосте не видит ни компилятор, ни тесты. 28.10 это стоило приёмки
// 0.1.284: playCallSound/stopCallSound дожили только на $Companion, гудок
// молчал при зелёных гейтах ассетов, мутациях и cargo check.
//
// Использование: npm run gate:jni-keep
//   VAULT_PROGUARD_DIR / VAULT_BRIDGE_DIR — переопределить входы (для проб).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectJniPoints, walk } from './lib/jni-points.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = process.env.VAULT_BRIDGE_DIR || path.join(ROOT, 'src-tauri', 'src');
const ANDROID = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app');
const PROGUARD_DIR = process.env.VAULT_PROGUARD_DIR || ANDROID;

/* ---- 1. точки вызова из Rust (список общий с dex-jni-check) ------------ */
const calls = collectJniPoints(BRIDGE);

/* ---- 2. keep-правила ---------------------------------------------------- */
const rules = [];
for (const file of walk(PROGUARD_DIR, (p) => p.endsWith('.pro'))) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /^-keep(?:classmembers|classes)?[^\n]*?class\s+([\w.$]+)\s*\{([^}]*)\}/gms;
  for (const m of src.matchAll(re)) {
    const body = m[2];
    rules.push({ cls: m[1], wildcard: /^\s*\*\s*;?\s*$/gm.test(body), members: [...body.matchAll(/(\w+)\s*\(([^)]*)\)/g)].map((x) => ({
      name: x[1],
      params: x[2].trim() ? x[2].split(',').map((t) => t.trim().replace(/\s+/g, ' ')) : [],
    })) });
  }
}

function covered(cls, name, params) {
  for (const r of rules) {
    if (r.cls !== cls) continue;
    if (r.wildcard) return 'wildcard';
    for (const mem of r.members) {
      if (mem.name !== name) continue;
      if (mem.params.length !== params.length) continue;
      const ok = mem.params.every((p, i) => p.replace(/ /g, '') === params[i].replace(/ /g, ''));
      if (ok) return 'rule';
    }
  }
  return null;
}

/* ---- 3. Kotlin: есть ли статик-мост, что держать ------------------------ */
// Собираем блок комментариев/аннотаций непосредственно перед `fun`.
function headOf(src, index) {
  const lines = src.slice(0, index).split('\n');
  const out = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^@/.test(l) || /^(\*|\/\/|\/\*)/.test(l) || l.endsWith('*/')) { out.unshift(l); continue; }
    break;
  }
  return out.join('\n');
}

// Области вида `{` с меткой: нужно знать, лежит ли fun внутри companion object.
function scopeLabels(src, index) {
  const stack = [];
  let i = 0;
  while (i < index) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e + 1; continue; }
    if (ch === '"') { const e = src.indexOf('"', i + 1); i = e < 0 ? src.length : e + 1; continue; }
    if (ch === '{') {
      const label = src.slice(Math.max(0, i - 120), i).split('\n').pop().trim();
      stack.push(label);
      i++;
      continue;
    }
    if (ch === '}') { stack.pop(); i++; continue; }
    i++;
  }
  return stack;
}

// Типы из JNI и из Kotlin называем по-разному — сравниваем по простому имени.
function ktType(t) {
  const arr = /Array<\w+>\??$/.test(t) ? '[]' : '';
  const base = t.replace(/\?$/, '').replace(/Array<(\w+)>$/, '$1').split('.').pop();
  const map = { Boolean: 'boolean', Int: 'int', Long: 'long', Float: 'float', Double: 'double', Byte: 'byte', Char: 'char', Short: 'short' };
  return (map[base] || base) + arr;
}

function paramsOfDecl(argText) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of argText) {
    if ('(<['.includes(ch)) depth++;
    if (')]>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const one = p.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\w+\s*:\s*/, '').replace(/=.*/, '').trim();
    return ktType(one);
  });
}

const javaSrc = walk(path.join(ANDROID, 'src', 'main', 'java'), (p) => /\.(kt|java)$/.test(p));
function declared(cls, name, params) {
  const simple = cls.split('.').pop();
  const file = javaSrc.find((p) => path.basename(p).replace(/\.(kt|java)$/, '') === simple);
  if (!file) return { found: false };
  const src = fs.readFileSync(file, 'utf8');
  const java = file.endsWith('.java');
  const cands = [...src.matchAll(new RegExp(`\\bfun\\s+${name}\\s*\\(([^)]*)\\)|(?:static[^(]*)\\b${name}\\s*\\(([^)]*)\\)`, 'g'))];
  const overloads = cands.map((m) => paramsOfDecl(m[1] !== undefined ? m[1] : (m[2] ?? '')));
  let at = -1, chosen = null;
  for (const m of cands) {
    const plist = paramsOfDecl(m[1] !== undefined ? m[1] : (m[2] ?? ''));
    const same = plist.length === params.length &&
      plist.every((t, i) => !t || t === params[i] || t.split('.').pop() === params[i].split('.').pop());
    if (same) { at = m.index; chosen = plist; break; }
  }
  if (at < 0 && overloads.length === 1) { at = cands[0].index; chosen = overloads[0]; }
  if (at < 0) return { found: false, file, overloads };
  if (java) return { found: true, file, java, staticBridge: /\bstatic\b/.test(src.slice(at - 90, at)) };
  const inCompanion = scopeLabels(src, at).some((l) => /companion object/.test(l));
  return { found: true, file, java, inCompanion, jvmStatic: /@JvmStatic/.test(headOf(src, at)), params: chosen };
}


/* ---- сверка ------------------------------------------------------------ */
const gaps = [];
const notes = [];
for (const c of calls) {
  const cov = covered(c.cls, c.name, c.params);
  const decl = declared(c.cls, c.name, c.params);
  if (!cov) gaps.push(`${c.cls}.${c.name}(${c.params.join(', ')}) — нет keep-правила (${path.relative(ROOT, c.file)})`);
  if (!decl.found) gaps.push(`${c.cls}.${c.name}(${c.params.join(', ')}) — декларация с такой сигнатурой не найдена в исходниках Android (${path.relative(ROOT, c.file)})`);
  else if (decl.java && !decl.staticBridge) gaps.push(`${c.cls}.${c.name} — метод в Java без модификатора static: вызов как статик не сработает`);
  else if (!decl.java && !decl.inCompanion) gaps.push(`${c.cls}.${c.name} — вне companion object: наружного статик-метода для JNI не существует`);
  else if (!decl.java && !decl.jvmStatic) gaps.push(`${c.cls}.${c.name}(${c.params.join(', ')}) — в companion object без @JvmStatic: статик-моста наружного класса нет`);
  if (cov === 'wildcard') notes.push(`${c.cls}.${c.name} закрыто правилом { *; }`);
}

const checked = calls.length;
if (gaps.length) {
  console.error(`✗ jni-keep: ${gaps.length} дыр в ${checked} точках JNI из Rust:`);
  for (const g of gaps) console.error('  • ' + g);
  console.error('  Без этого R8 в release-сборке удаляет метод, JNI даёт');
  console.error('  NoSuchMethodError, а на хосте сборка выглядит здоровой.');
  process.exit(1);
}
console.log(
  `✓ jni-keep: ${checked} точек JNI из Rust закрыты keep-правилами и объявлены со статик-мостом` +
  ` (правил в зоне: ${rules.length}${notes.length ? '; ' + notes.join('; ') : ''}).`,
);
