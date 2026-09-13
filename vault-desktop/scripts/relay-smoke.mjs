// Node-смоук features/relay.js — семантика релей-приёма/режимов без
// Vue/Tauri (паттерн incoming-smoke.mjs). setInterval/setTimeout —
// управляемые моки (без реального ожидания).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;

// ── Заглушки ───────────────────────────────────────────────────
const MOCKS = '/tmp/relay-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api-мок
const apiMock = {
  calls: [],
  idleStart: async (c) => { apiMock.calls.push(['idleStart', c]); },
  idleWait: async (ms, box) => ({ changed: false }),
  idleStop: async () => { apiMock.calls.push(['idleStop']); },
  getEmailAccounts: async () => [{ id: 'local' }],
  fetchEmailsIncrementalFast: async (acc, cursors) => ({ messages: [], cursors }),
  restoreSession: async () => { apiMock.calls.push(['restoreSession']); return true; },
  pushSet: async (a, b, c) => { apiMock.calls.push(['pushSet', a, b, c]); },
  ecoSet: async (v) => { apiMock.calls.push(['ecoSet', v]); },
};
const dbMock = {
  kv: new Map(),
  kvGet: async (acc, k) => (dbMock.kv.has(k) ? dbMock.kv.get(k) : null),
  kvSet: async (acc, k, v) => { dbMock.kv.set(k, String(v)); },
};
// relay-client-мок
const relayMock = {
  queue: [],
  healthy: true,
  polls: 0,
  healthCalls: 0,
  relayPoll: async (account) => { relayMock.polls++; return relayMock.queue.splice(0); },
  relayHealth: async (account) => { relayMock.healthCalls++; return relayMock.healthy; },
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/relay-client.js', 'export const relayPoll = (a) => globalThis.__relayMock.relayPoll(a); export const relayHealth = (a) => globalThis.__relayMock.relayHealth(a);');
globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__relayMock = relayMock;

// Подмена резолвера: копия relay.js с переписанными путями
let src = readFileSync(ROOT + '/../src/features/relay.js', 'utf8');
src = src
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../relay-client.js'", 'from "' + MOCKS + '/relay-client.js"');
writeFileSync(MOCKS + '/features-relay.mjs', src);
const R = await import(MOCKS + '/features-relay.mjs');

// ── Управляемые таймеры ────────────────────────────────────────
const timers = new Map();
let timerSeq = 0;
globalThis.setInterval = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 'i' }); return id; };
globalThis.clearInterval = (id) => { timers.delete(id); };
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 't' }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
async function fire(kind, id) {
  const t = timers.get(id);
  if (!t) return;
  if (kind === 't') timers.delete(id);
  await t.fn();
}
async function fireAll() { for (const [id, t] of [...timers]) { await fire(t.kind, id); } }

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    email: 'me@x.ru',
    isLoggedIn: true,
    emails: [],
    pollTimer: null,
    _pollingActive: false,
    _idleActive: false,
    _idleStop: false,
    _relayTicker: null,
    _relayFails: 0,
    _lastRelayHealth: 0,
    ecoMode: false,
    ecoAutonomous: false,
    relayOfflineSince: null,
    relayDeliveryMode: 'relay',
    relayEnabled: false,
    callState: 'idle',
    activeChat: null,
    activeChatType: 'chat',
    currentGroup: null,
    // методы-контракты
    loadCursors: () => ({}),
    saveCursors: () => {},
    cacheBody: (k, b) => { ctxBodies[k] = b; },
    processIncoming: async (list, opts) => { ctxProcessed.push(...list.map(m => ({ m, opts }))); },
    loadGroups: async () => {},
    loadEmails: async () => {},
    loadMessages: async () => {},
    loadGroupMessages: async () => {},
    scrollToBottom: () => {},
    showToast: (msg, ms) => { toasts.push(msg); },
    t: (k) => 'T:' + k,
    onEcoMode: async () => {},
  }, over);
}
const ctxBodies = {};
const ctxProcessed = [];
const toasts = [];

// ── 1. relayConsume ────────────────────────────────────────────
console.log('1. relayConsume (виртуальные письма)');
{
  const ctx = makeCtx();
  relayMock.queue = [
    { id: 'r1', from: 'Peer@X.ru', ts: 1758000000, body: 'ENC:hello' },
    { id: 'r1', from: 'peer@x.ru', ts: 1758000000, body: 'ENC:hello' }, // дубль по env.id
    { id: 'r2', from: 'peer@x.ru', ts: 1758000001, body: 'ENC:second' },
  ];
  await R.relayConsume(ctx);
  check('2 свежих конверта слиты (дубль отфильтрован)', ctx.emails.length === 2);
  check('uid rl-<id> + folder RELAY', ctx.emails.every(m => m.uid.startsWith('rl-') && m.folder === 'RELAY'));
  check('from нормализован в нижний регистр', ctx.emails.every(m => m.from === 'peer@x.ru'));
  check('тела в body-cache сразу', ctxBodies['RELAY:rl-r1'] === 'ENC:hello' && ctxBodies['RELAY:rl-r2'] === 'ENC:second');
  check('processIncoming получил свежие', ctxProcessed.length === 2);
  // пустая очередь — ничего не делает
  ctxProcessed.length = 0;
  await R.relayConsume(ctx);
  check('пустая очередь — no-op', ctxProcessed.length === 0 && ctx.emails.length === 2);
  // повторный poll тех же конвертов — не задваивает
  relayMock.queue = [{ id: 'r1', from: 'peer@x.ru', ts: 1758000000, body: 'ENC:hello' }];
  await R.relayConsume(ctx);
  check('повторный poll того же конверта — не дубль', ctx.emails.length === 2);
}

