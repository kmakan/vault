// Node-смоук features/groups.js — под-домен «групповые сообщения».
//
// ADR-005 W2 партия 5: модуль не читает компонент. Состояние — у владельцев
// (`chat`/`sending`/`groups` — per-app экземпляры; `activeChat` — chatStore,
// `emails` — mailboxState), эффекты — явный deps. Смоук собирает тот же
// контракт, что App.vue:loadGroupMessages.
//
// Цель: застраховать логику loadGroupMessages — no-group-key путь,
// классификацию (реакция/правка/квитанция/pin/poll/presence/meta/hav не
// рендерятся как сообщения), дедуп по id конверта, crypto-фильтр, stale-guard,
// ленивую догрузку ключа группы, запись аватара и пина в ВЛАДЕЛЬЦЕВ.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { installEnvelopeMock } from './lib/wire-envelope-mock.mjs';
import { createChatStore } from '../src/chat-store.js';
import { createSendingStore } from '../src/features/sending-store.js';
import { createGroupsStore } from '../src/features/groups-store.js';

// CSS.escape — браузерный глобал; в Node его нет, а модуль им пользуется.
if (typeof globalThis.CSS === 'undefined') globalThis.CSS = { escape: (s) => String(s) };

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/groups-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
// Мок формата wire-конверта (ADR-005 W4): правила — в Rust, здесь их
// тестовый двойник (scripts/lib/wire-envelope-mock.mjs + envelope-mock.mjs).
await installEnvelopeMock(MOCKS);

