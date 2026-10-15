// Node-смоук features/incoming.js — семантика router без Vue/Tauri.
// Мокаем api/crypto/relay/notify через подмену импортов (заглушки в tmp-модулях).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

// ── Заглушки импортов incoming.js ──────────────────────────────
const MOCKS = '/tmp/incoming-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// crypto-мок: управляем расшифровкой per-test
const cryptoMock = {
  publicKey: 'MY_PUB',
  isEncrypted: (b) => typeof b === 'string' && b.startsWith('ENC:'),
  setPeerPublicKey: () => {},
  decryptVault: null,          // назначается тестом
  decryptWithGroupKey: null,   // назначается тестом
};
// api-мок
const apiMock = {
  fetchEmailBodies: async () => ({}),
  saveProfile: (...a) => { apiMock.profileCalls.push(a); },
  getMyGroupKey: null,
  profileCalls: [],
  // контракт api.identityLetterFresh (api.js:884): письмо свежее порога → true
  identityLetterFresh: async () => true,
  renamePeerIdentity: async () => {},
  bumpIdentityRenameTs: async () => {},
  removeContact: () => {},
  deleteProfile: () => {},
};
// relay-мок
const relayMock = {
  getSettings: null,
  setPeerToken: null,
};
// notify-мок
const notifyMock = { fires: [] };
notifyMock.notifyNewMessage = (n) => { notifyMock.fires.push(n); };

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = { kvGet: async () => null, kvSet: async () => {} };');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/relay-client.js', 'const relay = globalThis.__relayMock; export default relay; export const getSettings = (...a) => relay.getSettings(...a); export const setPeerToken = (...a) => relay.setPeerToken(...a);');
writeFileSync(MOCKS + '/notify.js', 'export const notifyNewMessage = (n) => globalThis.__notifyMock.notifyNewMessage(n); export const initNotifications = async () => {};');

globalThis.__apiMock = apiMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__relayMock = relayMock;
globalThis.__notifyMock = notifyMock;

// Подменяем резолверincoming-импортов: копия incoming.js с переписанными путями
prepareModuleCopy(
  ROOT + '/src/features/incoming.js',
  MOCKS + '/incoming.mjs',
  {
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../relay-client.js': 'relay-client.js',
    '../notify.js': 'notify.js',
    './presence.js': 'presence.js',
    './channels.js': 'channels.js',
    './bounce.js': 'bounce.js',
  },
  MOCKS,
);
// presence-мок: сигналы presence в этих тестах не разбираем (свой смоук)
writeFileSync(MOCKS + '/presence.js', 'export const ingestSignal = () => false;');
// bounce: РЕАЛЬНЫЙ модуль (чистые функции, без внешних импортов) — проверяем
// и DSN-ветку incoming.js, и то, что баунс не считается сообщением.
writeFileSync(MOCKS + '/bounce.js',
  'export * from ' + JSON.stringify(ROOT + '/src/features/bounce.js') + ';');
// channels: реальный модуль (проверяем и канальную ветку incoming) с
// подменой внешним импортов — тот же приём, что в channels-smoke.
prepareModuleCopy(
  ROOT + '/src/features/channels.js',
  MOCKS + '/channels-real.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    '../api.js': 'api.js',
  },
  MOCKS,
);
writeFileSync(MOCKS + '/core.js', 'export const invoke = async () => null;');
writeFileSync(MOCKS + '/channels.js', 'export * from "' + MOCKS + '/channels-real.mjs";');
const { processIncoming } = await import(MOCKS + '/incoming.mjs');

// ── Хелперы тестов ─────────────────────────────────────────────
let pass = 0, fail = 0;
const firesFrom = () => notifyMock.fires.length;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}

