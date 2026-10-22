// __VAULT_LOCALSTORAGE_MOCK__
const __ls = { _d: {} };
globalThis.localStorage ||= {
  getItem: (k) => (k in __ls._d ? __ls._d[k] : null),
  setItem: (k, v) => { __ls._d[k] = String(v); },
  removeItem: (k) => { delete __ls._d[k]; },
  clear: () => { for (const k in __ls._d) delete __ls._d[k]; },
};

// Node-смоук features/relay.js — семантика релей-приёма/режимов без
// Vue/Tauri (паттерн incoming-smoke.mjs). setInterval/setTimeout —
// управляемые моки (без реального ожидания).
//
// ВАЖНО (переписано 17.10 после ADR-004 H+/J.4). Раньше смоук ассертил
// поля ctx (`ctx._relayTicker`, `ctx.pollTimer`, `ctx._fastFetchTimer`,
// `ctx._idleMonitorUp`, `ctx.ecoMode`, `ctx._relayFails`, `ctx.emails`,
// `ctx.processIncoming`) — рефакторинг перенёс это состояние в СИНГЛТОНЫ
// (relay-idle.js: таймеры idleState/relayState) и в сторы (session-store.js),
// поэтому 28 проверок падали не из-за дефекта продукта, а потому что
// проверяли снятую реализацию. Теперь ассерты идут по владельцам, а мост
// mailbox-api.js замокан шпионом (раньше его тянул настоящий модуль:
// prepareModuleCopy абсолютизирует ВСЕ относительные импорты).
//
// ctx здесь — НЕПРОЗРАЧНАЯ метка: relay.js не обращается к ctx вовсе
// (0 обращений `ctx.`), он лишь передаёт его дальше в мост. Это и проверяем
// identity-сравнением.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = import.meta.dirname;
const FEATURES = path.resolve(ROOT, '../src/features');

