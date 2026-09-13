// Node-смоук features/history.js — семантика кэшей/истории/оптимистичных
// исходящих без Vue/Tauri (паттерн incoming-smoke.mjs).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;

// ── Заглушки импортов history.js ──────────────────────────────
const MOCKS = '/tmp/history-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api-мок: db (kv/kvGet/kvSet/bodyCache*/history_* идут через history.js-мок)
const apiMock = {
  bodyRows: [],
  kvStore: new Map(),
  bodyCacheLoadAll: async (acc) => apiMock.bodyRows,
  bodyCacheSet: async (acc, k, body) => { apiMock.bodyRows.push([k, body]); },
  kvGet: async (acc, k) => (apiMock.kvStore.has(k) ? apiMock.kvStore.get(k) : null),
  kvSet: async (acc, k, v) => { apiMock.kvStore.set(k, v); },
};

// history.js-мок (низкоуровневый sqlite-модуль): in-memory
const histMock = {
  store: {},
  saveHistory: (account, chatKey, messages) => { histMock.store[chatKey] = JSON.parse(JSON.stringify(messages)); },
  loadHistory: async (account, chatKey) => histMock.store[chatKey] ? JSON.parse(JSON.stringify(histMock.store[chatKey])) : null,
};

// edits-фичи для ctx-моков (filterDeleted/isTombstoned) — реальные из edits.js не нужны,
// history.js зовёт их через ctx: мокаем по контракту.
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/history.js', 'export const saveHistory = (a, c, m) => globalThis.__histMock.saveHistory(a, c, m); export const loadHistory = (a, c) => globalThis.__histMock.loadHistory(a, c);');
globalThis.__apiMock = apiMock;
globalThis.__dbMock = apiMock;
globalThis.__histMock = histMock;

// Подменяем резолвер history-импортов: копия с переписанными путями
let src = readFileSync(ROOT + '/../src/features/history.js', 'utf8');
src = src
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../history.js'", 'from "' + MOCKS + '/history.js"');
writeFileSync(MOCKS + '/features-history.mjs', src);
const H = await import(MOCKS + '/features-history.mjs');

// ── Хелперы ───────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    email: 'me@x.ru',
    emailBodyCache: {},
    bodyCacheOrder: [],
    bodyCacheSaveTimer: null,
    pendingOutgoing: {},
    messages: [],
    // контракты edits-домена (моки)
    isTombstoned: (id) => tombstones.has(id),
    filterDeleted: (list) => (list || []).filter(m => m && !m.deleted && !tombstones.has(m.id)),
    // msgTs — реальный H.msgTs (совпадает с контрактом App)
    msgTs: H.msgTs,
  }, over);
}
const tombstones = new Set();

// ── 1. Ключи ──────────────────────────────────────────────────
console.log('1. Ключи');
{
  const ctx = makeCtx();
  check('bodyCacheKey', H.bodyCacheKey(ctx) === 'vault-body-cache:me@x.ru');
  check('chatCacheKey', H.chatCacheKey(ctx, 'peer@x.ru') === 'vault-chat-cache:me@x.ru:peer@x.ru');
}

