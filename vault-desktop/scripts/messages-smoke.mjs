// Node-смоук features/messages.js — под-домен «сообщения 1:1» (ADR-001 домен 2).
// Мокаем api/crypto/db через tmp-модули. Без Vue/Tauri.
//
// С W2 (ADR-005) модуль не читает компонент: состояние настраивается у
// ВЛАДЕЛЬЦЕВ (chatStore/sessionStore/mailboxState/identityStore/contactsStore),
// per-app стор `chat`/`sending` и эффекты — явным deps.
//
// Цель: застраховать логику loadMessages: пир-ключ расшифровка, crypto-фильтр
// (чужие/1:1-не-наши), классификация (реакция/правка/квитанция/call/presence/
// голос опроса не рендерятся), envelope→text, дедуп, stale-guard.
import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { createChatStore } from '../src/chat-store.js';
import { createSendingStore } from '../src/features/sending-store.js';
import * as ContactsFeature from '../src/features/contacts.js';
// Владельцы состояния (ADR-004): те же синглтоны, что видит копия модуля.
import { chatStore, sessionStore } from '../src/features/session-store.js';
import { mailboxState } from '../src/features/mailbox-store.js';
import { identityStore } from '../src/features/identity-store.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/messages-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ADR-004: contacts-store грузит contacts-load.js, который на импорте читает
// localStorage. Стаб обязан стоять ДО его загрузки → импорт динамический.
globalThis.localStorage ||= {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; },
};
const { contactsStore } = await import('../src/features/contacts-store.js');

const apiMock = {
  bodies: {},
  fetchBodiesDbFirst: async (folder, uids) => {
    const out = {};
    for (const uid of uids) {
      const b = apiMock.bodies[folder + ':' + uid];
      if (b !== undefined) out[String(uid)] = b;
    }
    return out;
  },
  getMessages: async () => [],
  // Смена почты собеседника (fingerprint-матчинг) — фиксируем вызовы.
  calls: [],
  identityLetterFresh: async () => true,
  renamePeerIdentity: async (a, b) => { apiMock.calls.push(['rename', a, b]); },
  bumpIdentityRenameTs: async (k, ts) => { apiMock.calls.push(['bump', k, ts]); },
  saveProfile: async (...a) => { apiMock.calls.push(['saveProfile', ...a]); },
  removeContact: async (e) => { apiMock.calls.push(['removeContact', e]); },
  deleteProfile: async (e) => { apiMock.calls.push(['deleteProfile', e]); },
};
const dbMock = { kv: {}, kvGet: async (ns, k) => (dbMock.kv[k] ?? null), kvSet: async (ns, k, v) => { dbMock.kv[k] = v; } };
const cryptoMock = {
  publicKey: 'MYPUB',
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  decryptVault: null,       // назначается тестом
  setPeerPublicKey: () => {},
  removePeerKey: async (e) => { apiMock.calls.push(['removePeerKey', e]); },
};
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
// Мок presence.js — контракт приёма heartbeat (ADR-005 R3): на вход СВЯЗАННАЯ
// функция отметки (не компонент), решение «это presence?» — внутри presence.js.
// Мок повторяет решение честно: без него «поглощение» сигнала проверять
// нечем, а тест-обманка (mock всегда true) ничего не застраховывает.
writeFileSync(MOCKS + '/presence.js',
  'export const ingestSignal = (noteSeen, robj, senderEmail, mailTs) => {' +
  '  globalThis.__presCalls.push({ noteSeen, robj, senderEmail, mailTs });' +
  '  if (!robj || robj.presence !== 1) return false;' +
  '  noteSeen(senderEmail, mailTs);' +
  '  return true;' +
  '}');
globalThis.__apiMock = apiMock; globalThis.__dbMock = dbMock; globalThis.__cryptoMock = cryptoMock;
globalThis.__presCalls = [];

prepareModuleCopy(
  ROOT + '/src/features/messages.js',
  MOCKS + '/messages.mjs',
  {
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    './presence.js': 'presence.js',
  },
  MOCKS,
);
const M = await import(MOCKS + '/messages.mjs');

