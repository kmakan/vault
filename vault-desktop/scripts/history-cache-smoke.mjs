// Node-смоук src/history.js — локальная история чатов в SQLite.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Модуль пишет расшифрованные сообщения в SQLite
// (db_history_save/load) — это «почтовый мессенджер хранит историю в базе».
// В существующих смоуках он ЗАМОКАН (проверяют фичи), то есть сам модуль не
// покрыт. А потеря истории — это потеря переписки.
//
// ТРИ ПРАВИЛА:
//   * account — это NAMESPACE (fp:<fingerprint>), а не емейл: резолвер
//     подставляется перед записью, иначе данные лягут не туда;
//   * загрузка отдаёт null (а не []) при отсутствии или битых данных —
//     «нет истории» и «история сломана» должны различаться;
//   * всё fail-open: сбой БД не должен ломать открытие чата.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/history-cache-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { saved: [], loaded: null, fail: false, nsCalls: [] };
globalThis.__st = state;

writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
export const db = {
  historySave: async (ns, chatKey, json) => {
    if (st.fail) throw new Error('БД недоступна');
    st.saved.push({ ns, chatKey, json });
  },
  historyLoad: async (ns, chatKey) => {
    if (st.fail) throw new Error('БД недоступна');
    return st.loaded;
  },
};
`);
writeFileSync(MOCKS + '/identity.js', `
const st = globalThis.__st;
export const accountNamespace = async (e) => { st.nsCalls.push(e); return 'fp:' + String(e || '').toLowerCase(); };
`);

let src = readFileSync(path.join(ROOT, 'src', 'history.js'), 'utf8');
src = src.replace("from './api.js'", `from "${MOCKS}/api.js"`)
         .replace("from './identity.js'", `from "${MOCKS}/identity.js"`);
writeFileSync(MOCKS + '/history.mjs', src, 'utf8');

const H = await import(MOCKS + '/history.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { state.saved = []; state.loaded = null; state.fail = false; state.nsCalls = []; }

// ── Сохранение ──────────────────────────────────────────────────────────
{
  reset();
  await H.saveHistory('a@b.c', 'peer@x', [{ id: 'm1', text: 'привет' }]);
  ok('история сохранена', state.saved.length === 1 && state.saved[0].chatKey === 'peer@x', state.saved);
  ok('сохранено под NAMESPACE, а не под емейлом',
    state.saved[0].ns === 'fp:a@b.c', state.saved[0].ns);
  ok('резолвер namespace вызван', state.nsCalls.length === 1, state.nsCalls);
  ok('сообщения сериализованы в JSON',
    JSON.parse(state.saved[0].json)[0].text === 'привет', state.saved[0].json);
}
{
  reset();
  await H.saveHistory('', 'peer@x', [{ id: 'm1' }]);
  ok('без account ничего не пишется', state.saved.length === 0, state.saved);
  await H.saveHistory('a@b.c', '', [{ id: 'm1' }]);
  ok('без chatKey ничего не пишется', state.saved.length === 0, state.saved);
  await H.saveHistory('a@b.c', 'peer@x', 'не массив');
  ok('не-массив сообщений не пишется', state.saved.length === 0, state.saved);
}
{
  reset();
  state.fail = true;
  await H.saveHistory('a@b.c', 'peer@x', [{ id: 'm1' }]);
  ok('сбой БД при сохранении не ломает вызов (fail-open)', true);
}

// ── Загрузка ────────────────────────────────────────────────────────────
{
  reset();
  state.loaded = JSON.stringify([{ id: 'm1', text: 'привет' }]);
  const h = await H.loadHistory('a@b.c', 'peer@x');
  ok('история загружена', Array.isArray(h) && h[0].text === 'привет', h);
  ok('загрузка идёт из namespace', state.nsCalls.length === 1 && state.nsCalls[0] === 'a@b.c', state.nsCalls);
}
{
  reset();
  ok('нет истории → null (не [])', (await H.loadHistory('a@b.c', 'peer@x')) === null);
  state.loaded = 'не json';
  ok('битые данные → null (не исключение)', (await H.loadHistory('a@b.c', 'peer@x')) === null);
  state.loaded = JSON.stringify({ не: 'массив' });
  ok('не-массив → null', (await H.loadHistory('a@b.c', 'peer@x')) === null);
}
{
  reset();
  ok('без account → null', (await H.loadHistory('', 'peer@x')) === null);
  ok('без chatKey → null', (await H.loadHistory('a@b.c', '')) === null);
}
{
  reset();
  state.fail = true;
  ok('сбой БД при загрузке → null (fail-open)', (await H.loadHistory('a@b.c', 'peer@x')) === null);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