// ── 2. Body-cache ─────────────────────────────────────────────
console.log('2. Body-cache (FIFO 400 + debounce)');
{
  const ctx = makeCtx();
  H.cacheBody(ctx, 'k1', 'body1');
  H.cacheBody(ctx, 'k2', 'body2');
  check('cacheBody пишет в память', ctx.emailBodyCache.k1 === 'body1' && ctx.emailBodyCache.k2 === 'body2');
  check('bodyCacheOrder порядок', ctx.bodyCacheOrder.join(',') === 'k1,k2');
  H.cacheBody(ctx, 'k1', 'body1-new'); // обновление — в конец
  check('повторная запись поднимает в конец FIFO', ctx.bodyCacheOrder.join(',') === 'k2,k1');
  check('debounce-таймер выставлен', ctx.bodyCacheSaveTimer !== null);
  // FIFO 400: 399 → +2 → старейший вытеснен
  const ctx2 = makeCtx();
  for (let i = 0; i < 399; i++) H.cacheBody(ctx2, 'k' + i, 'b' + i);
  H.cacheBody(ctx2, 'x1', 'v1');
  H.cacheBody(ctx2, 'x2', 'v2');
  check('FIFO: лимит 400 вытесняет старейшее', ctx2.bodyCacheOrder.length === 400 && !('k0' in ctx2.emailBodyCache) && ctx2.emailBodyCache.x2 === 'v2');
  // persistBodyCache: sqlite-мок получает все ключи
  apiMock.bodyRows.length = 0;
  H.persistBodyCache(ctx2);
  check('persistBodyCache пишет все тела в sqlite', apiMock.bodyRows.length === 400);
  // loadBodyCache: восстановление
  const ctx3 = makeCtx();
  await H.loadBodyCache(ctx3);
  check('loadBodyCache восстанавливает кэш', ctx3.emailBodyCache.x2 === 'v2' && ctx3.bodyCacheOrder.length === 400);
  // сбой sqlite → пустой кэш, не бросается
  const origLoad = apiMock.bodyCacheLoadAll;
  apiMock.bodyCacheLoadAll = async () => { throw new Error('sqlite down'); };
  const ctx4 = makeCtx();
  await H.loadBodyCache(ctx4);
  check('сбой sqlite → тихий пустой кэш', Object.keys(ctx4.emailBodyCache).length === 0 && ctx4.bodyCacheOrder.length === 0);
  apiMock.bodyCacheLoadAll = origLoad;
}

// ── 3. Chat-cache ─────────────────────────────────────────────
console.log('3. Chat-cache (слайм в kv)');
{
  const ctx = makeCtx();
  const list = [
    { id: 'm1', content: 'hi', from: 'me', time: '12:00', encrypted: false, vault: true, status: 'sent', ts: 1000, attachment: { name: 'f.bin' }, callEvent: 'missed', sender_id: 'me@x.ru', reactions: [{ emoji: '👍' }] },
    { id: 'm2', content: 'yo', from: 'them', time: '12:01', ts: 2000 },
  ];
  H.saveChatCache(ctx, 'peer@x.ru', list);
  await new Promise(r => setTimeout(r, 10));
  const cached = await H.loadChatCache(ctx, 'peer@x.ru');
  check('save/load roundtrip', cached && cached.length === 2 && cached[0].content === 'hi');
  check('слайм: attachment/callEvent/sender_id/reactions персистятся', cached[0].attachment && cached[0].callEvent === 'missed' && cached[0].sender_id === 'me@x.ru' && cached[0].reactions);
  check('слайм: email-объекта нет', !('email' in cached[0]) && !('email' in cached[1]));
  check('loadChatCache отсутствующего → null', (await H.loadChatCache(ctx, 'nope')) === null);
}

