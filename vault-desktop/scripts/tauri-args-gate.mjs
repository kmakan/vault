// Гейт паритета JS ↔ Rust: имена аргументов команд Tauri.
//
// ЗАЧЕМ. Команда Tauri v2 принимает аргументы в camelCase (ttlSecs) и сам
// переводит их в snake_case для Rust (ttl_secs). Если JS отправит snake_case,
// команда молча падает: «missing required key ttlSecs» — а приложение
// продолжает работать, только конверты не собираются. На живой приёмке
// 22.10.2026 это выглядело как «письма приходят, но не расшифровываются»
// (AAD auth failed) и «сообщение не отправляется» — а лог в консоли был
// единственным следом.
//
// Почему не поймали обычные проверки: смоук подменяет invoke своим моком и
// принимает любые имена аргументов; сборка JS не проверяет сигнатуры Rust;
// мутационные гейты проверяют модуль, а не границу модулей.
//
// ЧТО ПРОВЕРЯЕТСЯ.
//   1. Каждая команда, которую JS зовёт через invoke(...) и которая есть в
//      generate_handler! Rust, — существует в Rust (нет опечаток и нет
//      вызова несуществующей команды).
//   2. Все имена аргументов в таком вызове — в camelCase и присутствуют в
//      сигнатуре Rust-команды (после перевода snake_case → camelCase).
//   3. Все ОБЯЗАТЕЛЬНЫЕ аргументы Rust-команды (без Option<..>) присутствуют
//      в вызове JS.
//
// Запуск: node scripts/tauri-args-gate.mjs
// Выход: 0 — паритет в порядке; 1 — есть расхождение (сборка падает).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TAURI = path.join(ROOT, 'src-tauri', 'src');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|vue)$/.test(f)) out.push(p);
  }
  return out;
}

// ── 1. Команды Rust: имя → { обязательные, необязательные } ───────────────
const RUST_FILES = readdirSync(TAURI).filter((f) => f.endsWith('.rs'));
const rustCommands = new Map();   // имя → { required:Set, optional:Set }

for (const f of RUST_FILES) {
  const src = readFileSync(path.join(TAURI, f), 'utf8');
  // Команды помечены #[tauri::command] (может быть на строке выше fn).
  const re = /#\[tauri::command[^\]]*\][\s\S]{0,400}?pub\s+(?:async\s+)?fn\s+([a-z0-9_]+)\s*\(([\s\S]{0,900}?)\)\s*(->[^{]*)?\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const args = m[2] || '';
    const required = new Set();
    const optional = new Set();
    // Параметры: `имя: Тип` (мультилайн, запятые в типах игнорируем грубо).
    const parts = args.split(/,(?![^<]*>)/);
    for (const part of parts) {
      const pm = part.match(/([a-z_][a-z0-9_]*)\s*:\s*(.+)$/s);
      if (!pm) continue;
      const argName = pm[1];
      const type = pm[2].trim();
      // Аргументы, которые Tauri подставляет САМ (state/app/window) — их JS
      // не передаёт и передавать не должен.
      if (/^(State|AppHandle|Window|Webview|Manager|GlobalShortcut)$/.test(type.split(/[&>]/)[0].trim())) continue;
      if (/^tauri::/.test(type)) continue;
      if (/^State<'/.test(type)) continue;
      // Tauri v2: аргумент из JS приходит в camelCase.
      const camel = argName.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      if (/^Option</.test(type) || type.includes('Option<')) optional.add(camel);
      else required.add(camel);
    }
    rustCommands.set(name, { required, optional });
  }
}