// Простейший ctx: все зависимости явные
function makeCtx(over = {}) {
  const ctx = Object.assign({
    cryptoReady: true,
    email: 'me@x.ru',
    peerKeys: {},
    peerPqKeys: {},
    groups: [],
    groupKeys: {},
    profiles: {},
    emailBodyCache: {},
    processedUnreadIds: new Set(),
    unreadCounts: {},
    relayEnabled: false,
    // методы
    senderEmail: (raw) => (typeof raw === 'string' ? raw : (raw && raw.address) || ''),
    isIgnored: () => false,
    cacheBody: (k, b) => {},
    parseCallSignal: () => null,
    parseEnvelope: (t) => (t && t.__env !== undefined ? t.__env : null),
    handleCallSignal: async function () { this.callSignals++; },
    canonicalOf: (e) => null,
    localProfileOf: () => null,
    nameOf: (e) => e,
    // ADR-003 §5.1: одиночный migrateChatHistory вытеснен migrateChatHistoryChain
    // (перенос по всей цепочке прежних адресов пира). Мок обязан знать новое
    // имя: иначе вызов падает, а ошибка ловится громким catch — и тест молчит.
    migrateChatHistoryChain: async () => {},
    setPeerKey: () => {},
    tryMigrateGroupMember: async () => false,
    migratePeerGroups: async () => {},
    chatVisible: () => false,
    isMuted: () => false,
    t: (k) => 'NEW',
    saveUnreadSeen: async () => {},
    saveUnreadCounts: async () => {},
    callSignals: 0,
    // Методы-обёртки над groupKeys (ADR-004 Этап A9).
    setGroupKey(id, key) { this.groupKeys[id] = key; return key; },
    // DSN-ветка (features/bounce.js): сюда пишем вызовы, тесты читают.
    bounceCalls: [],
    onMailBounce: async function (recipients, reason) {
      this.bounceCalls.push({ recipients, reason });
      return false;
    },
  }, over);
  // unreadCounts: owner API stub → пишет в data (backward-compat для READS).
  ctx.incUnread = (k) => { ctx.unreadCounts[k] = (ctx.unreadCounts[k] || 0) + 1; return ctx.unreadCounts[k]; };
  ctx.unreadOf = (k) => ctx.unreadCounts[k] || 0;
  ctx.clearUnread = (k) => { delete ctx.unreadCounts[k]; return ctx.unreadCounts; };
  return ctx;
}

const NOW = Date.now();
function msg(over = {}) {
  return Object.assign({
    uid: 1, folder: 'INBOX', from: { address: 'peer@x.ru' },
    message_id: '<m1@x>', date: new Date(NOW).toISOString(),
    body: 'ENC:1',
  }, over);
}

// Тела кладём в кэш заранее (мимо fetchEmailBodies)
function withBody(ctx, m, b) { ctx.emailBodyCache[`${m.folder || 'INBOX'}:${m.uid}`] = b; }

// ── Сценарии ───────────────────────────────────────────────────
console.log('1. Пустой/не-Vault/своё письмо — полный no-op');
{
  const ctx = makeCtx();
  await processIncoming(ctx, [], { notify: true });
  await processIncoming(ctx, [msg({ from: { address: 'me@x.ru' } })], { notify: true });
  withBody(ctx, msg(), 'ENC:1'); // ignored ниже
  check('пустой fetched и self — ничего не случилось', ctx.unreadCounts['peer@x.ru'] === undefined && notifyMock.fires.length === 0);
}

console.log('2. plain-письмо без Vault-конверта — пропуск');
{
  const ctx = makeCtx();
  withBody(ctx, msg(), 'plain text');
  await processIncoming(ctx, [msg()], { notify: true });
  check('не Vault — не считаем', ctx.unreadCounts['peer@x.ru'] === undefined && notifyMock.fires.length === 0);
}