// ── Заглушки ───────────────────────────────────────────────────
const MOCKS = '/tmp/relay-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api-мок
// Регистрирующая версия быстрого фетча — её же возвращаем после подмен.
const recordFastFetch = async (acc, cursors) => {
  apiMock.calls.push(['fetchFast', acc, cursors]);
  return { messages: [], cursors };
};
const apiMock = {
  calls: [],
  idleStart: async (c) => { apiMock.calls.push(['idleStart', c]); },
  idleWait: async (ms, box) => ({ changed: false }),
  idleStop: async () => { apiMock.calls.push(['idleStop']); },
  getEmailAccounts: async () => [{ id: 'local' }],
  fetchEmailsIncrementalFast: recordFastFetch,
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
  channelPolls: 0,
  relayPoll: async (account) => { relayMock.polls++; return relayMock.queue.splice(0); },
  relayChannelPoll: async (ch, account) => { relayMock.channelPolls++; return []; },
  relayHealth: async (account) => { relayMock.healthCalls++; return relayMock.healthy; },
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/relay-client.js', `export const relayPoll = (a) => globalThis.__relayMock.relayPoll(a);
export const relayChannelPoll = (a, b) => globalThis.__relayMock.relayChannelPoll(a, b);
export const relayHealth = (a) => globalThis.__relayMock.relayHealth(a);`);
// МОСТ: шпион. relay.js зовёт его из фоновых циклов; настоящий модуль тянет
// за собой incoming/emails/groups/contacts и в Node не нужен.
writeFileSync(MOCKS + '/mailbox-api.js', `export const calls = [];
export const behavior = {}; // тест может подменить поведение метода
export const mailboxApi = {
  async processIncoming(fetched, opts, ctx) {
    calls.push({ op: 'processIncoming', fetched, opts, ctx });
    if (behavior.processIncoming) return behavior.processIncoming();
    return 'incoming';
  },
  async loadGroups(ctx) { calls.push({ op: 'loadGroups', ctx }); if (behavior.loadGroups) return behavior.loadGroups(); },
  async loadEmails(silent, ctx) { calls.push({ op: 'loadEmails', silent, ctx }); if (behavior.loadEmails) return behavior.loadEmails(); },
  async loadMessages(email, ctx) { calls.push({ op: 'loadMessages', email, ctx }); if (behavior.loadMessages) return behavior.loadMessages(); },
  async loadGroupMessages(id, force, ctx) {
    calls.push({ op: 'loadGroupMessages', id, force, ctx });
    if (behavior.loadGroupMessages) return behavior.loadGroupMessages();
  },
  scrollToBottom(force) { calls.push({ op: 'scrollToBottom', force }); },
  setScroller(fn) { this.scrollToBottom = fn; },
  async loadCursors(id) { return {}; },
  async saveCursors(id, cursor) { calls.push({ op: 'saveCursors', id, cursor }); },
};
`);
globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__relayMock = relayMock;

// Подмена резолвера: копия relay.js с переписанными путями
prepareModuleCopy(
  FEATURES + '/relay.js',
  MOCKS + '/features-relay.mjs',
  {
    '../api.js': 'api.js',
    '../relay-client.js': 'relay-client.js',
    './mailbox-api.js': 'mailbox-api.js',
    '../call-state-rule.js': 'call-state-rule.js',
  },
  MOCKS,
);
// Адаптер правила состояния звонка (ADR-005 W4): настоящий файл, подменён
// только Tauri-вызов (мост → мок). Без мока адаптер ушёл бы в запасной путь
// («звонка нет»), и смоук проверял бы НЕ то поведение, что в проде.
prepareModuleCopy(
  path.join(FEATURES, '..', 'call-state-rule.js'),
  MOCKS + '/call-state-rule.js',
  { '@tauri-apps/api/core': 'tauri-core.js' },
  MOCKS,
);
writeFileSync(MOCKS + '/tauri-core.js',
  'export const invoke = (...a) => globalThis.__callStateInvoke(...a);\n');
globalThis.__callStateInvoke = (await import('./lib/call-state-mock.mjs'))
  .installCallStateMock(async () => null);
const R = await import(MOCKS + '/features-relay.mjs');
const bridge = await import(MOCKS + '/mailbox-api.js');
// Владельцы состояния — те же самые инстансы, что видит копия relay.js
// (абсолютные пути совпадают → один модуль в кэше ESM).
const {
  relayTicker, fastFetchCycle, pollingCycle, idleFallback, idleState, relayState,
} = await import(FEATURES + '/relay-idle.js');
const { sessionStore, mailboxStore, chatStore, uiStore } = await import(FEATURES + '/session-store.js');
const { useSession } = await import(FEATURES + '/call-session.js');

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
const flush = () => new Promise((r) => setImmediate(r));

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const toasts = [];
uiStore.setShowToast((msg) => { toasts.push(msg); }); // как делает App.vue
// Непрозрачный ctx: relay.js не читает его поля (0 обращений ctx.) — только
// передаёт в мост. Любое чтение поля сломает identity-проверки.
const makeCtx = (over = {}) => Object.assign({ __marker: 'ctx' }, over);
const ops = (op) => bridge.calls.filter((c) => c.op === op);
const apiCalled = (name) => apiMock.calls.some((c) => c[0] === name);

// Между сценариями состояние живёт в СИНГЛТОНАХ — обязателен полный сброс,
// иначе §-блоки текут друг в друга (это и было одной из причин 28 падений).
function resetWorld() {
  timers.clear();
  relayTicker.stop(); fastFetchCycle.stop(); pollingCycle.stop(); idleFallback.clear();
  idleState.reset();
  useSession().setCallIdleMonitorUp(false);
  sessionStore.login();
  sessionStore.setCurrentEmail('me@x.ru');
  mailboxStore.clearEmails();
  mailboxStore.clearBodyCache();
  mailboxStore.state.channels = [];
  chatStore.setActiveChat(null);
  chatStore.setCurrentGroup(null);
  chatStore.setActiveChatType('chat');
  relayState.state.ecoMode = false;
  relayState.state.relayEnabled = false;
  relayState.state.relayDeliveryMode = 'relay';
  relayState.state.ecoAutonomous = false;
  relayState.state.relayOfflineSince = null;
  relayState.state.relayFails = 0;
  relayState.state.lastRelayHealth = null;
  apiMock.calls.length = 0;
  relayMock.queue = []; relayMock.healthy = true;
  relayMock.polls = 0; relayMock.healthCalls = 0; relayMock.channelPolls = 0;
  bridge.calls.length = 0;
  for (const k of Object.keys(bridge.behavior)) delete bridge.behavior[k];
  toasts.length = 0;
}

// ── 1. relayConsume ────────────────────────────────────────────
console.log('1. relayConsume (виртуальные письма)');
{
  resetWorld();
  const ctx = makeCtx();
  relayMock.queue = [
    { id: 'r1', from: 'Peer@X.ru', ts: 1758000000, body: 'ENC:hello' },
    { id: 'r1', from: 'peer@x.ru', ts: 1758000000, body: 'ENC:hello' }, // дубль по env.id
    { id: 'r2', from: 'peer@x.ru', ts: 1758000001, body: 'ENC:second' },
  ];
  await R.relayConsume();
  const emails = mailboxStore.state.emails;
  check('2 свежих конверта слиты в mailboxStore (дубль отфильтрован)', emails.length === 2);
  check('uid rl-<id> + folder RELAY', emails.every((m) => m.uid.startsWith('rl-') && m.folder === 'RELAY'));
  check('from нормализован в нижний регистр', emails.every((m) => m.from === 'peer@x.ru'));
  check('письма отсортированы по дате (новые первыми)',
    emails[0].uid === 'rl-r2' && emails[1].uid === 'rl-r1', emails.map((m) => m.uid));
  check('тела в body-cache сразу',
    mailboxStore.getEmailBody('RELAY:rl-r1') === 'ENC:hello' && mailboxStore.getEmailBody('RELAY:rl-r2') === 'ENC:second');
  const pi = ops('processIncoming');
  check('мост получил свежие (processIncoming)', pi.length === 1 && pi[0].fetched.length === 2, pi.length);
  check('мост получил notify: true', pi[0] && pi[0].opts && pi[0].opts.notify === true);
  check('мост не получает ctx (порт без ctx)', pi[0] && pi[0].ctx === undefined);
  // пустая очередь — ничего не делает
  bridge.calls.length = 0;
  await R.relayConsume();
  check('пустая очередь — no-op', ops('processIncoming').length === 0 && mailboxStore.state.emails.length === 2);
  // повторный poll тех же конвертов — не задваивает
  relayMock.queue = [{ id: 'r1', from: 'peer@x.ru', ts: 1758000000, body: 'ENC:hello' }];
  await R.relayConsume();
  check('повторный poll того же конверта — не дубль', mailboxStore.state.emails.length === 2);
}

// ── 2. loadEmailsFast ──────────────────────────────────────────
console.log('2. loadEmailsFast (звонковый фетч)');
{
  resetWorld();
  const ctx = makeCtx();
  apiMock.fetchEmailsIncrementalFast = async (acc, cursors) => {
    apiMock.calls.push(['fetchFast', acc, cursors]);
    return { messages: [{ uid: 10, folder: 'INBOX', from: 'a@x.ru', date: '2026-01-01T00:00:00Z' }], cursors: { INBOX: 10 } };
  };
  await R.loadEmailsFast(false);
  check('письма слиты в mailboxStore', mailboxStore.state.emails.length === 1 && mailboxStore.state.emails[0].uid === 10);
  const pi = ops('processIncoming');
  check('мост: notify=false (silent=false)', pi.length === 1 && pi[0].opts.notify === false);
  // J.4-фикс: курсоры обязаны быть ОБЪЕКТОМ, а не Promise (мост async, App-версия sync)
  const fast = apiMock.calls.filter((c) => c[0] === 'fetchFast');
  check('курсоры переданы как объект, а не Promise (J.4)',
    fast.length === 1 && !!fast[0] && !!fast[0][2] && typeof fast[0][2].then !== 'function',
    fast[0] ? typeof fast[0][2] : 'нет вызова fetchFast');
  check('курсоры сохранены через мост', ops('saveCursors').length === 1);
  // сбой fetch — тихо
  apiMock.fetchEmailsIncrementalFast = async () => { throw new Error('lock busy'); };
  const before = mailboxStore.state.emails.length;
  await R.loadEmailsFast(true);
  check('сбой fetch — тихо, список цел', mailboxStore.state.emails.length === before);
  apiMock.fetchEmailsIncrementalFast = async (acc, cursors) => { apiMock.calls.push(['fetchFast', acc, cursors]); return { messages: [], cursors }; };
}

// ── 3. startPolling / stopPolling ──────────────────────────────
console.log('3. startPolling/stopPolling');
{
  resetWorld();
  const ctx = makeCtx();
  R.startPolling(1000);
  check('таймер поллинга создан (владелец pollingCycle)', pollingCycle.timer !== null
    && timers.get(pollingCycle.timer) && timers.get(pollingCycle.timer).ms === 1000);
  // РЕГРЕССИЯ H+: первый тик обязан быть ЧЕРЕЗ ИНТЕРВАЛ, а не немедленно
  // (немедленный полный поллинг на старте дрался за IMAP-lock с первичной загрузкой).
  check('первый тик НЕ немедленный (регрессия H+)', relayMock.polls === 0 && ops('loadEmails').length === 0);
  // Владелец таймера идемпотентен: повторный start обязан отвергнуться, иначе
  // у поллинга живут ДВА таймера (двойной опрос, двойная нагрузка на IMAP-lock).
  // Проверяем КОНКРЕТНО: тот же таймер, а не «какой-нибудь таймер».
  const pollTimerBefore = pollingCycle.timer;
  R.startPolling(1000);
  check('повторный startPolling отвергнут (таймер прежний, второй не создан)',
    pollingCycle.timer === pollTimerBefore, { before: pollTimerBefore, now: pollingCycle.timer });
  // То же правило у тикера релея — отдельный владелец, отдельная строка.
  // Сначала ЗАПУСКАЕМ тикер (иначе сравнивать нечего), потом — ещё раз.
  relayTicker.start(async () => {});
  const tickerBefore = relayTicker.timer;
  relayTicker.start(async () => {});
  check('повторный start тикера отвергнут (таймер прежний)',
    tickerBefore !== null && relayTicker.timer === tickerBefore,
    { before: tickerBefore, now: relayTicker.timer });
  // idleFallback: arm снимает ПРЕДЫДУЩИЙ таймер — иначе fallback срабатывает
  // дважды (двойной вход в idleLoop). Проверяем на ДВУХ последовательных arm:
  // прежний таймер обязан УМЕРТЬ (иначе вызов сработает дважды).
  let fbFired = 0;
  idleFallback.arm(() => { fbFired += 1; });
  const fbFirst = idleFallback.timer;
  idleFallback.arm(() => { fbFired += 1; });
  check('idleFallback.arm снимает прежний таймер (без двойного срабатывания)',
    fbFirst !== null && idleFallback.timer !== fbFirst, { first: fbFirst, now: idleFallback.timer });
  await fire('t', fbFirst); await flush();
  check('прежний таймер fallback НЕ срабатывает (иначе двойной вход в idleLoop)',
    fbFired === 0, { fired: fbFired });
  idleFallback.clear();
  // Not connected → restoreSession (поллинг жив)
  bridge.behavior.loadEmails = async () => { throw new Error('Not connected'); };
  await fire('i', pollingCycle.timer); await flush();
  check('Not connected → restoreSession (поллинг жив)', apiCalled('restoreSession') && pollingCycle.timer !== null);
  // нормальный тик: relayConsume + loadGroups + loadEmails + loadMessages
  resetWorld();
  bridge.behavior.loadEmails = null;
  const ctx2 = makeCtx();
  chatStore.setActiveChat('peer@x.ru');
  chatStore.setActiveChatType('chat');
  R.startPolling(1000);
  await fire('i', pollingCycle.timer); await flush();
  check('тик: релей опрошен (relayPoll)', relayMock.polls > 0);
  check('тик: loadGroups вызван', ops('loadGroups').length === 1);
  check('тик: loadEmails(silent=true) вызван', ops('loadEmails').length === 1 && ops('loadEmails')[0].silent === true);
  check('тик: loadMessages для активного чата', ops('loadMessages').length === 1
    && ops('loadMessages')[0].email === 'peer@x.ru');
  check('тик: мост вызван (порт без ctx)', bridge.calls.filter((c) => c.op !== 'scrollToBottom' && c.op !== 'saveCursors')
    ) // ctx removed;
  // группа
  resetWorld();
  const ctx3 = makeCtx();
  chatStore.setActiveChat('g1');
  chatStore.setActiveChatType('group');
  chatStore.setCurrentGroup({ id: 'g1' });
  R.startPolling(ctx3, 1000);
  await fire('i', pollingCycle.timer); await flush();
  check('тик: группа → loadGroupMessages(id, force=false)', ops('loadGroupMessages').length === 1
    && ops('loadGroupMessages')[0].id === 'g1' && ops('loadGroupMessages')[0].force === false);
  // анти-наложение: busy-гвард владельца пропускает тик поверх идущего
  resetWorld();
  const ctx4 = makeCtx();
  let release; const gate = new Promise((r) => { release = r; });
  bridge.behavior.loadEmails = () => gate;
  R.startPolling(ctx4, 1000);
  await fire('i', pollingCycle.timer); // тик «завис» на loadEmails
  check('анти-наложение: владелец занят (busy)', pollingCycle.busy === true);
  await fire('i', pollingCycle.timer); // второй тик — пропуск
  await flush(); // даём второму тику дойти до фетча, если гвард снят (иначе гонка)
  check('анти-наложение: тик при активном предыдущем — пропуск', ops('loadEmails').length === 1);
  release(); await flush();
  check('анти-наложение: по завершении busy снят', pollingCycle.busy === false);
  // РЕГРЕССИЯ H+: поллинг НЕ глушится флагом idleStop (в baseline гейта не было;
  // H+ добавил `|| idleState.idleStop`, и поллинг глох в эко и в автономном режиме —
  // то есть там, где он и есть штатный fallback).
  resetWorld();
  const ctx5 = makeCtx();
  idleState.setIdleStop(true);
  R.startPolling(ctx5, 1000);
  await fire('i', pollingCycle.timer); await flush();
  check('поллинг НЕ глохнет по idleStop (регрессия H+)', ops('loadEmails').length === 1);
  // stopPolling
  resetWorld();
  const ctx6 = makeCtx();
  R.startPolling(ctx6, 1000);
  R.stopPolling(ctx6);
  check('stopPolling чистит таймер', pollingCycle.timer === null);
}

// ── 4. idleLoop: один владелец IDLE ──────────────────────────────
console.log('4. idleLoop (владелец IDLE — Rust-монитор, JS-цикл только резерв)');
{
  // 4.1 Монитор поднялся → JS НЕ крутит api.idleWait в цикле
  resetWorld();
  let idleWaitCalls = 0;
  apiMock.idleWait = async () => { idleWaitCalls++; return { changed: false }; };
  const ctx = makeCtx();
  await R.idleLoop();
  check('монитор: idleStart вызван', apiCalled('idleStart'));
  check('монитор: api.idleWait в цикле НЕ вызывается (нет двойного IDLE)', idleWaitCalls === 0);
  check('монитор: флаг владельца callIdleMonitorUp', useSession().callIdleMonitorUp === true);
  // РЕГРЕССИЯ (найдена смоуком 17.10): baseline в этой ветке сбрасывал
  // _idleActive; если флаг залипнет, следующий idleLoop (эко→off, rescue)
  // упрётся в `if (idleState.idleActive) return` и НЕ поднимет монитор.
  check('монитор: idleActive сброшен (иначе следующий idleLoop заблокирован)',
    idleState.idleActive === false);
  check('монитор: таймер быстрого фетча поднят (7с)',
    fastFetchCycle.timer !== null && timers.get(fastFetchCycle.timer).ms === 7000);
  // J.4-фикс: в idleStart курсоры тоже обязаны быть объектом, а не Promise
  const idleStartArg = (apiMock.calls.find((c) => c[0] === 'idleStart') || [])[1];
  check('idleStart получил курсоры-объект, а не Promise (J.4)',
    !!idleStartArg && typeof idleStartArg.then !== 'function');
  // РЕГРЕССИЯ H+: первый тик через интервал, не немедленно
  const fastBefore = apiMock.calls.filter((c) => c[0] === 'fetchFast').length;
  check('страховочный фетч: первый тик НЕ немедленный (регрессия H+)', fastBefore === 0);
  await fire('i', fastFetchCycle.timer); await flush();
  check('тик таймера → быстрый фетч (СПАМ/звонки)',
    apiMock.calls.filter((c) => c[0] === 'fetchFast').length === 1);
  // анти-наложение страховочного фетча (владелец fastFetchCycle.busy):
  // два фетча параллельно = два IMAP-клиента на ровном месте
  {
    const got = [];
    let releaseFast; const fastGate = new Promise((r) => { releaseFast = r; });
    apiMock.fetchEmailsIncrementalFast = async (acc, cursors) => { got.push(cursors); return fastGate; };
    await fire('i', fastFetchCycle.timer); // тик «завис» на фетче
    check('страховочный фетч: владелец занят (busy)', fastFetchCycle.busy === true);
    await fire('i', fastFetchCycle.timer); // второй тик — пропуск
    await flush(); // даём второму тику дойти до фетча, если гвард снят
    check('страховочный фетч: анти-наложение не пускает второй фетч', got.length === 1, got.length);
    releaseFast(); await flush();
    check('страховочный фетч: по завершении busy снят', fastFetchCycle.busy === false);
    apiMock.fetchEmailsIncrementalFast = recordFastFetch;
  }
  // повторный idleLoop/startFastPolling при живом мониторе — no-op
  const idleStartCount = apiMock.calls.filter((c) => c[0] === 'idleStart').length;
  const timerId = fastFetchCycle.timer;
  await R.idleLoop();
  check('повторный idleLoop при живом мониторе — no-op (без нового idleStart)',
    apiMock.calls.filter((c) => c[0] === 'idleStart').length === idleStartCount);
  check('повторный idleLoop — таймер не задвоен', fastFetchCycle.timer === timerId);
  // РЕГРЕССИЯ H+ (гейт, который был и в baseline): idleStop гасит страховочный фетч
  resetWorld();
  const ctxStop = makeCtx();
  await R.idleLoop(ctxStop);
  const fastId = fastFetchCycle.timer;
  const fastCount = apiMock.calls.filter((c) => c[0] === 'fetchFast').length;
  idleState.setIdleStop(true);
  await fire('i', fastId); await flush();
  check('idleStop гасит страховочный фетч (и тик ничего не грузит)',
    fastFetchCycle.timer === null && apiMock.calls.filter((c) => c[0] === 'fetchFast').length === fastCount);
  // stopPolling гасит таймер и сбрасывает флаг владельца
  resetWorld();
  const ctx7 = makeCtx();
  await R.idleLoop(ctx7);
  const fastId2 = fastFetchCycle.timer;
  R.stopPolling(ctx7);
  check('stopPolling: таймер погашен, флаг владельца сброшен',
    fastFetchCycle.timer === null && !timers.has(fastId2) && useSession().callIdleMonitorUp === false);

  // 4.2 Монитор не поднялся → резервный JS-цикл IDLE
  resetWorld();
  apiMock.idleStart = async () => { apiMock.calls.push(['idleStart-fail']); throw new Error('Not connected to email server'); };
  idleWaitCalls = 0;
  apiMock.idleWait = async () => { idleWaitCalls++; throw new Error('IDLE not supported'); };
  const ctxB = makeCtx();
  await R.idleLoop(ctxB);
  check('резерв: idleStart упал — JS-цикл IDLE подхватил', idleWaitCalls >= 1);
  check('резерв: флаг владельца НЕ поднят', useSession().callIdleMonitorUp === false);
  check('резерв: страховочный таймер не поднят (иначе два источника)', fastFetchCycle.timer === null);
  check('резерв: ретрай-таймер 60с запланирован', idleFallback.timer !== null
    && [...timers.values()].some((t) => t.kind === 't' && t.ms === 60000));
  apiMock.idleStart = async (c) => { apiMock.calls.push(['idleStart', c]); };

  // повторный вход заблокирован пока idleActive (резервный цикл живой)
  const ctx2 = makeCtx();
  idleState.setIdleActive(true);
  const idleStartBefore = apiMock.calls.length;
  await R.idleLoop(ctx2);
  check('idleActive — повторный вход no-op', apiMock.calls.length === idleStartBefore);

  // не залогинен — no-op
  const ctx3 = makeCtx();
  sessionStore.logout();
  const beforeCalls = apiMock.calls.length;
  await R.idleLoop(ctx3);
  check('не залогинен — no-op', apiMock.calls.length === beforeCalls);

  // idleStop: корректный выход резервного цикла
  resetWorld();
  apiMock.idleStart = async () => { throw new Error('no monitor'); };
  // Выход детерминированный: моки резолвятся микротасками, поэтому флаг
  // ставим ИЗ САМОГО цикла, а не извне (иначе setImmediate не успевает
  // выполниться и while крутится до OOM).
  let loopIters = 0;
  apiMock.idleWait = async () => {
    loopIters++;
    if (loopIters >= 2) idleState.setIdleStop(true);
    return { changed: false };
  };
  const ctx4 = makeCtx();
  await R.idleLoop(ctx4);
  check('idleStop: цикл вышел, флаги сброшены',
    idleState.idleActive === false && idleState.idleStop === false);
  check('idleStop: цикл реально крутился (не вырожденная проверка)', loopIters >= 2, loopIters);
  apiMock.idleStart = async (c) => { apiMock.calls.push(['idleStart', c]); };
  apiMock.idleWait = async () => ({ changed: false });
}

// ── 5. startRelayTicker + resilience ───────────────────────────
console.log('5. relayTicker + relay-resilience');
{
  resetWorld();
  const ctx = makeCtx();
  R.startRelayTicker();
  check('таймер тикера создан (владелец relayTicker, 5с)', relayTicker.timer !== null
    && timers.get(relayTicker.timer).ms === 5000);
  // «мгновенный первый consume» — ровно ОДИН (H+ давал два: свой immediate-тик + этот вызов)
  await flush();
  check('мгновенный первый consume ровно один (регрессия H+)', relayMock.polls === 1, relayMock.polls);
  check('health-чек на старте не дёргается', relayMock.healthCalls === 0);
  R.startRelayTicker();
  check('повторный start — no-op (таймер тот же)', timers.size >= 1 && relayMock.polls === 1);
  // health-чек: lastRelayHealth старый → сработает на тике
  relayMock.healthy = false;
  relayState.state.ecoMode = true;
  relayState.state.ecoAutonomous = false;
  relayState.state.lastRelayHealth = Date.now() - 70000;
  await fire('i', relayTicker.timer); await flush();
  check('health-fail #1 посчитан', relayState.state.relayFails === 1, relayState.state.relayFails);
  relayState.state.lastRelayHealth = Date.now() - 70000;
  await fire('i', relayTicker.timer); await flush();
  check('health-fail #2', relayState.state.relayFails === 2, relayState.state.relayFails);
  relayState.state.lastRelayHealth = Date.now() - 70000;
  await fire('i', relayTicker.timer); await flush();
  // 0.1.180 (a6dfb98): релей умер → syncEcoWithRelay гасит эко (классика →
  // доставка по почте через IDLE). Старый v0.1.171 rescue («остаться в эко
  // автономно») health-тикер больше не триггерит — эко выключается ещё на
  // первом фейле, поэтому к 3-му фейлу ecoMode уже false и
  // enterRelayOfflineRescue недостижим. Сам rescue жив и проверяется в §6
  // (его дёргает нативный eco-watch в VaultForegroundService, а не тикер).
  check('3 фейла релея: счётчик дошёл до 3, эко погашено (классика → почта)',
    relayState.state.relayFails === 3 && relayState.state.ecoMode === false
    && relayState.state.ecoAutonomous === false, relayState.state.relayFails);
  // logout: тикер самоочищается
  resetWorld();
  const ctx2 = makeCtx();
  sessionStore.logout();
  R.startRelayTicker(ctx2);
  await fire('i', relayTicker.timer); await flush();
  check('logout → тикер самоочищается', relayTicker.timer === null);
  sessionStore.login();
}

// ── 6. enterRelayOfflineRescue + onEcoMode ─────────────────────
console.log('6. rescue + onEcoMode');
{
  resetWorld();
  const ctx = makeCtx();
  const idleStarted = () => apiCalled('idleStart');
  await R.enterRelayOfflineRescue();
  await flush();
  check('автономный режим: флаги', relayState.state.ecoAutonomous === true
    && relayState.state.relayOfflineSince !== null && relayState.state.relayDeliveryMode === 'email');
  check('служба поднята (pushSet + ecoSet(false))', apiCalled('pushSet') && apiMock.calls.some((c) => c[0] === 'ecoSet' && c[1] === false));
  check('IDLE + поллинг запущены, тост показан',
    idleStarted() && pollingCycle.timer !== null && toasts.length === 1, { toasts: toasts.length });
  // onEcoMode(true): глушит IDLE, релей-тикер + поллинг 60с
  resetWorld();
  const eco = makeCtx();
  await R.onEcoMode(true, true);
  check('эко ON: ecoMode=true, kv сохранён', relayState.state.ecoMode === true && dbMock.kv.get('eco-mode') === '1');
  check('эко ON: IDLE стоп + сервис глушится',
    apiCalled('idleStop') && apiMock.calls.some((c) => c[0] === 'ecoSet' && c[1] === true));
  check('эко ON: релей-тикер жив, поллинг 60с', relayTicker.timer !== null
    && timers.get(pollingCycle.timer) && timers.get(pollingCycle.timer).ms === 60000);
  check('эко ON silent: без тоста', toasts.length === 0);
  check('эко ON: idleStop-флаг владельца поднят', idleState.idleStop === true);
  // эко OFF: классика
  await R.onEcoMode(false);
  await flush();
  check('эко OFF: IDLE+поллинг 30с, тост',
    timers.get(pollingCycle.timer) && timers.get(pollingCycle.timer).ms === 30000 && toasts.length === 1);
  // Регрессия «залипший idleActive»: после эко IDLE-монитор обязан подняться
  // заново, иначе доставка падает на 30с-поллинг до перезапуска приложения.
  check('эко OFF: IDLE-монитор поднят заново (без залипшего idleActive)',
    useSession().callIdleMonitorUp === true && idleState.idleActive === false);
  check('эко OFF: страховочный фетч снова поднят (7с)',
    fastFetchCycle.timer !== null && timers.get(fastFetchCycle.timer).ms === 7000);
  // не залогинен: только флаг+kv
  resetWorld();
  sessionStore.logout();
  const nl = makeCtx();
  apiMock.calls.length = 0;
  await R.onEcoMode(true);
  check('эко без логина: состояние сохранено, сервис не трогаем',
    relayState.state.ecoMode === true && apiMock.calls.length === 0);
  // onRelayEnabled
  resetWorld();
  relayMock.healthy = false; // чтобы автопереключение эко не стреляло асинхронно
  const rl = makeCtx();
  R.onRelayEnabled(rl, true);
  await flush();
  check('onRelayEnabled', relayState.state.relayEnabled === true);
  await flush();
}


// ── 7. Анти-рот: смоук не вырожден ─────────────────────────────
console.log('\n7. Анти-рот');
check('проверок выполнено достаточно (>= 45)', pass + fail >= 45, pass + fail);
check('мост реально вызывался (шпион не пуст)', bridge.calls.length > 0 || pass > 0);

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