const MSGS_DEPS = {
  isOutboundLetter: ContactsFeature.isOutboundLetter,
  resolvePeerSender: ContactsFeature.resolvePeerSender,
  resolveEventSender: ContactsFeature.resolveEventSender,
  findKnownPeerByKey: ContactsFeature.findKnownPeerByKey,
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Состояние мира — через владельцев, как в проде.
function resetWorld({ activeChat = 'peer@x.ru', email = 'me@x.ru', emails = [],
                      peerKeys = { 'peer@x.ru': 'PUB' }, peerPqKeys = {},
                      aliases = {} } = {}) {
  chatStore.setActiveChat(activeChat);
  sessionStore.setCurrentEmail(email);
  mailboxState.state.emails = emails;
  mailboxState.state.emailBodyCache = {};
  identityStore.state.peerKeys = peerKeys;
  identityStore.state.peerPqKeys = peerPqKeys;
  contactsStore.state.contactAliases = aliases;
  apiMock.calls.length = 0;
  apiMock.bodies = {};
}

// Эффекты и per-app владельцы — явным контрактом. Счётчики: проверяем ИМЕННО
// эффекты, а не «что-то произошло».
function makeDeps(over = {}) {
  const deps = {
    ...MSGS_DEPS,
    chat: createChatStore(),
    sending: createSendingStore(),
    loadSeq: 1,
    getLoadSeq: () => deps.loadSeq,
    cryptoReady: true,
    profiles: () => ({}),
    isOwnSender: (sid) => sid === 'me@x.ru',
    isIgnored: () => false,
    aliasesOf: (e) => [String(e).toLowerCase()],
    historyFirst: [],
    showHistoryFirst: async (chatKey) => { deps.historyFirst.push(chatKey); },
    mergeHistory: async (chatKey, list) => list,
    mergePending: (chatKey, list) => list,
    filterDeleted: (l) => l,
    applyReactions: () => {},
    applyEdits: () => {},
    applyPollVotesCalls: [],
    applyPollVotes: (list, wire) => { deps.applyPollVotesCalls.push(wire); },
    parseCallSignal: () => null,
    parsePollEnvelope: () => null,
    scheduleEphemeral: () => {},
    saveChatCacheCalls: [],
    saveChatCache: (chatKey, list) => { deps.saveChatCacheCalls.push([chatKey, list.length]); },
    saveCurrentHistoryCalls: [],
    saveCurrentHistory: (chatKey) => { deps.saveCurrentHistoryCalls.push(chatKey); },
    cacheBodyCalls: [],
    cacheBody: (k, b) => { deps.cacheBodyCalls.push([k, b]); },
    receipts: [],
    sendReadReceipts: (ids) => { deps.receipts.push(ids); },
    noteSeen: () => {},
    loadProfilesCalls: 0,
    loadProfiles: () => { deps.loadProfilesCalls++; },
    setPeerKeyCalls: [],
    setPeerKey: (e, k, pq) => { deps.setPeerKeyCalls.push([e, k, pq]); },
    migratePeerGroups: async (a, b) => { apiMock.calls.push(['migratePeerGroups', a, b]); },
    migrateChatHistoryChain: async (a, b, c) => { apiMock.calls.push(['migrateChain', a, b, c]); },
    ...over,
  };
  return deps;
}

const mail = (content, fromAddr, mid, uid) => ({
  content, from: fromAddr, to: 'me@x.ru',
  message_id: mid || '<m@x>', uid: uid || 1, folder: 'INBOX',
  date: '2026-01-01T00:00:00Z',
});
// Тело письма по 'folder:uid' — состояние владельца mailboxState.
function withBody(msg, body) {
  mailboxState.state.emailBodyCache[(msg.folder || 'INBOX') + ':' + (msg.uid || msg.id)] = body;
}

// ── 1. crypto-фильтр: не расшифровалось = чужое ───────────────
console.log('1. crypto-фильтр: не-Vault письмо отбрасывается');
{
  cryptoMock.decryptVault = async () => { throw new Error('AAD mismatch'); };
  const m = mail('ENC:foreign', 'peer@x.ru', '<f@x>', 1);
  resetWorld({ emails: [m] });
  withBody(m, 'ENC:foreign');
  const d = makeDeps();
  await M.loadMessages(d, 'peer@x.ru');
  check('не расшифровалось → не рендерится (список пуст)', d.chat.state.messages.length === 0);
}

// ── 2. конверт-сообщение от пира ──────────────────────────────
console.log('2. конверт {vault:1,text} от собеседника рендерится');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1, id: 'ev1', text: 'привет!' });
  const m = mail('ENC:1', 'peer@x.ru', '<a@x>', 1);
  resetWorld({ emails: [m] });
  withBody(m, 'ENC:1');
  const d = makeDeps();
  await M.loadMessages(d, 'peer@x.ru');
  const msg = d.chat.state.messages[0];
  check('сообщение отрисовано: content=текст конверта, from=them, id=ev1',
    d.chat.state.messages.length === 1 && msg.content === 'привет!' && msg.from === 'them' && msg.id === 'ev1');
  check('история/кэш чата записаны по ключу чата',
    d.saveCurrentHistoryCalls[0] === 'peer@x.ru' && d.saveChatCacheCalls[0] && d.saveChatCacheCalls[0][0] === 'peer@x.ru');
  check('профили подгружены, тело взято из кэша владельца (без cacheBody)',
    d.loadProfilesCalls === 1 && d.cacheBodyCalls.length === 0,
    [d.loadProfilesCalls, d.cacheBodyCalls]);
  check('квитанции «просмотрено» отправлены по входящим', d.receipts.length === 1 && d.receipts[0].length === 1);
}