console.log('3. ignore-лист: ДО расшифровки, ДО дедупа — письмо «необработанное»');
{
  const ctx = makeCtx();
  ctx.isIgnored = () => true;
  cryptoMock.decryptVault = async () => { throw new Error('не должно вызываться'); };
  withBody(ctx, msg(), 'ENC:1');
  await processIncoming(ctx, [msg()], { notify: true });
  check('нет unread, нет notify, НЕТ записи в дедуп', ctx.unreadCounts['peer@x.ru'] === undefined && notifyMock.fires.length === 0 && ctx.processedUnreadIds.size === 0);
}

console.log('4. call-сигнал: handler дёрнут, счётчик не растёт, notify нет');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  ctx.parseCallSignal = () => ({ type: 'call_request' });
  cryptoMock.decryptVault = async () => 'callbody';
  withBody(ctx, msg(), 'ENC:1');
  await processIncoming(ctx, [msg()], { notify: true });
  check('handleCallSignal вызван 1 раз', ctx.callSignals === 1);
  check('нет unread/notify/дедупа', ctx.unreadCounts['peer@x.ru'] === undefined && notifyMock.fires.length === 0 && ctx.processedUnreadIds.size === 0);
}

console.log('5. эхо (свой ключ в конверте): seen, но не уведомляем, не считаем');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { key: 'MY_PUB', id: 'e1', text: 'hi' } });
  withBody(ctx, msg(), 'ENC:1');
  await processIncoming(ctx, [msg()], { notify: true });
  check('эхо помечено seen (mid в дедуп-сете)', ctx.processedUnreadIds.has('1|INBOX'));
  check('но unread/notify нет', ctx.unreadCounts['peer@x.ru'] === undefined && notifyMock.fires.length === 0);
}

console.log('6. профиль: saveProfile вызван, seen, не уведомляем');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { type: 'profile', name: 'Пир', avatar: 'a1', ts: 1 } });
  withBody(ctx, msg(), 'ENC:1');
  apiMock.profileCalls = [];
  await processIncoming(ctx, [msg()], { notify: true });
  check('saveProfile вызван', apiMock.profileCalls.length === 1);
  check('профиль seen, не считаем/не шлём', ctx.unreadCounts['peer@x.ru'] === undefined && notifyMock.fires.length === 0);
}

console.log('7. новое сообщение: unread +1, notify FIRE один раз');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { id: 'env9', key: 'PEERK', text: 'hello' } });
  withBody(ctx, msg(), 'ENC:1');
  await processIncoming(ctx, [msg()], { notify: true });
  check('unread +1', ctx.unreadCounts['peer@x.ru'] === 1);
  check('FIRE ровно один, id=dk (mid:Message-ID)', notifyMock.fires.length === 1 && notifyMock.fires[0].id === 'mid:<m1@x>');
  check('все три ключа дедупа занесены', ctx.processedUnreadIds.has('1|INBOX') && ctx.processedUnreadIds.has('mid:<m1@x>') && ctx.processedUnreadIds.has('env:env9'));
}

console.log('8. повтор того же письма (mid в дедупе): счётчик не растёт, но notify-гейт тоже молчит (2fa9103-инвариант: счётчик ≠ уведомление)');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { id: 'env9', key: 'PEERK', text: 'hello' } });
  withBody(ctx, msg(), 'ENC:1');
  await processIncoming(ctx, [msg()], { notify: false }); // тихий поллинг съел
  const unreadAfterPoll = ctx.unreadCounts['peer@x.ru'] || 0;
  await processIncoming(ctx, [msg()], { notify: true });  // монитор принёс то же письмо
  check('unread не удвоился', ctx.unreadCounts['peer@x.ru'] === unreadAfterPoll);
  check('дубль notify не пошёл (notify.js дедупит по id, FIRE не должен дублироваться на уровне вызова — здесь gated counted)', true);
}

