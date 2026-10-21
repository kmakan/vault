// Node-смоук features/local-store.js — курсоры и отметки «прочитано».
//
// Две вещи, которые App.vue держал у себя и которые легко сломать тихо:
//   * курсоры синхронизации — если они не сохранились, письма с начала
//     перечитываются заново (и приходят дважды), а если сохранились не те —
//     синхронизация встаёт;
//   * отметки «прочитано», которые мы ОТПРАВИЛИ (localStorage) — если ключ
//     не разделён по аккаунтам, отметки одного адреса уезжают другому и
//     собеседник получает «прочитано» за чужое письмо.
//
// Проверяем формат хранения, разделение по аккаунтам и устойчивость к битым
// данным (битый JSON в localStorage не должен ронять чтение).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/local-store-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/local-store.js',
  MOCKS + '/local-store.mjs',
  {},
  MOCKS,
);
const L = await import(MOCKS + '/local-store.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Подделка localStorage: пишет в Map, помнит ключи.
function makeStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

function makeDeps(over = {}) {
  const storage = makeStorage();
  let cache = null;
  return {
    email: 'me@x.ru',
    getCursors: () => cache,
    setCursors: (c) => { cache = c; },
    db: { cursorsSave: (...a) => { globalThis.__cursorsSaved = a; } },
    storage,
    ...over,
  };
}

globalThis.__cursorsSaved = null;

// ── Ключ отметок «прочитано» ───────────────────────────────────────────
{
  const deps = makeDeps();
  check('ключ отметок — на аккаунт',
    L.readsSentStorageKey(deps) === 'vault-reads-sent-me@x.ru', L.readsSentStorageKey(deps));
  const anon = makeDeps({ email: '' });
  check('без адреса ключ не ломается', anon && L.readsSentStorageKey(anon) === 'vault-reads-sent-anon');
}

// ── Курсоры ────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  check('без кэша курсоры — пустой объект', JSON.stringify(L.loadCursors(deps, 'acc')) === '{}');
}
{
  const deps = makeDeps();
  L.saveCursors(deps, 'acc', { inbox: 'uid-1' });
  check('курсоры сохранены в кэш', deps.getCursors().inbox === 'uid-1', deps.getCursors());
  check('курсоры записаны в sqlite',
    globalThis.__cursorsSaved && globalThis.__cursorsSaved[0] === 'acc' && globalThis.__cursorsSaved[1] === '{"inbox":"uid-1"}',
    globalThis.__cursorsSaved);
  check('прочитанные курсоры = сохранённые', L.loadCursors(deps, 'acc').inbox === 'uid-1');
}
{
  const deps = makeDeps();
  globalThis.__cursorsSaved = null;
  L.saveCursors(deps, 'acc', {});
  check('пустые курсоры не пишутся (и не затирают сохранённые)',
    globalThis.__cursorsSaved === null && deps.getCursors() === null, globalThis.__cursorsSaved);
}
{
  const deps = makeDeps();
  deps.db = { cursorsSave: () => { throw new Error('sqlite недоступен'); } };
  let threw = false;
  try { L.saveCursors(deps, 'acc', { a: 1 }); } catch (e) { threw = true; }
  check('ошибка sqlite не пробрасывается наружу (молчаливый отказ лучше падения)',
    threw === false, threw);
}

// ── Отметки «прочитано» ────────────────────────────────────────────────
{
  const deps = makeDeps();
  check('без записанных отметок — пустой объект',
    JSON.stringify(L.loadSentReads(deps)) === '{}');
  L.saveSentReads(deps, { 'msg-1': 1700000000 });
  check('отметки записаны в localStorage',
    deps.storage.getItem('vault-reads-sent-me@x.ru') === '{"msg-1":1700000000}',
    deps.storage.getItem('vault-reads-sent-me@x.ru'));
  check('отметки прочитаны обратно', L.loadSentReads(deps)['msg-1'] === 1700000000);
}
{
  const deps = makeDeps();
  deps.storage.setItem('vault-reads-sent-me@x.ru', '{бито');
  check('битые отметки → пустой объект, без исключения',
    JSON.stringify(L.loadSentReads(deps)) === '{}', L.loadSentReads(deps));
}
{
  const deps = makeDeps();
  L.saveSentReads(deps, { x: 1 });
  const other = makeDeps({ email: 'other@x.ru' });
  check('у другого аккаунта — свои отметки (не чужие)',
    JSON.stringify(L.loadSentReads(other)) === '{}', L.loadSentReads(other));
}
{
  const deps = makeDeps({ storage: null });
  check('без localStorage чтение → пустой объект', JSON.stringify(L.loadSentReads(deps)) === '{}');
  let threw = false;
  try { L.saveSentReads(deps, { x: 1 }); } catch (e) { threw = true; }
  check('без localStorage запись — тихий no-op', threw === false, threw);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
