// Node-смоук src/message-store.js — настройки чата в kv.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Модуль читает из kv три вещи, которые видно
// пользователю: закреплённое сообщение, качество медиа и TTL исчезающих
// сообщений. В существующих смоуках он ЗАМОКАН (проверяют фичи, а не модуль),
// то есть сам модуль не покрыт вообще. Три правила:
//   * всё fail-open: сбой чтения kv не должен ломать отрисовку сообщений —
//     возвращается значение по умолчанию;
//   * отсутствие значения ≠ значение по умолчанию: незакреплённое = null
//     (не пустой объект — иначе «закреплено» рисуется всегда);
//   * TTL приходит числом, и не-число = 0 (нет исчезания).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/message-store-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { kv: {}, failGet: false };
globalThis.__st = state;

writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
export const db = {
  kvGet: async (ns, key) => {
    if (st.failGet) throw new Error('kv недоступен');
    const v = st.kv[ns + '|' + key];
    return v === undefined ? null : v;
  },
};
`);

let src = readFileSync(path.join(ROOT, 'src', 'message-store.js'), 'utf8');
src = src.replace("from './api.js'", `from "${MOCKS}/api.js"`);
writeFileSync(MOCKS + '/message-store.mjs', src, 'utf8');

const M = await import(MOCKS + '/message-store.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { state.kv = {}; state.failGet = false; }

// ── Закреплённое сообщение ──────────────────────────────────────────────
{
  reset();
  ok('без закреплённого → null (не объект)', (await M.readPinned('g1')) === null, await M.readPinned('g1'));
  state.kv['anon|pinned:g1'] = JSON.stringify({ id: 'm1', text: 'закреплено' });
  const p = await M.readPinned('g1');
  ok('закреплённое читается', p && p.id === 'm1' && p.text === 'закреплено', p);
  state.kv['anon|pinned:g2'] = JSON.stringify({ id: 'm2' });
  const p2 = await M.readPinned('g2');
  ok('у другого чата — своё закреплённое', p2 && p2.id === 'm2', p2);
  state.failGet = true;
  // try/catch: «исключение наружу» должно ловиться утверждением, а не
  // падением смоука (гейт засчитывает падение, но оно ничего не доказывает).
  let readThrew = null, readVal;
  try { readVal = await M.readPinned('g1'); } catch (e) { readThrew = e; }
  ok('сбой kv → null (fail-open, отрисовка не ломается)', readThrew === null && readVal === null, { readVal, threw: String(readThrew) });
  state.failGet = false;
  state.kv['anon|pinned:g3'] = '{битый json';
  readThrew = null;
  try { readVal = await M.readPinned('g3'); } catch (e) { readThrew = e; }
  ok('битый JSON → null (не исключение)', readThrew === null && readVal === null, { readVal, threw: String(readThrew) });
}

// ── Качество медиа ───────────────────────────────────────────────────────
{
  reset();
  ok('по умолчанию — high', (await M.mediaQuality()) === 'high');
  state.kv['anon|media-quality'] = 'original';
  ok('сохранённое значение читается', (await M.mediaQuality()) === 'original');
  state.failGet = true;
  let qThrew = null, qVal;
  try { qVal = await M.mediaQuality(); } catch (e) { qThrew = e; }
  ok('сбой kv → high (fail-open)', qThrew === null && qVal === 'high', { qVal, threw: String(qThrew) });
  state.failGet = false;
}

// ── TTL исчезающих сообщений ────────────────────────────────────────────
{
  reset();
  ok('нет TTL → 0 (сообщение не исчезает)', (await M.ephemeralTtlOf('c1')) === 0);
  state.kv['anon|ephemeral:c1'] = '3600';
  ok('TTL читается числом', (await M.ephemeralTtlOf('c1')) === 3600);
  state.kv['anon|ephemeral:c2'] = 'не число';
  ok('не-числовой TTL → 0', (await M.ephemeralTtlOf('c2')) === 0);
  state.kv['anon|ephemeral:c3'] = '0';
  ok('нулевой TTL → 0', (await M.ephemeralTtlOf('c3')) === 0);
  state.failGet = true;
  ok('сбой kv → 0 (fail-open)', (await M.ephemeralTtlOf('c1')) === 0);
  state.failGet = false;
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