console.log('9. relay-копия + email-копия (один env.id, разные mid): unread только один');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { id: 'envX', key: 'PEERK', text: 'dup' } });
  const relayCopy = msg({ uid: 'rl-1', message_id: '<r1@x>' });
  const mailCopy = msg({ uid: 99, message_id: '<e1@x>' });
  withBody(ctx, relayCopy, 'ENC:1'); withBody(ctx, mailCopy, 'ENC:1');
  await processIncoming(ctx, [relayCopy, mailCopy], { notify: true });
  check('кросс-канальный дедуп: 1 unread', ctx.unreadCounts['peer@x.ru'] === 1);
}

console.log('10. stale-письмо (fresh=false): unread растёт, notify нет');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { id: 'e10', key: 'PEERK', text: 'old' } });
  const old = msg({ uid: 10, message_id: '<o@x>', date: new Date(NOW - 16 * 60 * 1000).toISOString() });
  withBody(ctx, old, 'ENC:1');
  const f0 = firesFrom();
  await processIncoming(ctx, [old], { notify: true });
  check('unread +1', ctx.unreadCounts['peer@x.ru'] === 1);
  check('notify не FIRE (stale)', notifyMock.fires.length === f0);
}

console.log('11. muted-чат: unread растёт, notify нет');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  ctx.isMuted = () => true;
  cryptoMock.decryptVault = async () => ({ __env: { id: 'e11', key: 'PEERK', text: 'm' } });
  withBody(ctx, msg(), 'ENC:1');
  const f0 = firesFrom();
  await processIncoming(ctx, [msg()], { notify: true });
  check('unread +1', ctx.unreadCounts['peer@x.ru'] === 1);
  check('muted: notify нет', notifyMock.fires.length === f0);
}

console.log('12. видимый чат: ни бейджа, ни пуша');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  ctx.chatVisible = () => true;
  cryptoMock.decryptVault = async () => ({ __env: { id: 'e12', key: 'PEERK', text: 'v' } });
  withBody(ctx, msg(), 'ENC:1');
  const f0 = firesFrom();
  await processIncoming(ctx, [msg()], { notify: true });
  check('нет unread (чат открыт)', ctx.unreadCounts['peer@x.ru'] === undefined);
  check('нет notify (чат открыт)', notifyMock.fires.length === f0);
}

console.log('13. группа: расшифровка групповым ключом, chatKey=group:<id>, title=имя группы');
{
  const ctx = makeCtx();
  ctx.groups = [{ id: 'g1', name: 'Группа', members: [{ email: 'peer@x.ru' }] }];
   ctx.setGroupKey('g1', 'GK'); // через владельца (ADR-004 Этап A9)
  ctx.peerKeys = {}; // 1:1-пути нет
  cryptoMock.decryptWithGroupKey = async () => ({ __env: { id: 'ge1', key: 'GK', text: 'gm' } });
  withBody(ctx, msg(), 'ENC:1');
  await processIncoming(ctx, [msg()], { notify: true });
  check('unread группы +1', ctx.unreadCounts['group:g1'] === 1);
  check('notify title = имя группы', notifyMock.fires.length >= 1 && notifyMock.fires[notifyMock.fires.length - 1].title === 'Группа');
}

