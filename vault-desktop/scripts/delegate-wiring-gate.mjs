// Гейт проводки делегатов (ADR-005 W3-долг, канбан t_204ab11e).
//
// ЗАЧЕМ. Аудит-гейты (audit:arch, js-logic-ratchet) меряют РАЗМЕЩЕНИЕ логики
// (кто пишет состояние, а не как). Класс регрессии, который они не ловят:
// фича-функция ВЫЧИСЛЯЕТ новое состояние и ВОЗВРАЩАЕТ его, но не вызывает
// сеттер; в шаблоне `@click="fn(...)"` возвращаемое значение выбрасывается —
// клик молча ничего не меняет. Было на реакциях (c7a1f65): десктоп 3 недели
// не мог открыть пикер реакций при зелёных всех гейтах.
//
// ПРАВИЛО. Экспорт фичи с именем-переключателем/открывателем
// (toggle|set|open|close|show|hide|start|stop|next*) И с `return <выражение>`
// (т.е. возвращает состояние) И БЕЗ ни одного вызова сеттера внутри тела
// — кандидат в дефект. Разрешён только явным allowlist с причиной.
//
// ЗАПУСК: node scripts/delegate-wiring-gate.mjs   (0 — чисто, 1 — есть defect)

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(import.meta.dirname, '../src/features');
const NAME_RE = /^export (?:async )?function ((?:toggle|set|open|close|show|hide|start|stop|next)[A-Z]\w*)\s*\(/;
const SETTER_RE = /(?:\bset[A-Z]\w*|\bdeps\.set\w+|\.\bset(?:Modal|FormField|Field|State)\w*)\s*\(/;
// return с нетривиальным выражением (голый `return;` не считается).
const RETURN_VALUE_RE = /\breturn\s+(?!;|return\b|undefined\b|false\b|true\b|0\b|''|"")([^;\n]+)/;

// Функции, возвращающие НЕ состояние (результат работы, bool, id) —
// с причиной. Новую запись без причины не добавлять: это признание дыры.
const ALLOW = new Set([
  'stopVideoTracks',      // возвращает void-чистку треков, не состояние UI
  'stopRemoteVideo',      // возвращает bool успеха для вызывающей фичи
  'startRemoteVideo',     // возвращает bool готовности рендера, не состояние UI
  'stopCamera',           // возвращает bool успеха (смоук проверяет его)
  'startFastPolling',     // состояние живёт в module-level loop, не во Vue
  'stopFastPolling',      // то же
  'showHistoryFirst',     // чистая функция решения («показывать ли первую стр.»)
]);

function bodyFrom(srcText, startIdx) {
  // Тело — по балансу фигурных скобок от первой { после сигнатуры.
  let i = srcText.indexOf('{', startIdx);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < srcText.length; j++) {
    const c = srcText[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return srcText.slice(i, j + 1); }
  }
  return srcText.slice(i);
}

const defects = [];
let checked = 0;
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const m = lines[ln].match(NAME_RE);
    if (!m) continue;
    const name = m[1];
    checked++;
    const body = bodyFrom(text, text.indexOf(lines[ln]));
    const hasSetter = SETTER_RE.test(body);
    const returnsState = RETURN_VALUE_RE.test(body);
    if (returnsState && !hasSetter && !ALLOW.has(name)) {
      defects.push(`${file}:${ln + 1} ${name} — возвращает значение, сеттер не вызван`);
    }
  }
}

// Отдельная проверка: allowlist не должен протухать (функция исправлена —
// убрать метку, иначе дыра спрячется за разрешением).
const stale = [];
for (const name of ALLOW) {
  let found = false;
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    const m = text.match(new RegExp('^export (?:async )?function ' + name + '\\s*\\(', 'm'));
    if (!m) continue;
    found = true;
    const body = bodyFrom(text, text.indexOf(m[0]));
    if (SETTER_RE.test(body)) stale.push(name + ' — сеттер появился, метку ALLOW убрать');
  }
  if (!found) stale.push(name + ' — функции больше нет, метку ALLOW убрать');
}

console.log('delegate-wiring-gate: проверено фич-функций: ' + checked +
  ', кандидатов вне allowlist: ' + defects.length);
for (const d of defects) console.log('  ✗ ' + d);
for (const s of stale) console.log('  ~ allowlist устарел: ' + s);
if (defects.length) {
  console.log('\nИсправление: фича обязана вызывать deps.set*/uiStore.set* (не только возвращать),');
  console.log('либо добавить в ALLOW с явной причиной «возвращаемое — НЕ состояние UI».');
  process.exit(1);
}
console.log('OK: дефектных делегатов нет');