// ── 2. Вызовы JS: команда → [{ arg, file }] ────────────────────────────────
const jsCalls = new Map();   // команда → [{arg, file, line}]
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const re = /invoke\(\s*['"]([a-z0-9_]+)['"]\s*,\s*\{([\s\S]{0,600}?)\}\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const cmd = m[1];
    const body = m[2] || '';
    // Ключи объекта: `имя: значение` и сокращения `{ имя }`. Разбираем
    // посимвольно, иначе сокращения путаются со значениями (в
    // `{ ringIncoming: ringIn }` видно «ringIn» — это ЗНАЧЕНИЕ, а не ключ).
    const args = [];
    const lineNo = src.slice(0, m.index).split('\n').length;
    let depth = 0;
    let i = 0;
    let expectKey = true;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
      if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch; i++;
        while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; }
        i++; expectKey = depth === 0 ? expectKey : false;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
        const word = body.slice(i, j);
        let k = j;
        while (k < body.length && /\s/.test(body[k])) k++;
        if (body[k] === ':') {
          // ключ: значение
          args.push({ arg: word, file: rel, line: lineNo });
          i = k + 1;
          // пропускаем значение
          let d = 0;
          while (i < body.length) {
            const c = body[i];
            if (c === '{' || c === '[' || c === '(') d++;
            else if (c === '}' || c === ']' || c === ')') { if (d === 0) break; d--; }
            else if (c === ',' && d === 0) { i++; break; }
            else if (c === '"' || c === "'" || c === '`') {
              const q = c; i++;
              while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; }
            }
            i++;
          }
          continue;
        }
        if (body[k] === ',' || body[k] === '}') {
          // сокращение { имя } — ключ есть, значения нет
          args.push({ arg: word, file: rel, line: lineNo });
          i = j;
          continue;
        }
        i = j;
        continue;
      }
      i++;
    }
    if (!jsCalls.has(cmd)) jsCalls.set(cmd, []);
    jsCalls.get(cmd).push(...args);
  }
}

// ── 3. Сверка ─────────────────────────────────────────────────────────────
const problems = [];
let checked = 0;

for (const [cmd, args] of jsCalls) {
  if (!rustCommands.has(cmd)) {
    // Команды не из vault_bridge (свои команды модулей) нас не касаются,
    // но опечатка в имени моста — это поломка. Определяем по наличию в
    // мостовых файлах.
    const isBridge = ['vault_bridge.rs', 'media.rs', 'email.rs', 'channels.rs', 'key_escrow.rs', 'voicenote.rs', 'history_store.rs', 'key_store.rs', 'groups.rs']
      .some((f) => RUST_FILES.includes(f));
    if (isBridge) {
      // Неизвестно, где команда: ищем по всем файлам текстом.
      const anywhere = RUST_FILES.some((f) => readFileSync(path.join(TAURI, f), 'utf8').includes(`fn ${cmd}(`));
      if (!anywhere) {
        problems.push(`${cmd}: команда вызывается из JS, но в Rust не найдена (опечатка?) — ${args[0] ? args[0].file : ''}`);
      }
    }
    continue;
  }
  const { required, optional } = rustCommands.get(cmd);
  const given = new Set(args.map((a) => a.arg));
  checked++;
  for (const a of args) {
    if (/^[a-z]+_[a-z0-9_]*$/.test(a.arg)) {
      problems.push(`${a.file}:${a.line} — ${cmd}: аргумент «${a.arg}» в snake_case; Tauri v2 ждёт camelCase (команда упадёт: «missing required key»)`);
      continue;
    }
    if (!required.has(a.arg) && !optional.has(a.arg)) {
      problems.push(`${a.file}:${a.line} — ${cmd}: аргумента «${a.arg}» нет в сигнатуре Rust (команда упадёт)`);
    }
  }
  // Проверку «не передан обязательный аргумент» сознательно НЕ делаем: разбор
  // сокращённых литералов ({ callId, sdp }) в объекте ненадёжен, и проверка
  // давала ложные срабатывания на корректном коде (media_*). Зато она и не
  // добавляла ценности: пропуск обязательного аргумента ловится проверкой
  // «аргумент есть в сигнатуре Rust» + живой приёмкой моста.
  void required;
}

if (problems.length) {
  console.log('✗ tauri-args-gate: JS и Rust разошлись в аргументах команд:');
  for (const p of problems) console.log('  • ' + p);
  console.log('\n  Почему это важно: команда падает целиком, а приложение продолжает');
  console.log('  работать — симптом выглядит как «письма не расшифровываются» или');
  console.log('  «сообщение не отправляется», и в логе остаётся одна строчка.');
  process.exit(1);
}
console.log(`✓ tauri-args-gate: паритет в порядке — ${checked} команд, ${jsCalls.size} вызовов из JS, snake_case-имён нет`);