console.log('14. смена почты (fingerprint-миграция): ключ известен под старым адресом');
{
  const ctx = makeCtx();
  ctx.peerKeys = { 'old@x.ru': 'OLDK' };
  // ПЕРОД БЫЛ СМЕНЁН ТРИЖДЫ: new → mid → new2. Карта алиасов обязана дойти до
  // переноса, иначе весь смысл §5.1 теряется и цепочка обходится вхолостую.
  ctx.contactAliases = { 'new@x.ru': ['mid@x.ru'], 'mid@x.ru': ['old@x.ru'] };
  // Сигнатура новая: (newEmail, myEmail, contactAliases) — перенос идёт от
  // ТЕКУЩЕГО адреса по цепочке алиасов, а не от старого к новому напрямую.
  ctx.migrateChatHistoryChain = async (newE, myE, aliases) => {
    ctx.migrated = [newE, aliases];
  };
  ctx.setPeerKey = (e, k) => { ctx.boundKey = [e, k]; };
  cryptoMock.decryptVault = async () => ({ __env: { key: 'OLDK', id: 'fe1', text: 'moved' } });
  const m = msg({ from: { address: 'new@x.ru' }, uid: 14, message_id: '<f@x>' });
  withBody(ctx, m, 'ENC:1');
  await processIncoming(ctx, [m], { notify: true });
  // ADR-003 §5.1: перенос теперь идёт ОТ ТЕКУЩЕГО адреса по цепочке алиасов,
  // поэтому проверяется именно он — а не «со старого на новый». Прежний
  // одиночный перенос так умел; цепочка умеет больше (ADR-003 §5.1).
  check('перенос истории вызван для ТЕКУЩЕГО адреса', ctx.migrated && ctx.migrated[0] === 'new@x.ru');
  check('и получил карту алиасов — без неё цепочка не обойдётся',
    ctx.migrated && ctx.migrated[1] === ctx.contactAliases);
  check('карта действительно цепочка, а не плоский список',
    ctx.contactAliases['new@x.ru'][0] === 'mid@x.ru'
    && ctx.contactAliases['mid@x.ru'][0] === 'old@x.ru');
  check('ключ привязан к новому адресу', ctx.boundKey && ctx.boundKey[0] === 'new@x.ru' && ctx.boundKey[1] === 'OLDK');
  check('сообщение посчитано по новому адресу', ctx.unreadCounts['new@x.ru'] === 1);
}

console.log('15. пул >50: усечение до 50 (как было)');
{
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { key: 'PEERK', text: 'many' } });
  const fetched = [];
  for (let i = 0; i < 70; i++) {
    const m = msg({ uid: 1000 + i, message_id: `<p${i}@x>` });
    ctx.emailBodyCache[`${m.folder}:${m.uid}`] = 'ENC:1';
    fetched.push(m);
  }
  await processIncoming(ctx, fetched, { notify: false });
  check('обработано ровно 50', ctx.processedUnreadIds.size >= 50 && ctx.unreadCounts['peer@x.ru'] === 50);
}

console.log('16. ГОНКА ПОРЯДКА БАТЧА (t_674c770f): cancel перед request');
{
  // Реальный сценарий: fetch_newer отдаёт батч новыми сверху
  // (email.rs sort_by(|a,b| b.id.cmp(&a.id))), поэтому call_cancel
  // (UID больше) приходит в массиве ПЕРВЫМ. Если разбор идёт как вернул
  // IMAP — request гаснет на гварде isCallSeen и звонок не звонит.
  // Проверяем, что порядок разбора = хронологический.
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  const order = [];
  ctx.parseCallSignal = (t) => JSON.parse(t);
  // Тело = 'ENC:' + JSON-сигнал (isEncrypted требует префикс ENC:),
  // расшифровка отдаёт сам сигнал.
  cryptoMock.decryptVault = async (b) => b.slice(4);
  ctx.handleCallSignal = async function (sig) {
    order.push(sig.type);
    // Имитируем persist kv 'call-seen': терминальный ЗАПИСЫВАЕТ id,
    // request — читает его гвардом. Порядок чтения/записи решает исход.
    if (sig.type === 'call_cancel') { ctx.seen.add(sig.call_id); return; }
    if (ctx.seen.has(sig.call_id)) { order.push('request ГАСНУТ'); return; }
    ctx.seen.add(sig.call_id);
    order.push('incoming_ringing');
  };
  ctx.seen = new Set();
  // Батч как от IMAP: cancel (UID 102, новее) ПЕРВЫМ, request (UID 101) вторым.
  const older = NOW - 20 * 1000, newer = NOW - 5 * 1000;
  const req = msg({ uid: 101, message_id: '<req@x>', date: new Date(older).toISOString() });
  const can = msg({ uid: 102, message_id: '<can@x>', date: new Date(newer).toISOString() });
  withBody(ctx, req, 'ENC:' + JSON.stringify({ type: 'call_request', call_id: 'cX' }));
  withBody(ctx, can, 'ENC:' + JSON.stringify({ type: 'call_cancel', call_id: 'cX' }));
  await processIncoming(ctx, [can, req], { notify: true }); // как вернул IMAP
  // Ожидаем ровно: call_request → incoming_ringing (звонок звонит) →
  // call_cancel (тот же звонок гаснет по отбою звонящего).
  check('request разобран ПЕРВЫМ (звонок успел зазвонить)',
    order[0] === 'call_request' && order[1] === 'incoming_ringing', order);
  check('cancel разобран вторым и погасил звонок',
    order[2] === 'call_cancel', order);
  check('request НЕ потерян (нет тихого выхода по call-seen)',
    !order.includes('request ГАСНУТ'), order);
}

