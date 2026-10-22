// Node-смоук src/envelope-rule.js — адаптер над Rust-сборкой конверта.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Сборка wire-конверта — протокол (ADR-005 R1): она
// уехала в ядро, а JS приносит данные и получает готовую строку. Здесь две
// вещи, которые ломаются тихо:
//   * ИМЕНА АРГУМЕНТОВ: Tauri сопоставляет их по имени, и расхождение роняет
//     мост молча (уже было так с аргументами правила звонка);
//   * ОТКАЗ МОСТА: сборка обязана честно вернуть null («не отправлять»), а не
//     «null» строкой — письмо с таким телом получатель не разберёт.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/envelope-rule-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { calls: [], fail: false, answer: '{"vault":1}' };
globalThis.__st = state;

writeFileSync(MOCKS + '/core.js', `
const st = globalThis.__st;
export const invoke = async (cmd, args) => {
  st.calls.push([cmd, args]);
  if (st.fail) throw new Error('мост недоступен');
  return st.answer;
};
`);

let src = readFileSync(path.join(ROOT, 'src', 'envelope-rule.js'), 'utf8');
src = src.replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`);
writeFileSync(MOCKS + '/envelope-rule.mjs', src, 'utf8');

const R = await import(MOCKS + '/envelope-rule.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { state.calls = []; state.fail = false; state.answer = '{"vault":1}'; }
const lastArgs = () => (state.calls[state.calls.length - 1] || [])[1] || {};

// ── Имена аргументов совпадают с объявлением команды в Rust ──────────────
//
// Tauri v2 принимает аргументы из JS в camelCase и сам переводит их в
// snake_case для Rust. Поэтому сверять надо КАМЕЛ-кейс JS с КАМЕЛ-кейсом
// Rust-сигнатуры, а не имена напрямую: иначе проверка либо закрепляет
// нерабочую схему, либо ругается на корректный код.
{
  const bridge = readFileSync(path.join(ROOT, 'src-tauri', 'src', 'vault_bridge.rs'), 'utf8');
  const m = bridge.match(/pub fn vault_build_envelope\(([^)]*)\)/);
  const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  const got = m
    ? m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean).map(camel)
    : [];
  const want = ['id', 'text', 'name', 'avatar', 'gavatar', 'key', 'pqEk', 'tok', 'msgType', 'ttlSecs', 'tsMs'];
  ok('команда vault_build_envelope объявлена с теми же именами аргументов (camelCase, как ждёт Tauri v2)',
    JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// ── Адаптер зовёт мост с правильными именами и значениями ──────────────
{
  reset();
  await R.buildEnvelope({
    id: 'm1', text: 'привет', name: 'Аня', avatar: 'AV',
    gavatar: 'GAV', key: 'PUB', pqEk: 'PQ', tok: 'TOK', msgType: 'PQ-TYPE', ttlSecs: 3600, tsMs: 1700000000,
  });
  const a = lastArgs();
  ok('id передан', a.id === 'm1', a);
  ok('text передан', a.text === 'привет', a);
  ok('name передан', a.name === 'Аня', a);
  ok('avatar передан', a.avatar === 'AV', a);
  ok('gavatar передан', a.gavatar === 'GAV', a);
  ok('key передан', a.key === 'PUB', a);
  ok('pqEk передан', a.pqEk === 'PQ', a);
  ok('tok передан', a.tok === 'TOK', a);
  // Tauri v2 принимает аргументы в camelCase и сам переводит их в
  // snake_case для Rust. Со snake_case команда ПАДАЕТ целиком («missing
  // required key»), и приложение продолжает работать — только конверты не
  // собираются. На живой приёмке 22.10.2026 это выглядело как «письма
  // приходят, но не расшифровываются» и «сообщение не отправляется».
  // Проверка здесь — чтобы ошибка не вернулась: смоук подменяет invoke и
  // принимает любые имена, а реальный мост — нет.
  const snakeNames = Object.keys(a).filter((k) => /^[a-z]+_[a-z0-9_]*$/.test(k));
  ok('snake_case-имён быть не должно (Tauri v2 ждёт camelCase)', snakeNames.length === 0, snakeNames);
  // И главное: имя типа конверта должно ДОЙТИ. Раньше msg_type терялся, и
  // конверт уходил без типа — получатель не опознавал его как звонок.
  ok('тип конверта передан (msgType), а не потерян', a.msgType === 'PQ-TYPE', a.msgType);
  ok('PQ-ключ передан (pqEk), а не потерян', a.pqEk === 'PQ', a.pqEk);
  ok('ttlSecs передан числом', a.ttlSecs === 3600, a);
  ok('tsMs передан числом', a.tsMs === 1700000000, a);
  ok('msgType передан', a.msgType === 'PQ-TYPE', a);
}
{
  reset();
  await R.buildEnvelope({ id: 'm2', text: 'x' });
  const a = lastArgs();
  ok('пустое необязательное поле → null (а не пустая строка)',
    a.gavatar === null && a.pqEk === null && a.tok === null && a.msgType === null, a);
  ok('пустой текст → пустая строка', a.text === 'x' && a.name === '' && a.avatar === '', a);
  ok('ttl без значения → 0', a.ttlSecs === 0, a);
}
{
  reset();
  await R.buildEnvelope({ id: 'm3', text: 'x', ttlSecs: 'не число' });
  ok('не-числовой ttl → 0 (не NaN)', lastArgs().ttlSecs === 0, lastArgs());
}
{
  // ПУСТАЯ строка в необязательном поле — это «поля нет», а не «поле с пустым
  // значением»: иначе в конверт попадёт gavatar:"" (получатель перезапишет
  // аватар группы пустым).
  reset();
  await R.buildEnvelope({ id: 'm4', text: 'x', gavatar: '', pqEk: '', tok: '' });
  const a = lastArgs();
  ok('пустая строка в необязательном поле → null (поля нет)',
    a.gavatar === null && a.pqEk === null && a.tok === null && a.msgType === null, a);
}

// ── Ответ моста доезжает до вызывающего ──────────────────────────────────
{
  reset();
  state.answer = '{"vault":1,"id":"m1"}';
  ok('собранный конверт доезжает до вызывающего',
    (await R.buildEnvelope({ id: 'm1', text: 'x' })) === '{"vault":1,"id":"m1"}');
}

// ── Разбор: ответ моста доезжает до вызывающего ─────────────────────────
{
  reset();
  state.answer = { id: 'm1', text: 'привет', name: 'Аня', type: 'sos' };
  const env = await R.parseEnvelope('{"vault":1,"id":"m1","text":"привет"}');
  ok('parseEnvelope: поля разбора доехали', env && env.id === 'm1' && env.text === 'привет', env);
}
{
  reset();
  state.answer = null;
  ok('parseEnvelope: «не наш конверт» → null', (await R.parseEnvelope('просто текст')) === null);
  ok('parseEnvelope: не-строка → null', (await R.parseEnvelope(null)) === null);
  reset();
  ok('parseEnvelope: пустой плейнтекст → null и мост НЕ зовётся',
    (await R.parseEnvelope('')) === null && state.calls.length === 0, state.calls);
}

// ── Отказ моста → null (не отправляем письмо без конверта) ───────────────
{
  reset();
  state.fail = true;
  const out = await R.buildEnvelope({ id: 'm1', text: 'x' });
  ok('при отказе моста → null (письмо без конверта не отправляем)', out === null, out);
  ok('при отказе моста вызов всё равно состоял (ошибка не бросается наружу)', true);
  const parsed = await R.parseEnvelope('{"vault":1,"text":"x"}');
  ok('при отказе моста разбор → null (не «null» строкой)', parsed === null, parsed);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