// ── Моки ───────────────────────────────────────────────────────────────────
const apiMock = {
  groupMessages: [],
  myGroupKey: null,
  calls: [],
  getGroupMessages: async (id, emails, force) => { apiMock.calls.push(['getGroupMessages', id, force]); return apiMock.groupMessages; },
  getMyGroupKey: async (id) => { apiMock.calls.push(['getMyGroupKey', id]); return apiMock.myGroupKey; },
  saveProfile: (...a) => { apiMock.calls.push(['saveProfile', ...a]); },
  sendGroupMeta: async (...a) => { apiMock.calls.push(['sendGroupMeta', ...a]); return { ok: true }; },
};
const dbMock = { kv: {}, kvGet: async (ns, k) => (dbMock.kv[k] ?? null), kvSet: async (ns, k, v) => { dbMock.kv[k] = v; }, kvDelete: async (ns, k) => { delete dbMock.kv[k]; } };
const cryptoMock = {
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  decryptWithGroupKey: null, // назначается тестом
  setPeerPublicKey: () => {},
  encryptWithGroupKey: async (plain, key) => { cryptoMock.encryptCalls.push([plain, key]); return 'ENC(' + key + ')'; },
  encryptCalls: [],
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
// chatStore (activeChat) и mailboxState (emails) — владельцы, их состояние
// общее для модуля и стенда, поэтому кладём на globalThis.
writeFileSync(MOCKS + '/session-store.js', 'export const chatStore = globalThis.__chatMock = { state: { activeChat: null } };\n');
writeFileSync(MOCKS + '/mailbox-store.js', 'export const mailboxState = globalThis.__mailboxMock = { state: { emails: [] } };\n');
writeFileSync(MOCKS + '/presence.js',
  // Контракт приёма heartbeat (ADR-005 R3): связанная функция отметки
  // (НЕ компонент) + решение «это presence?» внутри presence.js.
  'export const ingestSignal = (noteSeen, robj, senderEmail, mailTs) => {' +
  '  globalThis.__presCalls.push({ noteSeen, robj, senderEmail, mailTs });' +
  '  if (!robj || robj.presence !== 1) return false;' +
  '  noteSeen(senderEmail, mailTs);' +
  '  return true;' +
  '}');

globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__presCalls = [];

prepareModuleCopy(
  ROOT + '/src/features/groups.js',
  MOCKS + '/groups.mjs',
  {
    '../api.js': 'api.js',
  '../message-format.js': 'message-format.js',
    '../message-format.js': 'message-format.js',
    '../crypto.js': 'crypto.js',
    './presence.js': 'presence.js',
    './session-store.js': 'session-store.js',
    './mailbox-store.js': 'mailbox-store.js',
  },
  MOCKS,
);
const G = await import(MOCKS + '/groups.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Стенд на каждый сценарий: счётчики предыдущего не должны «доказывать» следующий.
const state = { calls: [], pinned: null };

function resetWorld(over = {}) {
  apiMock.groupMessages = [];
  apiMock.myGroupKey = null;
  apiMock.calls = [];
  state.calls = [];
  state.pinned = null;
  state.isAdmin = true;
  state.currentGroup = { id: 'G1', name: 'Группа' };
  state.groupKeys = { G1: 'GK1' };
  state.messageListEl = null;
  globalThis.__presCalls = [];
  globalThis.__chatMock.state.activeChat = 'group:G1';
  globalThis.__mailboxMock.state.emails = [];
}

// Контракт deps — ровно то, что собирает App.vue:loadGroupMessages.
function makeDeps(over = {}) {
  const chat = createChatStore();
  const sending = createSendingStore();
  const groups = createGroupsStore();
  const deps = {
    chat,
    sending,
    groups,
    loadSeq: 1,
    getLoadSeq: () => deps.loadSeq,
    cryptoReady: true,
    readPinned: async () => state.pinned,
    setPinned: (msgId, preview) => { state.pinned = { msg_id: msgId, preview }; state.calls.push('setPinned'); },
    showHistoryFirst: async () => { state.calls.push('showHistoryFirst'); },
    isOwnSender: (sid) => sid === 'me@x.ru',
    isIgnored: () => false,
    applyPinFromWire: async (id, wire) => { state.calls.push('applyPinFromWire:' + id); },
    replyGroupAvatarHeal: async (id) => { state.calls.push('replyGroupAvatarHeal:' + id); },
    healGroupAvatarFromMessage: async (id, av) => { state.calls.push('healGroupAvatar:' + id); },
    parsePollEnvelope: () => null,
    loadProfiles: () => { state.calls.push('loadProfiles'); },
    mergeHistory: async (chatKey, list) => list,
    mergePending: (chatKey, list) => list,
    filterDeleted: (l) => l,
    applyReactions: (list, chatKey, wire) => { state.calls.push('applyReactions'); },
    applyEdits: (list, chatKey, wire) => { state.calls.push('applyEdits'); },
    applyPollVotes: (list, wire) => { state.calls.push('applyPollVotes'); },
    scheduleEphemeral: () => { state.calls.push('scheduleEphemeral'); },
    saveChatCache: (chatKey, list) => { state.calls.push('saveChatCache'); },
    saveCurrentHistory: (chatKey) => { state.calls.push('saveCurrentHistory'); },
    sendReadReceipts: (ids) => { state.calls.push('sendReadReceipts:' + ids.length); },
    noteSeen: (e, ts) => { state.calls.push('noteSeen:' + e); },
    // ADR-005 W3 (партия 6): закрепление сообщения.
    isGroupAdmin: () => state.isAdmin,
    currentGroup: () => state.currentGroup,
    groupKeys: state.groupKeys,
    pinnedMsgId: () => (state.pinned && state.pinned.msg_id) || null,
    pinGroupMessage: async (msg) => { state.calls.push('pinGroupMessage:' + (msg && msg.id)); },
    getMessageListEl: () => state.messageListEl,
    jumpToBottom: () => { state.calls.push('jumpToBottom'); },
  };
  return Object.assign(deps, over);
}

const gmail = (content, senderId, mid, createdAt) => ({
  content, sender_id: senderId, message_id: mid || '<m@x>',
  created_at: createdAt || '2026-01-01T00:00:00Z', is_read: false, is_sent: false,
});

// ── 1. No group key → показ как есть (unencrypted) ─────────────
console.log('1. нет группового ключа → unencrypted-рендер');
{
  resetWorld();
  cryptoMock.decryptWithGroupKey = null;
  apiMock.groupMessages = [gmail('привет', 'peer@x.ru', '<a@x>', '2026-01-02T00:00:00Z')];
  const d = makeDeps({ cryptoReady: false });
  await G.loadGroupMessages(d, 'G1');
  check('сообщение отрисовано, from=them, encrypted=false',
    d.chat.state.messages.length === 1 && d.chat.state.messages[0].from === 'them'
    && d.chat.state.messages[0].encrypted === false, d.chat.state.messages);
}

// ── 2. crypto-фильтр: не расшифровалось = не из группы ─────────
console.log('2. crypto-фильтр: чужие/1:1 письма отбрасываются');
{
  resetWorld();
  apiMock.myGroupKey = { group_key: 'GK' };
  apiMock.groupMessages = [gmail('ENC:foreign', 'peer@x.ru', '<f@x>')];
  cryptoMock.decryptWithGroupKey = async () => { throw new Error('AAD mismatch'); };
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('не расшифровалось → не рендерится (список пуст)', d.chat.state.messages.length === 0);
}

// ── 3. классификация: реакция/правка/квитанция НЕ рендерятся ────
console.log('3. классификация wire-событий (не рендерятся как сообщения)');
{
  resetWorld();
  apiMock.groupMessages = [
    gmail('ENC:r', 'peer@x.ru', '<r@x>'),   // реакция
    gmail('ENC:e', 'peer@x.ru', '<e@x>'),   // правка
    gmail('ENC:k', 'peer@x.ru', '<k@x>'),   // квитанция read
  ];
  cryptoMock.decryptWithGroupKey = async (content) => {
    if (content === 'ENC:r') return JSON.stringify({ react: 1, msg_id: 'X', emoji: '👍', action: 'add' });
    if (content === 'ENC:e') return JSON.stringify({ edit: 1, msg_id: 'Y', text: 'new', action: 'edit' });
    if (content === 'ENC:k') return JSON.stringify({ read: 1, msg_ids: ['Z'] });
    return null;
  };
  const seen = { react: null, edit: null };
  const d = makeDeps({
    applyReactions: (list, chatKey, wire) => { seen.react = wire; },
    applyEdits: (list, chatKey, wire) => { seen.edit = wire; },
  });
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('реакция/правка/квитанция НЕ в messages (0 карточек)', d.chat.state.messages.length === 0);
  check('реакция ушла в applyReactions (msg_id X)', seen.react && seen.react['X'] && seen.react['X'][0].emoji === '👍');
  check('правка ушла в applyEdits (msg_id Y)', seen.edit && seen.edit['Y'] && seen.edit['Y'][0].text === 'new');
}

// ── 4. реальное сообщение: конверт + дедуп по id ───────────────
console.log('4. сообщение из конверта + дедуп по id (N-1 копий отправителя)');
{
  resetWorld();
  apiMock.groupMessages = [
    gmail('ENC:1', 'peer@x.ru', '<c1@x>', '2026-01-03T00:00:00Z'),
    gmail('ENC:2', 'peer@x.ru', '<c2@x>', '2026-01-03T00:00:01Z'),
    gmail('ENC:3', 'peer@x.ru', '<c3@x>', '2026-01-04T00:00:00Z'),
  ];
  // Копии ОДНОГО конверта (id=ev1) с РАЗНЫМ текстом: при дедупе должен
  // остаться ПЕРВЫЙ (иначе видно последнюю копию — а это уже другой текст).
  cryptoMock.decryptWithGroupKey = async (content) => {
    if (content === 'ENC:1') return JSON.stringify({ vault: 1, id: 'ev1', text: 'первая копия' });
    if (content === 'ENC:2') return JSON.stringify({ vault: 1, id: 'ev1', text: 'вторая копия' });
    if (content === 'ENC:3') return JSON.stringify({ vault: 1, id: 'ev2', text: 'другое' });
    return null;
  };
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('дедуп по id конверта: 2 уникальных сообщения (не 3)', d.chat.state.messages.length === 2,
    d.chat.state.messages.map((m) => m.id));
  check('содержимое конверта (env.text), from=them, encrypted=true',
    d.chat.state.messages.some((m) => m.content === 'первая копия' && m.encrypted === true),
    d.chat.state.messages.map((m) => m.content));
  check('история и кэш сохранены, квитанции «просмотрено» отправлены',
    state.calls.includes('saveChatCache') && state.calls.includes('saveCurrentHistory')
    && state.calls.includes('sendReadReceipts:2'), state.calls);
}

// ── 5. stale-guard: переключение чата отменяет запись ──────────
console.log('5. stale-guard: активный чат сменился → messages не трогаем');
{
  resetWorld();
  globalThis.__chatMock.state.activeChat = 'group:OTHER';
  apiMock.groupMessages = [gmail('ENC:x', 'peer@x.ru', '<x@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ vault: 1, id: 'evX', text: 't' });
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  d.chat.state.messages = ['KEEP'];
  await G.loadGroupMessages(d, 'G1');
  check('stale → messages не перезаписаны (KEEP сохранён)',
    Array.isArray(d.chat.state.messages) && d.chat.state.messages.length === 1 && d.chat.state.messages[0] === 'KEEP');
  check('и запись в чат не делалась (saveChatCache не вызван)', !state.calls.includes('saveChatCache'), state.calls);
}

// ── 5b. stale по ТОКЕНУ загрузки (пользователь переключился) ────
console.log('5b. stale по токену загрузки → результат не применяется');
{
  resetWorld();
  apiMock.groupMessages = [gmail('ENC:x', 'peer@x.ru', '<x@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ vault: 1, id: 'evX', text: 't' });
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  d.chat.state.messages = ['KEEP2'];
  // Токен растёт ПОСЛЕ старта загрузки — гонка переключения чата.
  // (Возвращать 99 всегда нельзя: тогда seq == getLoadSeq() и гонки нет.)
  let seq = 1;
  d.getLoadSeq = () => seq;
  d.showHistoryFirst = async () => { seq = 99; };
  await G.loadGroupMessages(d, 'G1');
  check('токен вырос → messages не тронуты (KEEP2)',
    d.chat.state.messages.length === 1 && d.chat.state.messages[0] === 'KEEP2', d.chat.state.messages);
}

// ── 6. presence-сигнал: ingestSignal(noteSeen,...) ──────────────
console.log('6. presence-сигнал через ingestSignal(noteSeen)');
{
  resetWorld();
  apiMock.groupMessages = [gmail('ENC:p', 'peer@x.ru', '<p@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ presence: 1, ts: Date.now() });
  const seen = [];
  const d = makeDeps({ noteSeen: (e, ts) => { seen.push([e, ts]); } });
  d.groups.setGroupKey('G1', 'GK');
  globalThis.__presCalls = [];
  let threw = null;
  try { await G.loadGroupMessages(d, 'G1'); } catch (e) { threw = e; }
  const call = globalThis.__presCalls[0];
  check('presence без ReferenceError, ingestSignal получил функцию отметки (не ctx, не this)',
    threw === null && !!call && typeof call.noteSeen === 'function' && d.chat.state.messages.length === 0,
    { threw: threw && String(threw), call: !!call, msgs: d.chat.state.messages.length });
  check('отметка активности ушла в noteSeen (связанная функция)',
    seen.length === 1 && seen[0][0] === 'peer@x.ru', seen);
}

// ── 7. ПИН: закреплённое сообщение пишется в UI-состояние ───────
console.log('7. пин: readPinned → setPinned (баннер закреплённого)');
{
  resetWorld();
  state.pinned = { msg_id: 'pin1', preview: 'закреплено' };
  apiMock.groupMessages = [];
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('пин прочитан и записан в UI-состояние',
    state.calls.includes('setPinned') && state.pinned.msg_id === 'pin1', { calls: state.calls, pinned: state.pinned });
}

// ── 8. Ленивая догрузка ключа группы — в ВЛАДЕЛЬЦА ─────────────
console.log('8. ленивая догрузка ключа группы → владелец groups-store');
{
  resetWorld();
  apiMock.myGroupKey = { group_key: 'GK2' };
  apiMock.groupMessages = [gmail('ENC:k', 'peer@x.ru', '<k@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ vault: 1, id: 'evK', text: 'после догрузки' });
  const d = makeDeps();
  // Ключа в памяти нет — модуль должен догрузить его через api и положить
  // во ВЛАДЕЛЬЦА (иначе следующий вызов расшифрует тем же ключом заново).
  await G.loadGroupMessages(d, 'G1');
  check('ключ догружен из api и записан во владельца',
    d.groups.state.groupKeys['G1'] === 'GK2', d.groups.state.groupKeys);
  check('после догрузки сообщение расшифровано', d.chat.state.messages.length === 1, d.chat.state.messages);
}

// ── 9. meta-аватар группы → владелец групп ─────────────────────
console.log('9. meta-письмо с аватаром → аватар записан во владельца');
{
  resetWorld();
  apiMock.groupMessages = [gmail('ENC:m', 'peer@x.ru', '<m@x>', '2026-01-05T00:00:00Z')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ meta: 1, avatar: 'data:image/png;base64,AAA' });
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('аватар записан во владельца групп', d.groups.state.groupAvatars['G1'] === 'data:image/png;base64,AAA',
    d.groups.state.groupAvatars);
  check('meta не рендерится как сообщение', d.chat.state.messages.length === 0);
}

// ── 10. hav-запрос аватарки → ответ владельцу группы ───────────
console.log('10. hav-запрос: ответ группе, а не сообщение');
{
  resetWorld();
  apiMock.groupMessages = [gmail('ENC:h', 'peer@x.ru', '<h@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ hav: 1 });
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('replyGroupAvatarHeal вызван для G1', state.calls.includes('replyGroupAvatarHeal:G1'), state.calls);
  check('hav не рендерится как сообщение', d.chat.state.messages.length === 0);
}

// ── 11. Ignore-лист участника: не расшифровываем и не рендерим ──
console.log('11. ignore-лист: письма заблокированного участника не расшифровываются');
{
  resetWorld();
  apiMock.groupMessages = [gmail('ENC:ig', 'blocked@x.ru', '<ig@x>')];
  let decryptCalls = 0;
  cryptoMock.decryptWithGroupKey = async () => { decryptCalls++; return JSON.stringify({ vault: 1, id: 'evIg', text: 'x' }); };
  const d = makeDeps({ isIgnored: (e) => e === 'blocked@x.ru' });
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('письмо заблокированного не расшифровывалось (фильтр ДО расшифровки)', decryptCalls === 0, decryptCalls);
  check('и в чат не попало', d.chat.state.messages.length === 0, d.chat.state.messages);
}

// ── 12. gavatar в конверте → лечим аватар группы ───────────────
console.log('12. конверт с gavatar → аватар группы лечится');
{
  resetWorld();
  apiMock.groupMessages = [gmail('ENC:gv', 'peer@x.ru', '<gv@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ vault: 1, id: 'evGv', text: 'привет', gavatar: 'data:image/png;base64,BBB' });
  const d = makeDeps();
  d.groups.setGroupKey('G1', 'GK');
  await G.loadGroupMessages(d, 'G1');
  check('healGroupAvatarFromMessage вызван для G1', state.calls.includes('healGroupAvatar:G1'), state.calls);
  check('сообщение при этом отрисовано', d.chat.state.messages.length === 1, d.chat.state.messages);
}

// ── ADR-005 W3 (партия 6): закрепление сообщения в группе ───────────
console.log('Закрепление сообщения');
{
  const d = makeDeps();

  // 1. Закрепить: состояние + kv
  resetWorld();
  await G.setPinnedState(d, 'G1', { msg_id: 'm1', preview: 'текст', ts: 5 });
  check('закрепление: состояние обновлено', state.pinned && state.pinned.msg_id === 'm1', state.pinned);
  check('закрепление: записано в kv', dbMock.kv['pinned:G1'] && JSON.parse(dbMock.kv['pinned:G1']).msg_id === 'm1', dbMock.kv['pinned:G1']);

  // 2. Открепить: kv удаляется, состояние сброшено
  resetWorld();
  dbMock.kv['pinned:G1'] = '{"msg_id":"m1"}';
  await G.setPinnedState(d, 'G1', null);
  check('открепление: kv удалён', dbMock.kv['pinned:G1'] === undefined, dbMock.kv['pinned:G1']);
  check('открепление: состояние сброшено', state.pinned && state.pinned.msg_id === null, state.pinned);

  // 3. applyPinFromWire: более старый pin игнорируется
  resetWorld();
  state.pinned = { msg_id: 'old', preview: 'старый', ts: 100 };
  dbMock.kv['pinned:G1'] = JSON.stringify(state.pinned);
  await G.applyPinFromWire(d, 'G1', { msg_id: 'new', preview: 'новый', ts: 50 });
  check('старый pin не применяется', state.pinned.msg_id === 'old', state.pinned);

  // 4. applyPinFromWire: более новый — применяется
  resetWorld();
  state.pinned = { msg_id: 'old', preview: 'старый', ts: 50 };
  dbMock.kv['pinned:G1'] = JSON.stringify(state.pinned);
  await G.applyPinFromWire(d, 'G1', { msg_id: 'new', preview: 'новый', ts: 100 });
  check('новый pin применяется', state.pinned.msg_id === 'new', state.pinned);

  // 5. applyPinFromWire: пустой msg_id = открепление
  resetWorld();
  state.pinned = { msg_id: 'old', preview: 'старый', ts: 50 };
  dbMock.kv['pinned:G1'] = JSON.stringify(state.pinned);
  await G.applyPinFromWire(d, 'G1', { msg_id: '', ts: 100 });
  check('пустой msg_id → открепление', state.pinned.msg_id === null, state.pinned);

  // 6. pinGroupMessage: не админ — ничего
  resetWorld();
  state.isAdmin = false;
  await G.pinGroupMessage(d, { id: 'm1', content: 'текст' });
  check('не админ → закрепление не применяется', state.calls.length === 0, state.calls);

  // 7. pinGroupMessage: админ — решение применено и письмо ушло
  resetWorld();
  apiMock.myGroupKey = { group_key: 'GK_FROM_API' };
  await G.pinGroupMessage(d, { id: 'm1', content: 'текст' });
  check('админ → закрепление применено', state.pinned && state.pinned.msg_id === 'm1', state.pinned);
  check('админ → pin-письмо отправлено', apiMock.calls.some((c) => c[0] === 'sendGroupMeta'), apiMock.calls);

  // 8. unpinGroupMessage — вызывает pinGroupMessage с пустым содержимым
  resetWorld();
  state.pinned = { msg_id: 'm1', preview: 'p' };
  await G.unpinGroupMessage(d);
  check('открепление вызывает pinGroupMessage', state.calls.some((c) => c.startsWith('pinGroupMessage')), state.calls);

  // 9. scrollPinnedToView: без списка — ничего
  resetWorld();
  G.scrollPinnedToView(d);
  check('без списка сообщений — без прокрутки', !state.calls.includes('jumpToBottom'), state.calls);

  // 10. scrollPinnedToView: сообщения нет — прокрутка вниз
  resetWorld();
  state.messageListEl = { querySelector: () => null, scrollTo: () => { state.calls.push('scrollTo'); } };
  G.scrollPinnedToView(d);
  check('закреплённого нет → вниз', state.calls.includes('jumpToBottom'), state.calls);

  // 11. scrollPinnedToView: сообщение найдено — прокрутка к нему
  resetWorld();
  state.messageListEl = { querySelector: () => ({ offsetTop: 100 }), scrollTo: (o) => { state.calls.push('scrollTo:' + o.top); } };
  G.scrollPinnedToView(d);
  check('найдено → прокрутка к сообщению', state.calls.some((c) => c.startsWith('scrollTo:')), state.calls);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
