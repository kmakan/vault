// M0 C1 — контракт обмена payload: JS parseEnvelope ↔ Rust incoming::classify.
//
// Фикстура `vault-client/tests/fixtures/m0-wire-contract.json` — общая с
// Rust-тестом `vault-client/tests/m0_wire_contract.rs`. Одни и те же байты
// обязаны одинаково читаться обеими сторонами: расхождение ломает любой из
// двух гейтов.
//
// Правило «сколько объявлено — столько проверено»: число проверок считается
// ЗАРАНЕЕ по всей фикстуре, до выполнения, и в конце сверяется с числом
// выполненных. Пропущенный кейс, лишнее поле в фикстуре, выпавшая проверка →
// красный. (Прежний скрипт печатал «из 23», выполняя 16, и выходил с кодом 0;
// первая версия этого гейта считала «объявлено» внутри цикла, поэтому пропуск
// кейса уменьшал оба числа и оставался зелёным — самопроверка 19.10 это поймала.)
//
// Покрытие и границы — в docs/M0-WIRE-FORMAT-PARITY.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Разбор wire-конверта живёт в Rust (ADR-005 W4) → в node нужен мок моста
// (scripts/lib/wire-envelope-mock.mjs): правила — в ядре, здесь их двойник.
import { installEnvelopeMock } from './lib/wire-envelope-mock.mjs';
import { writeFileSync } from 'node:fs';
const _mocks = '/tmp/m0-wire-smoke-mocks';
await installEnvelopeMock(_mocks);
// message-format.js тянет адаптер — копия с мок-мостом. Импорт ДИНАМИЧЕСКИЙ:
// статический импорт поднялся бы ДО того, как файл записан.
writeFileSync(_mocks + '/message-format.js',
  readFileSync(new URL('../src/message-format.js', import.meta.url), 'utf8'));
const { parseEnvelope } = await import(_mocks + '/message-format.js');


const FIXTURE = '../../vault-client/tests/fixtures/m0-wire-contract.json';

function die(msg) {
  console.log('✗ ' + msg);
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(FIXTURE, import.meta.url)), 'utf8'));
const cases = fixture.cases;
if (!Array.isArray(cases) || cases.length === 0) die('фикстура без кейсов: ' + FIXTURE);

// ── Проход 1: сколько проверок объявлено (по всей фикстуре, до выполнения) ──
let declared = 0;
for (const c of cases) {
  if (typeof c.payload !== 'string' || !c.expect || !('js_parse_envelope' in c.expect)) {
    die(`[${c.name}] в фикстуре нет payload или expect.js_parse_envelope`);
  }
  const want = c.expect.js_parse_envelope;
  if (want === null) {
    declared += 1;
  } else if (typeof want === 'object' && Object.keys(want).length > 0) {
    declared += Object.keys(want).length;
  } else {
    die(`[${c.name}] ожидание js_parse_envelope пустое — кейс ничего не проверяет`);
  }
}

// ── Проход 2: выполнение ───────────────────────────────────────────────────
let checked = 0;
let failed = 0;

function ok(label, cond) {
  checked++;
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label);
  }
}

for (const c of cases) {
  console.log('\n' + c.name);
  const want = c.expect.js_parse_envelope;
  const env = await parseEnvelope(c.payload);

  if (want === null) {
    ok('не конверт-сообщение (parseEnvelope → null)', env === null);
    continue;
  }

  if (env === null) {
    checked += Object.keys(want).length; // объявленные проверки не выполнены
    failed++;
    console.log('  ✗ parseEnvelope вернул null, а конверт ожидался');
    continue;
  }
  for (const [key, value] of Object.entries(want)) {
    // env несёт все ключи конверта (пустые значения по умолчанию), поэтому
    // undefined тут означает расхождение схемы, а не «поля нет в фикстуре».
    ok(`${key} == ${JSON.stringify(value)}  (получено ${JSON.stringify(env[key])})`, env[key] === value);
  }
}

if (checked !== declared) {
  failed++;
  console.log(`\n✗ выполнено проверок ${checked}, объявлено ${declared} — проверка выпала`);
}
console.log(`\nM0 wire-contract (JS): ${checked}/${declared} проверок, провалов ${failed}`);
if (failed) process.exit(1);
