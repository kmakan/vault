// Node-смоук features/mailbox-api.js — контракт МОСТА (ADR-004 Этап D, t_436d452d).
//
// ЗАЧЕМ. mailbox-api.js — вторая (после App.vue) и единственная runtime-точка,
// откуда фичи зовутся в приложении: relay/поллинг идут через него
// (relay.js → mailboxApi.processIncoming / loadMessages). После перевода фич на
// deps-инъекцию (send/attachments/messages/incoming) мост ОБЯЗАН прокидывать
// deps: фичи деструктурируют их без default, и без них падают с
//   TypeError: Cannot destructure property '…' of 'deps' as it is undefined.
//
// Дефект 17.10 (поймано при приёмке Этапа D): мост не был обновлён вместе с
// фичами — живой relay-путь падал, а смоуки самих фич этого не видели, потому
// что они вызывают модули напрямую, минуя мост. Этот смоук закрывает именно
// этот слепой сектор: он зовёт через мост и проверяет, что deps доехали.
import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy, readModuleSource } from './smoke-imports.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/mailbox-api-deps-smoke';
mkdirSync(MOCKS, { recursive: true });

// Настоящие channels.js/contacts.js тянут ../api.js, который на импорте читает
// localStorage (api.js:99). Тот же шим, что в send-smoke.mjs.
globalThis.localStorage ??= {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

// ── Моки: фичи-цели — шпионы, фиксирующие аргумент deps ──────────────
writeFileSync(MOCKS + '/incoming.js', `export const calls = [];
export async function processIncoming(ctx, fetched, opts, deps) {
  calls.push({ ctx, fetched, opts, deps });
  return 'incoming-result';
}
`);
writeFileSync(MOCKS + '/messages.js', `export const calls = [];
export async function loadMessages(ctx, email, deps) {
  calls.push({ ctx, email, deps });
  return 'messages-result';
}
`);
// Остальные lazy-цели моста: смоуку нужны как шпионы ctx-контракта.
writeFileSync(MOCKS + '/emails.js', `export const calls = [];
export async function loadEmails(ctx, silent) { calls.push({ ctx, silent }); return "noop"; }
`);
writeFileSync(MOCKS + '/groups.js', `export const calls = [];
export async function loadGroups(ctx) { calls.push({ ctx }); return "noop"; }
export async function loadGroupMessages(ctx, id, force) { calls.push({ ctx, id, force }); return "noop"; }
`);
writeFileSync(MOCKS + '/history.js', 'export const cacheBody = () => {};');
writeFileSync(MOCKS + '/session-store.js', `const state = { isLoggedIn: true, emails: [], channels: [], emailBodyCache: {}, activeChat: 'a@x.ru', currentGroup: null, activeChatType: 'peer' };
export const sessionStore = { getCurrentEmail: () => 'me@x.ru', state };
export const chatStore = { state };
export const mailboxStore = { state, cacheBody(k, b) { globalThis.__cached = (globalThis.__cached || []).concat([[k, b]]); } };
export const uiStore = { toast() {}, tr: (k) => k };
`);
writeFileSync(MOCKS + '/api.js', `const api = {
  loadCursors: async (id) => { globalThis.__cursorsLoaded = (globalThis.__cursorsLoaded || []).concat([id]); return { INBOX: 'cursor-1' }; },
  saveCursors: async (id, c) => { globalThis.__cursorsSaved = (globalThis.__cursorsSaved || []).concat([[id, c]]); },
};
export default api;
export const db = {};
`);

// ── Копия моста: шпионы вместо фич, НАСТОЯЩИЕ владельцы на месте ────
// bounce/channels/contacts — не мокаем: в них и лежит подлинная dep-реализация,
// которую мост обязан пробросить. Их динамические import() переписываем явно
// (общий absolutizeImports видит только `from '...'`).
const COPY = MOCKS + '/mailbox-api.mjs';
prepareModuleCopy(
  ROOT + '/src/features/mailbox-api.js',
  COPY,
  {
    './incoming.js': 'incoming.js',
    './messages.js': 'messages.js',
    './emails.js': 'emails.js',
    './groups.js': 'groups.js',
    './history.js': 'history.js',
    './session-store.js': 'session-store.js',
    '../api.js': 'api.js',
  },
  MOCKS,
  [
    ["import('./bounce.js')", "import('" + ROOT + "/src/features/bounce.js')"],
    ["import('./channels.js')", "import('" + ROOT + "/src/features/channels.js')"],
    ["import('./contacts.js')", "import('" + ROOT + "/src/features/contacts.js')"],
  ],
);

const { mailboxApi } = await import(COPY);
const incomingSpy = await import(MOCKS + '/incoming.js');
const messagesSpy = await import(MOCKS + '/messages.js');
const emailsSpy = await import(MOCKS + '/emails.js');
const groupsSpy = await import(MOCKS + '/groups.js');
const realBounce = await import(ROOT + '/src/features/bounce.js');
const realChannels = await import(ROOT + '/src/features/channels.js');
const realContacts = await import(ROOT + '/src/features/contacts.js');

// ── 1. processIncoming: deps доезжают и это ПОДЛИННЫЕ функции владельцев ──
console.log('\n1. mailboxApi.processIncoming → deps не потеряны');
{
  const res = await mailboxApi.processIncoming(['m1'], { notify: true });
  const call = incomingSpy.calls.at(-1) || {};
  check('результат фичи проброшен наружу', res === 'incoming-result', 'res=' + JSON.stringify(res));
  check('opts проброшен как есть', call.opts && call.opts.notify === true, JSON.stringify(call.opts));
  check('fetched проброшен как есть',
    Array.isArray(call.fetched) && call.fetched.length === 1 && call.fetched[0] === 'm1', JSON.stringify(call.fetched));
  const d = call.deps || {};
  check('deps передан (не undefined) — ИМЕННО ЭТО падало на relay-пути', !!call.deps);
  check('deps: ровно 5 ключей incoming.js',
    JSON.stringify(Object.keys(d).sort()) === JSON.stringify(
      ['bounceReason', 'bounceRecipients', 'ingestChannelEnvelope', 'isBounceMessage', 'isChannelEnvelope']),
    JSON.stringify(Object.keys(d)));
  check('deps.isBounceMessage — подлинная функция bounce.js', d.isBounceMessage === realBounce.isBounceMessage);
  check('deps.bounceRecipients — подлинная функция bounce.js', d.bounceRecipients === realBounce.bounceRecipients);
  check('deps.bounceReason — подлинная функция bounce.js', d.bounceReason === realBounce.bounceReason);
  check('deps.isChannelEnvelope — подлинная функция channels.js', d.isChannelEnvelope === realChannels.isChannelEnvelope);
  check('deps.ingestChannelEnvelope — подлинная функция channels.js', d.ingestChannelEnvelope === realChannels.ingestChannelEnvelope);
}

// ── 2. loadMessages: то же самое для messages.js ─────────────────────
console.log('\n2. mailboxApi.loadMessages → deps не потеряны');
{
  const res = await mailboxApi.loadMessages('peer@x.ru');
  const call = messagesSpy.calls.at(-1) || {};
  check('результат фичи проброшен наружу', res === 'messages-result', 'res=' + JSON.stringify(res));
  check('email проброшен как есть', call.email === 'peer@x.ru', JSON.stringify(call.email));
  const d = call.deps || {};
  check('deps передан (не undefined) — ИМЕННО ЭТО падало на relay-пути', !!call.deps);
  check('deps: ровно 4 ключа messages.js',
    JSON.stringify(Object.keys(d).sort()) === JSON.stringify(
      ['findKnownPeerByKey', 'isOutboundLetter', 'resolveEventSender', 'resolvePeerSender']),
    JSON.stringify(Object.keys(d)));
  check('deps.isOutboundLetter — подлинная функция contacts.js', d.isOutboundLetter === realContacts.isOutboundLetter);
  check('deps.resolvePeerSender — подлинная функция contacts.js', d.resolvePeerSender === realContacts.resolvePeerSender);
  check('deps.resolveEventSender — подлинная функция contacts.js', d.resolveEventSender === realContacts.resolveEventSender);
  check('deps.findKnownPeerByKey — подлинная функция contacts.js', d.findKnownPeerByKey === realContacts.findKnownPeerByKey);
}

// ── 3. Анти-рот: контракт «App.vue и мост передают одно и то же» ─────
// App.vue в Node не импортируется (Vue SFC), поэтому сверяем состав deps с
// подписью фич: у обеих фич deps деструктурируются по именам — если фича
// получит лишний/недостающий ключ, проверки 1–2 выше упадут первыми.
console.log('\n3. Анти-рот: смоук не вырожден');
check('шпионы реально вызывались', incomingSpy.calls.length > 0 && messagesSpy.calls.length > 0,
  'incoming=' + incomingSpy.calls.length + ' messages=' + messagesSpy.calls.length);

// ── 4. J.4-фикс: ctx ВЫЗЫВАЮЩЕГО доезжает до фичи (а не подменяется проекцией) ──
// Регрессия 18c1eb7: мост подсовывал makeCtx() и фоновые циклы relay.js (эко,
// релей-тикер, поллинг, IDLE-резерв) работали МОЛЧА вхолостую — incoming.js:39
// делает early-return по !ctx.cryptoReady, которого в проекции нет.
console.log('\n4. ctx вызывающего доезжает (J.4-фикс)');
{
  const appCtx = { cryptoReady: true, email: 'me@x.ru', marker: 'caller-ctx' };
  await mailboxApi.processIncoming(['m2'], { notify: false }, appCtx);
  check('processIncoming: ctx передан как есть (identity)', incomingSpy.calls.at(-1).ctx === appCtx,
    'получено ключей: ' + Object.keys(incomingSpy.calls.at(-1).ctx || {}).length);
  await mailboxApi.loadMessages('peer@x.ru', appCtx);
  check('loadMessages: ctx передан как есть (identity)', messagesSpy.calls.at(-1).ctx === appCtx);
  // ВАЖНО: calls.at(-1) берёт ПОСЛЕДНИЙ вызов, а loadGroups идёт перед
  // loadGroupMessages. Проверка «loadGroups: ctx доехал» на at(-1) проверяла
  // СЛЕДУЮЩИЙ вызов — фиктивная проверка (декорация): сломанный loadGroups
  // проходил зелёным. Теперь у каждого вызова свой снимок.
  const gBeforeGroups = groupsSpy.calls.length;
  await mailboxApi.loadGroups(appCtx);
  const groupsCall = groupsSpy.calls[gBeforeGroups];
  check('loadGroups: ctx доехал как есть', groupsCall && groupsCall.ctx === appCtx);
  await mailboxApi.loadEmails(false, appCtx);
  const gBeforeGroupMsgs = groupsSpy.calls.length;
  await mailboxApi.loadGroupMessages('g1', false, appCtx);
  const groupMsgsCall = groupsSpy.calls[gBeforeGroupMsgs];
  check('loadGroupMessages: ctx доехал как есть + аргументы на месте',
    groupMsgsCall && groupMsgsCall.ctx === appCtx && groupMsgsCall.id === 'g1' && groupMsgsCall.force === false);
  check('loadEmails: ctx доехал как есть + silent на месте',
    emailsSpy.calls.at(-1).ctx === appCtx && emailsSpy.calls.at(-1).silent === false);
  // Без ctx — fallback-проекция (контракт сохранён, не падает).
  await mailboxApi.processIncoming(['m3'], {});
  const fallback = incomingSpy.calls.at(-1).ctx;
  check('без ctx работает fallback-проекция', fallback !== appCtx && typeof fallback.email === 'string');
  // Проекция обязана отдавать почту ВЛАДЕЛЬЦА сессии: без неё входящие
  // письма считались бы чужими (или не считались бы вовсе).
  check('fallback-проекция отдаёт email владельца сессии', fallback.email === 'me@x.ru', fallback.email);

  // Курсоры: мост обязан ходить в api, а не отдавать пустую заглушку.
  const cursors = await mailboxApi.loadCursors('acc-1');
  check('loadCursors возвращает значение api', cursors && cursors.INBOX === 'cursor-1', cursors);
  check('loadCursors спросил у api с тем же id',
    (globalThis.__cursorsLoaded || []).includes('acc-1'), globalThis.__cursorsLoaded);
  await mailboxApi.saveCursors('acc-1', { INBOX: 'cursor-2' });
  check('saveCursors дошёл до api', (globalThis.__cursorsSaved || []).some(([id, c]) => id === 'acc-1' && c.INBOX === 'cursor-2'),
    globalThis.__cursorsSaved);

  // Кэш тел: тело обязано попасть в mailboxStore, иначе входящее письмо
  // нельзя открыть (тело пришло, но не сохранено).
  mailboxApi.cacheBody('INBOX:9', 'тело');
  check('cacheBody пишет тело в mailboxStore',
    (globalThis.__cached || []).some(([k, b]) => k === 'INBOX:9' && b === 'тело'), globalThis.__cached);

  // Скролл: мост обязан отдавать установленный App.vue скроллер.
  let scrolled = 0;
  mailboxApi.setScroller(() => { scrolled += 1; });
  mailboxApi.scrollToBottom(true);
  check('setScroller подменяет скролл (вызов доходит)', scrolled === 1, scrolled);
}

// ── 5. Анти-рот по КЛАССУ: каждый вызов моста в relay.js обязан передавать ctx ──
// Именно этого не хватило 18c1eb7: подпись сменилась, а вызывающий — нет.
console.log('\n5. Анти-рот: вызовы моста в relay.js');
{
  // Исходник (не копия): статическая проверка вызовов моста в relay.js.
  const relaySrc = readModuleSource('src/features/relay.js');
  const re = /mailboxApi\.(processIncoming|loadMessages|loadGroups|loadEmails|loadGroupMessages)\(([^;]*?)\)/g;
  const calls = [...relaySrc.matchAll(re)];
  check('вызовы моста найдены (проверка не вырождена)', calls.length >= 5, 'найдено: ' + calls.length);
  const without = calls.filter(m => !/\bctx\b/.test(m[2]));
  check('каждый вызов моста в relay.js передаёт ctx', without.length === 0,
    without.map(m => m[1]).join(', '));
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