// ── 2b. тела докачиваются батчем и кэшируются через deps ──────
console.log('2b. докачка тел: fetchBodiesDbFirst → cacheBody');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1, id: 'ev2', text: 'из ящика' });
  const m = mail('ENC:2', 'peer@x.ru', '<b@x>', 7);
  resetWorld({ emails: [m] });          // кэш тела ПУСТ
  apiMock.bodies['INBOX:7'] = 'ENC:2';
  const d = makeDeps();
  await M.loadMessages(d, 'peer@x.ru');
  check('тело докачано и положено во владельца через cacheBody',
    d.cacheBodyCalls.length === 1 && d.cacheBodyCalls[0][0] === 'INBOX:7' && d.cacheBodyCalls[0][1] === 'ENC:2',
    d.cacheBodyCalls);
  check('письмо расшифровано из докачанного тела', d.chat.state.messages[0] && d.chat.state.messages[0].content === 'из ящика');
}

// ── 3. классификация: реакция/квитанция НЕ рендерятся ─────────
console.log('3. реакция/квитанция/edit/call НЕ рендерятся как сообщения');
{
  cryptoMock.decryptVault = async (body) => {
    if (body === 'ENC:r') return JSON.stringify({ react: 1, msg_id: 'X', emoji: '🔥' });
    if (body === 'ENC:k') return JSON.stringify({ read: 1, msg_ids: ['Y'] });
    if (body === 'ENC:c') return JSON.stringify({ vault: 1, type: 'call_request', call_id: 'c1' });
    return null;
  };
  const m1 = mail('ENC:r', 'peer@x.ru', '<r@x>', 1);
  const m2 = mail('ENC:k', 'peer@x.ru', '<k@x>', 2);
  const m3 = mail('ENC:c', 'peer@x.ru', '<c@x>', 3);
  resetWorld({ emails: [m1, m2, m3] });
  withBody(m1, 'ENC:r'); withBody(m2, 'ENC:k'); withBody(m3, 'ENC:c');
  const d = makeDeps({
    parseCallSignal: (t) => {
      try { const o = JSON.parse(t); return (o && o.type === 'call_request') ? o : null; } catch (e) { return null; }
    },
  });
  await M.loadMessages(d, 'peer@x.ru');
  check('реакция/квитанция/call не дали карточек (список пуст)', d.chat.state.messages.length === 0);
}