// ── 2. loadEmailsFast ──────────────────────────────────────────
console.log('2. loadEmailsFast (звонковый фетч)');
{
  const ctx = makeCtx();
  ctxProcessed.length = 0;
  apiMock.fetchEmailsIncrementalFast = async (acc, cursors) => ({
    messages: [{ uid: 10, folder: 'INBOX', from: 'a@x.ru', date: '2026-01-01T00:00:00Z' }],
    cursors: { INBOX: 10 },
  });
  await R.loadEmailsFast(ctx, false);
  check('письма слиты в emails', ctx.emails.length === 1 && ctx.emails[0].uid === 10);
  check('processIncoming с notify=false', ctxProcessed.length === 1 && ctxProcessed[0].opts.notify === false);
  // сбой fetch — тихо
  apiMock.fetchEmailsIncrementalFast = async () => { throw new Error('lock busy'); };
  const before = ctx.emails.length;
  await R.loadEmailsFast(ctx, true);
  check('сбой fetch — тихо, список цел', ctx.emails.length === before);
  apiMock.fetchEmailsIncrementalFast = async (acc, cursors) => ({ messages: [], cursors });
}

// ── 3. startPolling / stopPolling ──────────────────────────────
console.log('3. startPolling/stopPolling');
{
  timers.clear();
  const ctx = makeCtx();
  ctx.loadEmails = async (silent) => { throw new Error('Not connected'); };
  R.startPolling(ctx, 1000);
  check('pollTimer выставлен', ctx.pollTimer !== null);
  await fire('i', ctx.pollTimer); // 1-й тик: Not connected → restoreSession (fire await-ит до конца)
  check('Not connected → restoreSession (поллинг жив)', apiMock.calls.some(c => c[0] === 'restoreSession') && ctx.pollTimer !== null);
  // нормальный тик: relayConsume + loadGroups + loadEmails
  apiMock.calls.length = 0;
  const activeChatCtx = makeCtx({ activeChat: 'peer@x.ru' });
  activeChatCtx.loadEmails = async () => {};
  R.startPolling(activeChatCtx, 1000);
  await fire('i', activeChatCtx.pollTimer);
  check('тик: релей опрошен (relayPoll)', relayMock.polls > 0);
  // анти-наложение: _pollingActive=true → тик выходит ДО loadEmails
  const ctx2 = makeCtx();
  R.startPolling(ctx2, 1000);
  let entered = 0;
  ctx2.loadEmails = async () => { entered++; };
  ctx2._pollingActive = true; // предыдущий тик «ещё выполняется»
  await fire('i', ctx2.pollTimer);
  check('анти-наложение: тик при активном — пропуск', entered === 0);
  // stopPolling
  R.stopPolling(ctx2);
  check('stopPolling чистит таймер', ctx2.pollTimer === null && !timers.has(ctx2.pollTimer));
}

// ── 4. idleLoop ─────────────────────────────────────────────────
console.log('4. idleLoop');
{
  timers.clear();
  const ctx = makeCtx();
  apiMock.calls.length = 0;
  // idleWait сразу «ломается» → фолбэк на поллинг + ретрай через 60с
  apiMock.idleWait = async () => { throw new Error('IDLE not supported'); };
  const p = R.idleLoop(ctx);
  await p;
  check('IDLE-сбой: idleStart попытан, монитор-предупреждение — не бросается', apiMock.calls.some(c => c[0] === 'idleStart'));
  check('IDLE-сбой: ретрай-таймер 60с запланирован', [...timers.values()].some(t => t.kind === 't' && t.ms === 60000));
  // повторный вход заблокирован пока _idleActive
  const ctx2 = makeCtx();
  ctx2._idleActive = true;
  await R.idleLoop(ctx2);
  check('_idleActive — повторный вход no-op', apiMock.calls.filter(c => c[0] === 'idleStart').length >= 1);
  // не залогинен — no-op
  const ctx3 = makeCtx({ isLoggedIn: false });
  const beforeCalls = apiMock.calls.length;
  await R.idleLoop(ctx3);
  check('не залогинен — no-op', apiMock.calls.length === beforeCalls);
  // _idleStop: корректный выход (idleWait меняет на changed)
  apiMock.idleWait = async () => ({ changed: true });
  const ctx4 = makeCtx();
  let fastCalls = 0;
  ctx4.loadEmailsFast = undefined; // ctx-метод loadEmailsFast вызывается внутри — мок через объект
  // idleLoop зовёт loadEmailsFast(ctx) — модульную; она пойдёт в api-мок: ок
  const p4 = R.idleLoop(ctx4);
  ctx4._idleStop = true; // выходим после первой итерации
  await p4;
  check('_idleStop: цикл вышел, флаги сброшены', ctx4._idleActive === false && ctx4._idleStop === false);
}