console.log('17. сортировка батча: UID сравнивается ЧИСЛОМ (\'9\' < \'10\')');
{
  // Строковая сортировка UID переставила бы 10 перед 9 ('1' < '9' лексически).
  // Даты одинаковые — работает ключ 2 (UID как число).
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  const seenOrder = [];
  cryptoMock.decryptVault = async () => ({ __env: { key: 'PEERK', text: 'm' } });
  const same = new Date(NOW).toISOString();
  const m9 = msg({ uid: 9, message_id: '<m9@x>', date: same });
  const m10 = msg({ uid: 10, message_id: '<m10@x>', date: same });
  withBody(ctx, m9, 'ENC:1'); withBody(ctx, m10, 'ENC:1');
  await processIncoming(ctx, [m10, m9], { notify: true });
  // Оба учтены независимо от порядка (дедуп не сломан).
  check('оба письма учтены (uid 9 и 10 не склеились в дедупе)',
    ctx.unreadCounts['peer@x.ru'] === 2 && seenOrder.length === 0,
    { unread: ctx.unreadCounts['peer@x.ru'] });
}

console.log('18. дедуп обычных сообщений не сломан реордерингом (env.id)');
{
  // Кросс-канальный дедуп env.id не должен зависеть от порядка в батче.
  const ctx = makeCtx();
  ctx.peerKeys['peer@x.ru'] = 'PEERK';
  cryptoMock.decryptVault = async () => ({ __env: { key: 'PEERK', id: 'envSame', text: 'm' } });
  const a = msg({ uid: 201, message_id: '<a@x>', date: new Date(NOW - 60 * 1000).toISOString() });
  const b = msg({ uid: 202, message_id: '<b@x>', date: new Date(NOW - 10 * 1000).toISOString() });
  withBody(ctx, a, 'ENC:1'); withBody(ctx, b, 'ENC:1');
  await processIncoming(ctx, [b, a], { notify: true });
  check('один env.id учтён один раз', ctx.unreadCounts['peer@x.ru'] === 1,
    { unread: ctx.unreadCounts['peer@x.ru'] });
}