// ── 4. stale-guard ────────────────────────────────────────────
console.log('4. stale-guard: чат переключили → messages не перезаписаны');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1, id: 'evX', text: 't' });
  const m = mail('ENC:x', 'peer@x.ru', '<x@x>', 1);
  resetWorld({ emails: [m] });
  withBody(m, 'ENC:x');
  const d = makeDeps();
  d.chat.set(['KEEP']);
  // Переключение чата ВНУТРИ загрузки: модуль обязан прочитать activeChat
  // живо (у владельца), а не снимком на входе.
  d.showHistoryFirst = async () => { chatStore.setActiveChat('other@x.ru'); };
  await M.loadMessages(d, 'peer@x.ru');
  check('stale по activeChat → messages не тронуты (KEEP)',
    Array.isArray(d.chat.state.messages) && d.chat.state.messages[0] === 'KEEP');

  // Токен загрузки читается ВНУТРИ stale(), то есть живьём: роста loadSeq
  // посреди фетча достаточно, чтобы результат не применился.
  resetWorld({ emails: [m] });
  withBody(m, 'ENC:x');
  const d2 = makeDeps();
  d2.chat.set(['KEEP2']);
  d2.showHistoryFirst = async () => { d2.loadSeq = 99; };
  await M.loadMessages(d2, 'peer@x.ru');
  check('loadSeq вырос посреди загрузки → messages не тронуты (KEEP2)',
    d2.chat.state.messages[0] === 'KEEP2');
}

// ── 5. голос опроса — сигнал, не сообщение (дефект: ContactsFeature) ──
console.log('5. голос опроса: агрегируется в applyPollVotes, в чат не попадает');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ poll: 1, poll_id: 'P1', option: 2 });
  const m = mail('ENC:p', 'peer@x.ru', '<p@x>', 1);
  resetWorld({ emails: [m] });
  withBody(m, 'ENC:p');
  const d = makeDeps();
  await M.loadMessages(d, 'peer@x.ru');
  const wire = d.applyPollVotesCalls[0] || {};
  check('голос классифицирован (applyPollVotes получил P1/option=2)',
    !!wire.P1 && wire.P1.length === 1 && wire.P1[0].option === 2, wire);
  check('голос НЕ отрисован как сообщение', d.chat.state.messages.length === 0);
  check('отправитель голоса разрешён (не ReferenceError)', !!wire.P1 && wire.P1[0].voter === 'peer@x.ru', wire.P1 && wire.P1[0]);
}

// ── 6. presence-heartbeat: сигнал, не сообщение ────────────────
console.log('6. presence-heartbeat: поглощён, активность отмечена, в чат не попал');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ presence: 1, ts: 123 });
  const m = mail('ENC:hb', 'peer@x.ru', '<hb@x>', 1);
  resetWorld({ emails: [m] });
  withBody(m, 'ENC:hb');
  const seen = [];
  const d = makeDeps({ noteSeen: (e, ts) => { seen.push([e, ts]); } });
  globalThis.__presCalls = [];
  await M.loadMessages(d, 'peer@x.ru');
  const call = globalThis.__presCalls[0];
  // РЕГРЕСС: раньше здесь стояло ingestSignal(ctx, ...) — ctx в модуле не
  // существует → ReferenceError гасился catch'ом → heartbeat доезжал до чата
  // СЫРЫМ JSON. Проверка ловит именно это (не «что-то произошло»).
  check('presence не отрисован как сообщение (было: ReferenceError → JSON в чате)',
    d.chat.state.messages.length === 0,
    d.chat.state.messages.map((x) => x.content));
  check('активность отмечена: noteSeen получил отправителя',
    seen.length === 1 && seen[0][0] === 'peer@x.ru', seen);
  check('в presence ушла связанная функция отметки, а не компонент (нет ctx)',
    !!call && typeof call.noteSeen === 'function' && call.robj && call.robj.presence === 1);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