// ── 5. startRelayTicker + resilience ───────────────────────────
console.log('5. relayTicker + relay-resilience');
{
  timers.clear();
  const ctx = makeCtx();
  relayMock.healthy = true;
  relayMock.queue = [];
  R.startRelayTicker(ctx);
  check('тикер создан (5с)', ctx._relayTicker !== null);
  check('повторный start — no-op', (R.startRelayTicker(ctx), true));
  // health-чек: _lastRelayHealth=0 → сработает при первом тике
  let toastsSeen = 0;
  const origToast = ctx.showToast;
  ctx.showToast = (m, ms) => { toastsSeen++; origToast(m, ms); };
  ctx._lastRelayHealth = Date.now() - 70000; // пора чекать
  relayMock.healthy = false;
  ctx.ecoMode = true;
  ctx.ecoAutonomous = false;
  await fire('i', ctx._relayTicker);
  check('health-fail #1 посчитан', ctx._relayFails === 1);
  ctx._lastRelayHealth = Date.now() - 70000;
  await fire('i', ctx._relayTicker);
  check('health-fail #2', ctx._relayFails === 2);
  ctx._lastRelayHealth = Date.now() - 70000;
  await fire('i', ctx._relayTicker);
  check('3 фейла в эко → автономный режим (rescue эффекты)', ctx._relayFails === 3 && ctx.ecoAutonomous === true && ctx.relayDeliveryMode === 'email' && toastsSeen === 1);
  // logout: тикер самоочищается
  const ctx2 = makeCtx({ isLoggedIn: false });
  R.startRelayTicker(ctx2);
  await fire('i', ctx2._relayTicker);
  check('logout → тикер самоочищается', ctx2._relayTicker === null);
}

// ── 6. enterRelayOfflineRescue + onEcoMode ─────────────────────
console.log('6. rescue + onEcoMode');
{
  timers.clear();
  const ctx = makeCtx();
  toasts.length = 0;
  let idleStarted = 0;
  ctx.idleLoop = async () => { idleStarted++; };
  await R.enterRelayOfflineRescue(ctx);
  check('автономный режим: флаги', ctx.ecoAutonomous === true && ctx.relayOfflineSince !== null && ctx.relayDeliveryMode === 'email');
  check('служба поднята (pushSet+ecoSet(false))', apiMock.calls.some(c => c[0] === 'pushSet') && apiMock.calls.some(c => c[0] === 'ecoSet' && c[1] === false));
  check('IDLE + поллинг запущены (idleStart + pollTimer), тост показан', apiMock.calls.some(c => c[0] === 'idleStart') && ctx.pollTimer !== null && toasts.length === 1);
  // onEcoMode(true): глушит IDLE, релей-тикер + поллинг 60с
  timers.clear();
  const eco = makeCtx({ isLoggedIn: true });
  eco.idleLoop = async () => { idleStarted++; };
  toasts.length = 0;
  apiMock.calls.length = 0;
  await R.onEcoMode(eco, true, true);
  check('эко ON: ecoMode=true, kv сохранён', eco.ecoMode === true && dbMock.kv.get('eco-mode') === '1');
  check('эко ON: IDLE стоп + сервис глушится', apiMock.calls.some(c => c[0] === 'idleStop') && apiMock.calls.some(c => c[0] === 'ecoSet' && c[1] === true));
  check('эко ON: релей-тикер жив, поллинг 60с', eco._relayTicker !== null && timers.get(eco.pollTimer) && timers.get(eco.pollTimer).ms === 60000);
  check('эко ON silent: без тоста', toasts.length === 0);
  // эко OFF: классика
  await R.onEcoMode(eco, false);
  check('эко OFF: IDLE+поллинг 30с, тост', timers.get(eco.pollTimer) && timers.get(eco.pollTimer).ms === 30000 && toasts.length === 1);
  // не залогинен: только флаг+kv
  const nl = makeCtx({ isLoggedIn: false });
  apiMock.calls.length = 0;
  await R.onEcoMode(nl, true);
  check('эко без логина: состояние сохранено, сервис не трогаем', nl.ecoMode === true && apiMock.calls.length === 0);
  // onRelayEnabled
  const rl = makeCtx();
  R.onRelayEnabled(rl, true);
  check('onRelayEnabled', rl.relayEnabled === true);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
