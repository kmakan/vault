#!/usr/bin/env node
// dex-jni-check: каждая точка JNI, которую зовёт Rust, обязана лежать в
// собранном APK СТАТИЧЕСКИМ методом на ВНЕШНЕМ классе — с той же сигнатурой.
//
// Чем этот шаг отличается от jni-keep-gate: тот сверяет тексты (правила R8 и
// декларации Kotlin), а этот смотрит на готовый DEX. Разница видела нас twice:
// 28.10 keep-правил не было, и ни один хостовый тест не отличал «метод есть на
// $Companion» от «метод есть на наружном классе» — а JNI зовёт наружный.
// Проверка по DEX — последнее, что можно снять без телефона.
//
// Использование: node scripts/dex-jni-check.mjs <путь к APK>
//   VAULT_DEXDUMP — путь к dexdump (по умолчанию ищется в Android SDK).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectJniPoints } from './lib/jni-points.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apk = process.argv[2];
if (!apk || !fs.existsSync(apk)) {
  console.error('использование: node scripts/dex-jni-check.mjs <APK>');
  process.exit(2);
}

function findDexdump() {
  if (process.env.VAULT_DEXDUMP) return process.env.VAULT_DEXDUMP;
  const bt = path.join(os.homedir(), 'Android', 'Sdk', 'build-tools');
  if (!fs.existsSync(bt)) return null;
  const vers = fs.readdirSync(bt).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] | 0) !== (pb[i] | 0)) return (pb[i] | 0) - (pa[i] | 0);
    return 0;
  });
  for (const v of vers) {
    const p = path.join(bt, v, 'dexdump');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const dexdump = findDexdump();
if (!dexdump) {
  console.error('✗ dex-jni-check: dexdump не найден (Android SDK build-tools).');
  console.error('  Без него проверка не снимается — сборку не считать принятой.');
  process.exit(1);
}

// DEX лежит внутри APK как zip: распаковываем classes*.dex во временный каталог.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dexjni-'));
try {
  execFileSync('unzip', ['-qo', apk, 'classes*.dex', '-d', tmp]);
} catch (e) {
  console.error('✗ dex-jni-check: не удалось прочитать classes*.dex из ' + apk);
  console.error(String(e && e.message ? e.message : e).slice(0, 200));
  process.exit(1);
}
const dexFiles = fs.readdirSync(tmp).filter((f) => /^classes\d*\.dex$/.test(f));
if (!dexFiles.length) {
  console.error('✗ dex-jni-check: в APK нет classes*.dex — проверить сборку');
  process.exit(1);
}
let dump = '';
for (const f of dexFiles) {
  dump += execFileSync(dexdump, ['-d', path.join(tmp, f)], { maxBuffer: 512 * 1024 * 1024 })
    .toString('utf8');
}
fs.rmSync(tmp, { recursive: true, force: true });

/* Методы из дампа: dexdump печатает владельца, имя, дескриптор и флаги доступа
   подряд — «(in Lcom/…;)» это ровно тот класс, на котором JNI ищет метод. */
const STATIC_FLAG = 0x0008;
const methods = [];
const re = /#-?\d+\s*: \(in (L[^;]+);[^)]*\)\s*\n\s*name\s+: '([^']+)'\s*\n\s*type\s+: '([^']+)'\s*\n\s*access\s+: (0x[0-9a-f]+)/g;
for (const m of dump.matchAll(re)) {
  methods.push({
    cls: m[1].slice(1).replace(/\//g, '.'),
    name: m[2],
    sig: m[3],
    static: !!(parseInt(m[4], 16) & STATIC_FLAG),
  });
}
if (!methods.length) {
  console.error('✗ dex-jni-check: дамп dexdump не разобран — формат не совпал.');
  console.error('  Молча считать проверку пройденной нельзя: собери дамп вручную.');
  process.exit(1);
}

const calls = collectJniPoints(path.join(ROOT, 'src-tauri', 'src'));
const gaps = [];
for (const c of calls) {
  const hit = methods.find((m) => m.cls === c.cls && m.name === c.name && m.sig === c.sig && m.static);
  if (!hit) {
    const anywhere = methods.filter((m) => m.name === c.name && (m.cls === c.cls || m.cls.startsWith(c.cls + '$')));
    const detail = anywhere.length
      ? `есть только на: ${[...new Set(anywhere.map((m) => m.cls + (m.static ? ' — static' : ' — НЕ static')))].join(', ')}`
      : 'в DEX нет совсем';
    gaps.push(`${c.cls}.${c.name}${c.sig} — на вызываемом классе как static: ${detail}`);
  }
}

if (gaps.length) {
  console.error(`✗ dex-jni-check: ${gaps.length} из ${calls.length} точек JNI отсутствуют как статические методы на вызываемом классе (${path.basename(apk)}):`);
  for (const g of gaps) console.error('  • ' + g);
  console.error('  Причина обычно R8: нет keep-правила или нет @JvmStatic.');
  console.error('  Такой APK на устройстве даст NoSuchMethodError — не принимать.');
  process.exit(1);
}
console.log(`✓ dex-jni-check: все ${calls.length} точек JNI из Rust видны в DEX как статические методы с нужной сигнатурой (${path.basename(apk)}).`);