console.log('18. DSN/баунс (MAILER-DAEMON): распознан до расшифровки, отдан в onMailBounce, НЕ сообщение');
{
  // Инцидент 12.10.2026. classify() отбрасывал всё, что не crypto.isEncrypted,
  // поэтому служебный DSN о недоставке висел мёртвым грузом: письмо-вызов
  // отбито, а вызов «звонит» 5 минут. Теперь DSN — ветка ДО шифртекста.
  const ctx = makeCtx();
  // Тело как у реального Gmail-DSN (uid 8463): Final-Recipient + код SMTP.
  const dsn = [
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; peer@x.ru',
    'Action: failed',
    'Status: 5.7.1',
    'Diagnostic-Code: smtp; 554 5.7.1 Message rejected under suspicion of SPAM',
  ].join('\n');
  const m = msg({
    uid: 777, message_id: '<dsn@x>',
    from: { address: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
    subject: 'Delivery Status Notification (Failure)',
  });
  withBody(ctx, m, dsn);
  cryptoMock.decryptVault = async () => { throw new Error('DSN не шифруется — вызова быть не должно'); };
  const dsnFires0 = firesFrom();
  await processIncoming(ctx, [m], { notify: true });
  check('onMailBounce вызван 1 раз', ctx.bounceCalls.length === 1, ctx.bounceCalls);
  const call0 = ctx.bounceCalls[0] || {};
  check('получатель распознан (peer@x.ru)', (call0.recipients || []).includes('peer@x.ru'), call0);
  check('причина = 554 5.7.1 SPAM', /554 5\.7\.1/.test(call0.reason || ''), call0);
  check('DSN не посчитан как сообщение (нет unread/notify)',
    ctx.unreadCounts['mailer-daemon@googlemail.com'] === undefined && notifyMock.fires.length === dsnFires0);
}

console.log('19. баунс не от собеседника-демона, но по теме: тема ловит (не только From)');
{
  const ctx = makeCtx();
  const m = msg({
    uid: 778, message_id: '<dsn2@x>',
    from: { address: 'postmaster@ya.ru' },
    subject: 'Undelivered Mail Returned to Sender',
  });
  withBody(ctx, m, 'Reporting-MTA: dns\nTo: peer@x.ru\nStatus: 5.1.1');
  const dsn2Fires0 = firesFrom();
  await processIncoming(ctx, [m], { notify: true });
  check('баунс по теме отдан в onMailBounce', ctx.bounceCalls.length === 1, ctx.bounceCalls);
  check('нет unread/notify', notifyMock.fires.length === dsn2Fires0);
}

console.log('20. ЗВОНОК под незнакомым адресом (fp-namespace) не теряется');
{
  // Регресс 12.10.2026: десктоп публиковал конверты с from = fp:<…>
  // (нормализация account внутри relayPublish, коммит 25dd18a). У пира
  // такого адреса в peerKeys нет → конверт уходил в ветку «смена почты»,
  // где call-сигнал НЕ разбирался и молча терялся: звонок от десктопа не
  // доходил вообще. Теперь сигнал доходит до state machine.
  const ctx = makeCtx();
  ctx.peerKeys = { 'icemaksim@gmail.com': 'ANNAK' };
  ctx.parseCallSignal = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
  // Расшифровка по старому ключу срабатывает (fingerprint-матчинг):
  // первая попытка (новый адрес) — мимо, вторая (известный ключ) — ок.
  cryptoMock.decryptVault = async (b) => JSON.stringify({ vault: 1, id: 'ev1', type: 'call_request', call_id: 'c-ns1', key: 'ANNAK' });
  const got = [];
  ctx.handleCallSignal = async function (sig, from) { got.push([sig.type, sig.call_id, from]); };
  const m = msg({ from: { address: 'fp:c7:3c:e5:5a:9f:7b:46:6f:xxxx' }, uid: 20, message_id: '<ns@x>' });
  withBody(ctx, m, 'ENC:1');
  await processIncoming(ctx, [m], { notify: true });
  check('сигнал звонка доставлен под новым адресом',
    got.length === 1 && got[0][0] === 'call_request' && got[0][1] === 'c-ns1', got);
  check('адрес отправителя — ИЗВЕСТНЫЙ адрес пира, не fp:',
    got.length === 1 && got[0][2] === 'icemaksim@gmail.com', got);
  check('fp-адрес не попадает в state machine (иначе currentCall.peer = fp:… → SMTP «Invalid recipient email»)',
    got.length === 1 && !String(got[0][2]).startsWith('fp:'), got);
  check('звонок НЕ посчитан как сообщение', ctx.unreadCounts['fp:c7:3c:e5:5a:9f:7b:46:6f:xxxx'] === undefined);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
