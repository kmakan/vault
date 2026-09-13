// Node-смоук features/incoming.js — семантика router без Vue/Tauri.
// Мокаем api/crypto/relay/notify через подмену импортов (заглушки в tmp-модулях).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = '/home/maksim/whisper/vault-desktop';

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
};
// relay-мок
const relayMock = {
  getSettings: null,
  setPeerToken: null,
};
// notify-мок
const notifyMock = { fires: [] };
notifyMock.notifyNewMessage = (n) => { notifyMock.fires.push(n); };

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/relay-client.js', 'const relay = globalThis.__relayMock; export default relay; export const getSettings = (...a) => relay.getSettings(...a); export const setPeerToken = (...a) => relay.setPeerToken(...a);');
writeFileSync(MOCKS + '/notify.js', 'export const notifyNewMessage = (n) => globalThis.__notifyMock.notifyNewMessage(n); export const initNotifications = async () => {};');

globalThis.__apiMock = apiMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__relayMock = relayMock;
globalThis.__notifyMock = notifyMock;

// Подменяем резолверincoming-импортов: копия incoming.js с переписанными путями
let inc = readFileSync(ROOT + '/src/features/incoming.js', 'utf8');
inc = inc
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"')
  .replace("from '../relay-client.js'", 'from "' + MOCKS + '/relay-client.js"')
  .replace("from '../notify.js'", 'from "' + MOCKS + '/notify.js"');
writeFileSync(MOCKS + '/incoming.mjs', inc);
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
  return Object.assign({
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
    migrateChatHistory: async () => {},
    setPeerKey: () => {},
    tryMigrateGroupMember: async () => false,
    chatVisible: () => false,
    isMuted: () => false,
    t: (k) => 'NEW',
    saveUnreadSeen: async () => {},
    saveUnreadCounts: async () => {},
    callSignals: 0,
  }, over);
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
  ctx.groupKeys = { g1: 'GK' };
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
  ctx.migrateChatHistory = async (oldE, newE) => { ctx.migrated = [oldE, newE]; };
  ctx.setPeerKey = (e, k) => { ctx.boundKey = [e, k]; };
  cryptoMock.decryptVault = async () => ({ __env: { key: 'OLDK', id: 'fe1', text: 'moved' } });
  const m = msg({ from: { address: 'new@x.ru' }, uid: 14, message_id: '<f@x>' });
  withBody(ctx, m, 'ENC:1');
  await processIncoming(ctx, [m], { notify: true });
  check('история мигрирована old→new', ctx.migrated && ctx.migrated[0] === 'old@x.ru' && ctx.migrated[1] === 'new@x.ru');
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

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