// ── 4. Оптимистичные исходящие ─────────────────────────────────
console.log('4. pendingOutgoing (markPending/mergePending)');
{
  const ctx = makeCtx();
  H.markPending(ctx, 'peer@x.ru', { id: 'p1', content: 'optimistic', from: 'me', ts: 100 });
  check('markPending регистрирует', ctx.pendingOutgoing['peer@x.ru'] && ctx.pendingOutgoing['peer@x.ru'].p1);
  H.markPending(ctx, 'peer@x.ru', null); // мусор — no-op
  check('markPending(null) no-op', Object.keys(ctx.pendingOutgoing['peer@x.ru']).length === 1);
  // mergePending: письмо пришло (p1 подтверждён) + p2 ещё в пути
  H.markPending(ctx, 'peer@x.ru', { id: 'p2', content: 'pending2', from: 'me', ts: 200 });
  const out = H.mergePending(ctx, 'peer@x.ru', [{ id: 'p1', content: 'real', from: 'me', ts: 100 }]);
  check('подтверждённое заменено реальным (p1 once)', out.filter(m => m.id === 'p1').length === 1 && out.find(m => m.id === 'p1').content === 'real');
  check('неподтверждённое p2 подмешано', out.some(m => m.id === 'p2'));
  check('реестр p1 очищен, p2 остался', ctx.pendingOutgoing['peer@x.ru'] && !!ctx.pendingOutgoing['peer@x.ru'].p2 && !ctx.pendingOutgoing['peer@x.ru'].p1);
  // 10-минутный TTL: старое pending не возвращается (но failed остаётся)
  const now = Date.now();
  const ctx2 = makeCtx();
  H.markPending(ctx2, 'c', { id: 'old', from: 'me', ts: 1, _pendingAt: now - 11 * 60 * 1000 });
  H.markPending(ctx2, 'c', { id: 'old-fail', from: 'me', ts: 2, _pendingAt: now - 11 * 60 * 1000, status: 'failed' });
  H.markPending(ctx2, 'c', { id: 'fresh', from: 'me', ts: 3, _pendingAt: now });
  const out2 = H.mergePending(ctx2, 'c', []);
  check('10-мин TTL выкидывает висяк, failed остаётся', !out2.some(m => m.id === 'old') && out2.some(m => m.id === 'old-fail') && out2.some(m => m.id === 'fresh'));
  // tombstone: удалённое из pending не воскресает
  const ctx3 = makeCtx();
  H.markPending(ctx3, 'c', { id: 'dead', from: 'me', ts: 1, _pendingAt: Date.now() });
  tombstones.add('dead');
  const out3 = H.mergePending(ctx3, 'c', []);
  check('tombstoned не возвращается из pending', !out3.some(m => m.id === 'dead'));
  tombstones.delete('dead');
  // сортировка по msgTs
  const ctx4 = makeCtx();
  H.markPending(ctx4, 'c', { id: 'z', from: 'me', ts: 300 });
  const out4 = H.mergePending(ctx4, 'c', [{ id: 'a', from: 'them', ts: 50 }]);
  check('merge сортирует по ts', out4[0].id === 'a' && out4[1].id === 'z');
}

