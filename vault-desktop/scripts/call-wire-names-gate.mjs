// Гейт паритета JS ↔ Rust: ЗНАЧЕНИЯ проводных имён протокола звонка.
//
// ЗАЧЕМ. `tauri-args-gate` меряет ИМЕНА аргументов команд, но не их
// ЗНАЧЕНИЯ. На звонке граница держится на литералах: `callNextState(state,
// 'hung_up')`, `callCan(state, 'arm_ring_timer')`, `applyCallState('accepted')`.
// Если JS пришлёт выдуманное имя, ядро не ошибётся — `vault_call_next_state`
// вернёт ТЕКУЩЕЕ состояние, `vault_call_can` вернёт false. Молчаливый no-op:
// звонок не переходит в active, кнопка «не работает», в логе пусто.
//
// ОТКУДА СЛОВАРЬ. `vault-client/tests/fixtures/call-wire-names.json` — общий
// контракт. Rust-тест `wire_names_match_contract_fixture` держит паритет
// «ядро ↔ фикстура» (ядро печатает имена через `CallEvent::name` /
// `question_name`), этот гейт — паритет «фикстура ↔ JS». Расхождение на любой
// стороне падает сборкой, а не превращается в молчаливый no-op на приёмке.
//
// ЧТО ПРОВЕРЯЕТСЯ. Каждый СТРОКОВЫЙ литерал, переданный в адаптер правила:
//   * события: `callNextState(…, '…')`, `canApply(…, '…')`,
//     `applyCallState('…')`;
//   * вопросы: `callCan(…, '…')`, `canCached(…, '…')`.
// Переменные (не литералы) пропускаются — их значения приходят из ядра.
//
// Запуск: node scripts/call-wire-names-gate.mjs
// Выход: 0 — имена совпадают; 1 — есть незнакомое имя (сборка падает).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const FIXTURE = path.resolve(ROOT, '..', 'vault-client', 'tests', 'fixtures', 'call-wire-names.json');

function fail(headline, details) {
  console.log('✗ call-wire-names-gate: ' + headline);
  for (const d of details) console.log('  • ' + d);
  console.log('\n  Почему это важно: незнакомое имя ядро не отвергает — оно молча');
  console.log('  возвращает текущее состояние или false. Звонок зависает, кнопка');
  console.log('  «не работает», и никакой ошибки в логе нет.');
  process.exit(1);
}

// ── 1. Словарь (контракт ядра, сверен Rust-тестом) ────────────────────────
let vocab;
try {
  vocab = JSON.parse(readFileSync(FIXTURE, 'utf8'));
} catch (e) {
  fail(`словарь ядра не читается (${path.relative(ROOT, FIXTURE)}): ${e.message}`, []);
}

const vocabProblems = [];
const sets = {};
for (const key of ['events', 'questions']) {
  const list = vocab[key];
  if (!Array.isArray(list) || !list.length) {
    vocabProblems.push(`в словаре нет непустого списка «${key}»`);
    continue;
  }
  const bad = list.filter((x) => typeof x !== 'string' || !x);
  if (bad.length) vocabProblems.push(`«${key}»: не строки — ${JSON.stringify(bad)}`);
  const dup = list.filter((x, i) => list.indexOf(x) !== i);
  if (dup.length) vocabProblems.push(`«${key}»: повтор имени — ${[...new Set(dup)].join(', ')}`);
  sets[key] = new Set(list);
}
if (vocabProblems.length) fail('словарь ядра испорчен', vocabProblems);

// ── 2. Литералы в фичах ───────────────────────────────────────────────────
// Функция адаптера → индекс аргумента, в котором лежит проводное имя.
const EVENT_CALLS = new Map([
  ['callNextState', 1],
  ['canApply', 1],
  ['applyCallState', 0],
]);
const QUESTION_CALLS = new Map([
  ['callCan', 1],
  ['canCached', 1],
]);
const CANDIDATE_RE = /\b(callNextState|canApply|applyCallState|callCan|canCached)\s*\(/g;

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|vue)$/.test(f)) out.push(p);
  }
  return out;
}

// Аргументы вызова: разбор с балансировкой скобок и пропуском строк.
function readArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { args.push(src.slice(start, i)); return args; }
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return null;
}

const problems = [];
const hits = { events: 0, questions: 0 };
const seen = { events: new Set(), questions: new Set() };

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const re = new RegExp(CANDIDATE_RE.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const fn = m[1];
    const kind = EVENT_CALLS.has(fn) ? 'events' : 'questions';
    const argIndex = (EVENT_CALLS.get(fn) ?? QUESTION_CALLS.get(fn));
    const args = readArgs(src, m.index + m[0].length - 1);
    if (!args || args.length <= argIndex) continue;
    const raw = args[argIndex].trim();
    const lit = raw.match(/^(['"])([^'"]*)\1$/);
    if (!lit) continue;   // переменная: значение решает ядро, не JS
    const name = lit[2];
    const line = src.slice(0, m.index).split('\n').length;
    hits[kind]++;
    seen[kind].add(name);
    if (!sets[kind].has(name)) {
      problems.push(`${rel}:${line} — ${fn}: имени «${name}» нет в словаре ${kind === 'events' ? 'событий' : 'вопросов'} ядра`);
    }
  }
}

if (problems.length) fail('JS и Rust разошлись в проводных именах звонка', problems);

// ── 3. Самопроверка гейта ─────────────────────────────────────────────────
// Гейт, который ничего не нашёл, зелёный всегда — это декорация. Пороги
// занижены намеренно: они ловят «сканирование сломалось», а не фиксируют
// текущее число мест (иначе законное удаление вызова валило бы сборку).
const selfProblems = [];
if (hits.events < 4) selfProblems.push(`найдено ${hits.events} литералов событий (ожидалось ≥ 4) — сканирование сломано`);
if (hits.questions < 8) selfProblems.push(`найдено ${hits.questions} литералов вопросов (ожидалось ≥ 8) — сканирование сломано`);
if (selfProblems.length) fail('гейт не видит литералов — проверка декоративна', selfProblems);

console.log(`✓ call-wire-names-gate: ${hits.events} литералов событий (${seen.events.size} имён) и ${hits.questions} литералов вопросов (${seen.questions.size} имён) совпадают со словарём ядра`);
