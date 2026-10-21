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
{
  const bridge = readFileSync(path.join(ROOT, 'src-tauri', 'src', 'vault_bridge.rs'), 'utf8');
  const m = bridge.match(/pub fn vault_build_envelope\(([^)]*)\)/);
  const got = m ? m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean) : [];
  const want = ['id', 'text', 'name', 'avatar', 'gavatar', 'key', 'pq_ek', 'tok', 'msg_type', 'ttl_secs', 'ts_ms'];
  ok('команда vault_build_envelope объявлена с теми же именами аргументов',
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
  ok('pq_ek передан', a.pq_ek === 'PQ', a);
  ok('tok передан', a.tok === 'TOK', a);
  ok('ttl_secs передан числом', a.ttl_secs === 3600, a);
  ok('ts_ms передан числом', a.ts_ms === 1700000000, a);
  ok('msg_type передан', a.msg_type === 'PQ-TYPE', a);
}
{
  reset();
  await R.buildEnvelope({ id: 'm2', text: 'x' });
  const a = lastArgs();
  ok('пустое необязательное поле → null (а не пустая строка)',
    a.gavatar === null && a.pq_ek === null && a.tok === null && a.msg_type === null, a);
  ok('пустой текст → пустая строка', a.text === 'x' && a.name === '' && a.avatar === '', a);
  ok('ttl без значения → 0', a.ttl_secs === 0, a);
}
{
  reset();
  await R.buildEnvelope({ id: 'm3', text: 'x', ttlSecs: 'не число' });
  ok('не-числовой ttl → 0 (не NaN)', lastArgs().ttl_secs === 0, lastArgs());
}
{
  // ПУСТАЯ строка в необязательном поле — это «поля нет», а не «поле с пустым
  // значением»: иначе в конверт попадёт gavatar:"" (получатель перезапишет
  // аватар группы пустым).
  reset();
  await R.buildEnvelope({ id: 'm4', text: 'x', gavatar: '', pqEk: '', tok: '' });
  const a = lastArgs();
  ok('пустая строка в необязательном поле → null (поля нет)',
    a.gavatar === null && a.pq_ek === null && a.tok === null && a.msg_type === null, a);
}

// ── Ответ моста доезжает до вызывающего ──────────────────────────────────
{
  reset();
  state.answer = '{"vault":1,"id":"m1"}';
  ok('собранный конверт доезжает до вызывающего',
    (await R.buildEnvelope({ id: 'm1', text: 'x' })) === '{"vault":1,"id":"m1"}');
}

// ── Отказ моста → null (не отправляем письмо без конверта) ───────────────
{
  reset();
  state.fail = true;
  const out = await R.buildEnvelope({ id: 'm1', text: 'x' });
  ok('при отказе моста → null (письмо без конверта не отправляем)', out === null, out);
  ok('при отказе моста вызов всё равно состоял (ошибка не бросается наружу)', true);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
