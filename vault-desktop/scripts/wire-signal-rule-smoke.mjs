// Node-смоук src/wire-signal-rule.js — адаптер над сервисными wire-форматами.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Сервисные форматы (сигнал звонка, data-письмо,
// объект конверта) уехали в Rust (ADR-005 R1 / W4), JS остался транспортом.
// Здесь ломается тихо:
//   * ИМЕНА АРГУМЕНТОВ: Tauri сопоставляет их по имени, и расхождение роняет
//     мост молча (уже было так с аргументами правила звонка);
//   * ЗАЩИТА ОТ ПУСТОГО ВХОДА: пустой плейнтекст не должен дёргать мост;
//   * ОТКАЗ МОСТА: обязан честно вернуть null, а не «null» строкой — иначе
//     получатель примет мусор за конверт.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/wire-signal-rule-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { calls: [], fail: false, answer: null };
globalThis.__st = state;

writeFileSync(MOCKS + '/core.js', `
const st = globalThis.__st;
export const invoke = async (cmd, args) => {
  st.calls.push([cmd, args]);
  if (st.fail) throw new Error('мост недоступен');
  return st.answer;
};
`);

const src = readFileSync(path.join(ROOT, 'src', 'wire-signal-rule.js'), 'utf8');
writeFileSync(MOCKS + '/wire-signal-rule.mjs', src.replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`), 'utf8');

const R = await import(MOCKS + '/wire-signal-rule.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { state.calls = []; state.fail = false; state.answer = null; }
const lastCall = () => state.calls[state.calls.length - 1] || [];
const cmdOf = () => lastCall()[0];
const argsOf = () => lastCall()[1] || {};

// ── Имена команд совпадают с мостом ────────────────────────────────────
{
  const bridge = readFileSync(path.join(ROOT, 'src-tauri', 'src', 'vault_bridge.rs'), 'utf8');
  const lib = readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const cmd of ['vault_parse_dod_data', 'vault_build_dod_data', 'vault_envelope_object']) {
    ok(`команда ${cmd} объявлена в мосте`, bridge.includes(`pub fn ${cmd}(`), cmd);
  }
  // call_parse_signal живёт в lib.rs (медиа-мост звонков), а не в vault_bridge.rs.
  ok('команда call_parse_signal объявлена и зарегистрирована',
    lib.includes('fn call_parse_signal(') && lib.includes('call_parse_signal,'), 'lib.rs');
}

// ── Сигнал звонка ───────────────────────────────────────────────────────
{
  reset();
  state.answer = { id: 'c1', type: 'call_request', call_id: 'c1', ts: 5 };
  const sig = await R.parseCallSignal('{"vault":1,"type":"call_request","call_id":"c1"}');
  ok('parseCallSignal зовёт call_parse_signal', cmdOf() === 'call_parse_signal', lastCall());
  ok('parseCallSignal передаёт плейнтекст', argsOf().decrypted === '{"vault":1,"type":"call_request","call_id":"c1"}', argsOf());
  ok('parseCallSignal возвращает разобранный сигнал', sig && sig.call_id === 'c1', sig);
}
{
  reset();
  ok('parseCallSignal: пустой вход → null и мост НЕ зовётся',
    (await R.parseCallSignal('')) === null && state.calls.length === 0, state.calls);
  ok('parseCallSignal: не-строка → null', (await R.parseCallSignal(null)) === null);
}
{
  reset();
  state.fail = true;
  ok('parseCallSignal: отказ моста → null (не «null» строкой)',
    (await R.parseCallSignal('{"vault":1}')) === null);
}

// ── Роутер сервисных сигналов ───────────────────────────────────────────
{
  reset();
  state.answer = { kind: 'reaction', msg_id: 'm1', emoji: 'x', action: 'add' };
  const sig = await R.parseSignal('{"react":1,"msg_id":"m1","emoji":"x"}');
  ok('parseSignal зовёт vault_parse_signal', cmdOf() === 'vault_parse_signal', lastCall());
  ok('parseSignal передаёт плейнтекст', argsOf().plain === '{"react":1,"msg_id":"m1","emoji":"x"}', argsOf());
  ok('parseSignal возвращает разобранный сигнал', sig && sig.kind === 'reaction', sig);
}
{
  reset();
  ok('parseSignal: пустой вход → null и мост НЕ зовётся',
    (await R.parseSignal('')) === null && state.calls.length === 0, state.calls);
  ok('parseSignal: не-строка → null', (await R.parseSignal(null)) === null);
}
{
  reset();
  state.fail = true;
  ok('parseSignal: отказ моста → null (не «null» строкой)',
    (await R.parseSignal('{"react":1,"msg_id":"m1","emoji":"x"}')) === null);
}

// ── Data-письмо ─────────────────────────────────────────────────────────
{
  reset();
  state.answer = { ref: 'd@x', data: 'BASE64' };
  const dod = await R.parseDodData('{"vault_dod_data":1,"ref":"d@x","data":"BASE64"}');
  ok('parseDodData зовёт vault_parse_dod_data', cmdOf() === 'vault_parse_dod_data', lastCall());
  ok('parseDodData передаёт плейнтекст', argsOf().plain === '{"vault_dod_data":1,"ref":"d@x","data":"BASE64"}', argsOf());
  ok('parseDodData возвращает ref/data', dod && dod.ref === 'd@x' && dod.data === 'BASE64', dod);
}
{
  reset();
  ok('parseDodData: пустой вход → null и мост НЕ зовётся',
    (await R.parseDodData('')) === null && state.calls.length === 0, state.calls);
}
{
  reset();
  state.answer = '{"vault_dod_data":1,"ref":"d@x","data":"B"}';
  const payload = await R.buildDodData('d@x', 'B');
  ok('buildDodData зовёт vault_build_dod_data', cmdOf() === 'vault_build_dod_data', lastCall());
  ok('buildDodData передаёт reference и data', argsOf().reference === 'd@x' && argsOf().data === 'B', argsOf());
  ok('buildDodData возвращает собранное письмо', payload === '{"vault_dod_data":1,"ref":"d@x","data":"B"}', payload);
}
{
  reset();
  const payload = await R.buildDodData(null, undefined);
  ok('buildDodData: пустые значения → пустые строки (не undefined)',
    argsOf().reference === '' && argsOf().data === '', argsOf());
}
{
  reset();
  state.fail = true;
  ok('buildDodData: отказ моста → null', (await R.buildDodData('r', 'd')) === null);
}
{
  reset();
  state.fail = true;
  ok('parseDodData: отказ моста → null (не «null» строкой)',
    (await R.parseDodData('{"vault_dod_data":1,"data":"B"}')) === null);
}

// ── Объект конверта ─────────────────────────────────────────────────────
{
  reset();
  state.answer = { vault: 1, id: 'm1' };
  const obj = await R.envelopeObject('{"vault":1,"id":"m1"}');
  ok('envelopeObject зовёт vault_envelope_object', cmdOf() === 'vault_envelope_object', lastCall());
  ok('envelopeObject передаёт текст конверта', argsOf().text === '{"vault":1,"id":"m1"}', argsOf());
  ok('envelopeObject возвращает объект', obj && obj.id === 'm1', obj);
}
{
  reset();
  ok('envelopeObject: пустой вход → null и мост НЕ зовётся',
    (await R.envelopeObject('')) === null && state.calls.length === 0, state.calls);
}
{
  reset();
  state.fail = true;
  ok('envelopeObject: отказ моста → null', (await R.envelopeObject('{"vault":1}')) === null);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