// ── 5. История ─────────────────────────────────────────────────
console.log('5. История (loadLocalHistory/normalize/merge/showFirst/save)');
{
  // normalizeStaleSending: sending старше минуты → sent
  const ctx = makeCtx();
  const now = Date.now();
  const hist = [
    { id: 'h1', from: 'me', status: 'sending', ts: now - 2 * 60 * 1000 },
    { id: 'h2', from: 'me', status: 'sending', ts: now - 10 * 1000 },
    { id: 'h3', from: 'them', status: 'sending', ts: now - 5 * 60 * 1000 },
  ];
  H.normalizeStaleSending(ctx, hist);
  check('stale sending → sent (моё, >60с)', hist[0].status === 'sent' && hist[1].status === 'sending');
  check('чужие sending не трогаем', hist[2].status === 'sending');
  // loadLocalHistory: call_*-конверты отфильтрованы
  histMock.store = {};
  histMock.store['peer@x.ru'] = [
    { id: 'ok1', from: 'them', content: 'норм', ts: 1 },
    { id: 'bad1', from: 'them', content: '{"type":"call_offer"}', ts: 2 },
  ];
  const loaded = await H.loadLocalHistory(makeCtx(), 'peer@x.ru');
  check('loadLocalHistory фильтрует call_*-конверты', loaded.length === 1 && loaded[0].id === 'ok1');
  // loadLocalHistory: sqlite-сбой → null-путь не бросается
  histMock.loadHistory = async () => { throw new Error('db'); };
  const l2 = await H.loadLocalHistory(makeCtx(), 'x');
  check('сбой sqlite — тихо', l2 === null);
  histMock.loadHistory = async (a, c) => histMock.store[c] || null;
  // mergeHistory: письма добавляют только новое, хронология сохраняется
  histMock.store = {};
  histMock.store['peer@x.ru'] = [
    { id: 'a', from: 'them', content: 'первое', ts: 100 },
    { id: 'b', from: 'me', content: 'второе', ts: 200 },
  ];
  const mctx = makeCtx();
  const merged = await H.mergeHistory(mctx, 'peer@x.ru', [
    { id: 'b', from: 'me', content: 'второе', ts: 200 },   // дубль из письма
    { id: 'c', from: 'them', content: 'новое', ts: 300 },  // новое
  ]);
  check('merge: новое добавлено, дубль не задвоен', merged.length === 3 && merged.filter(m => m.id === 'b').length === 1);
  check('merge: сортировка по ts', merged.map(m => m.id).join(',') === 'a,b,c');
  // merge: пустая история → письма как есть
  const m2 = await H.mergeHistory(makeCtx(), 'empty-chat', [{ id: 'n1', ts: 5 }]);
  check('merge: пустая история → список писем', m2.length === 1 && m2[0].id === 'n1');
  // merge: filterDeleted применён (tombstone)
  tombstones.add('c');
  const m3 = await H.mergeHistory(makeCtx(), 'peer@x.ru', [{ id: 'c', from: 'them', content: 'x', ts: 300 }]);
  check('merge: tombstoned отфильтрован', !m3.some(m => m.id === 'c'));
  tombstones.delete('c');
  // merge: исчезающие — expireAt подтягивается из свежего письма
  histMock.store = {};
  histMock.store['peer@x.ru'] = [{ id: 'e1', from: 'them', content: 'исчезнёт', ts: 100 }];
  const m4 = await H.mergeHistory(makeCtx(), 'peer@x.ru', [{ id: 'e1', from: 'them', content: 'исчезнёт', ts: 100, ttl: 3600, expireAt: 999999 }]);
  check('merge: expireAt подтянут из письма', m4[0].expireAt === 999999 && m4[0].ttl === 3600);
  // showHistoryFirst: показывает историю (сортировка + фильтр call_/profile)
  histMock.store = {};
  histMock.store['peer@x.ru'] = [
    { id: 's2', from: 'me', content: 'два', ts: 200 },
    { id: 's1', from: 'them', content: 'один', ts: 100 },
    { id: 's3', from: 'them', content: '{"type":"profile"}', ts: 300 },
  ];
  const sctx = makeCtx();
  await H.showHistoryFirst(sctx, 'peer@x.ru', () => false);
  check('showHistoryFirst: отсортировано + call_/profile отфильтрованы', sctx.messages.map(m => m.id).join(',') === 's1,s2');
  // stale: не трогает messages
  const sctx2 = makeCtx();
  sctx2.messages = [{ id: 'keep' }];
  await H.showHistoryFirst(sctx2, 'peer@x.ru', () => true);
  check('showHistoryFirst: stale — messages не тронуты', sctx2.messages.length === 1 && sctx2.messages[0].id === 'keep');
  // saveCurrentHistory
  const wctx = makeCtx();
  wctx.messages = [{ id: 'w1', content: 'запись', ts: 1 }];
  H.saveCurrentHistory(wctx, 'peer@x.ru');
  await new Promise(r => setTimeout(r, 10));
  check('saveCurrentHistory пишет в sqlite-историю', histMock.store['peer@x.ru'] && histMock.store['peer@x.ru'][0].id === 'w1');
  // msgTs-фолбэки
  check('msgTs: ts → email.date → created_at → _pendingAt → 0',
    H.msgTs({ ts: 5 }) === 5 &&
    H.msgTs({ email: { date: '2026-01-01T00:00:00Z' } }) === 1767225600000 &&
    H.msgTs({ created_at: '2026-01-01T00:00:00Z' }) === 1767225600000 &&
    H.msgTs({ _pendingAt: 42 }) === 42 &&
    H.msgTs(null) === 0);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
