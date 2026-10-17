// Node-смоук features/send.js — под-домен «отправка 1:1» (ADR-001 домен 2,
// КРИТИЧЕСКИЙ ПУТЬ доставки). Мокаем api/crypto через tmp-модули, ctx в makeCtx.
// Цель: застраховать ВЫНЕСЕННУЮ механически (this.*→ctx.*) логику sendMessage:
// guards, заметки, шифрование (группа/пир), оптимистичный предпросмотр + статусы,
// persist. Поведение 1:1 с inline-методом App.vue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { createChatStore } from '../src/chat-store.js';
import { createNotesStore } from '../src/features/notes-store.js';
import * as ChatFeature from '../src/features/chat.js';
import * as ContactsFeature from '../src/features/contacts.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/send-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  sent: [],
  sendMessage: async (to, content) => { apiMock.sent.push(['msg', to, content]); },
  sendGroupMessage: async (gid, content) => { apiMock.sent.push(['grp', gid, content]); },
};
const cryptoMock = {
  encryptVault: async (env) => 'ENC(' + env + ')',
  encryptWithGroupKey: async (env) => 'GENC(' + env + ')',
  setPeerPublicKey: () => {},
};
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/core.js', 'export const invoke = async () => null;');
writeFileSync(MOCKS + '/relay-client.js',
  'export const fingerprintOf = async () => null; export const relayPublish = () => Promise.resolve({ ok: true });');
globalThis.__apiMock = apiMock; globalThis.__cryptoMock = cryptoMock;

// ADR-004 A15: notes-store.js работает с глобальным localStorage.
const _ls = {};
globalThis.localStorage ||= {
  getItem: (k) => (_ls[k] !== undefined ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
  clear: () => { for (const k in _ls) delete _ls[k]; },
  key: (i) => Object.keys(_ls)[i] || null,
  get length() { return Object.keys(_ls).length; },
};

prepareModuleCopy(
  ROOT + '/src/features/send.js',
  MOCKS + '/send.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    // Оригинал писал все четыре .replace В ОДНУ СТРОКУ, и построчный разбор
    // увидел только первый: остальные моки молча потерялись, а модуль начал
    // подтягивать настоящие api/crypto/relay-client — и падал на localStorage.
    // Без них тест проходил бы на подделке, а не на коде.
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../relay-client.js': 'relay-client.js',
  },
  MOCKS,
);
const S = await import(MOCKS + '/send.mjs');

// deps injection для sendMessage (chat.js, contacts.js — чистые модули;
// encryptPeerVaultEnvelope реализована inline — совпадает с features/attachments.js).
const encryptPeerVaultEnvelope = async (envelope, { activeChat, peerKeys, peerPqKeys, cryptoReady, crypto }) => {
  if (!cryptoReady || !peerKeys || !peerKeys[activeChat]) return envelope;
  crypto.setPeerPublicKey(peerKeys[activeChat], peerPqKeys && peerPqKeys[activeChat]);
  return await crypto.encryptVault(envelope);
};
const SEND_DEPS = {
  resolveChatKey: ChatFeature.resolveChatKey,
  isRecentDuplicate: ChatFeature.isRecentDuplicate,
  buildReplyPayload: ChatFeature.buildReplyPayload,
  buildNoteMessage: ChatFeature.buildNoteMessage,
  buildSendingMessage: ChatFeature.buildSendingMessage,
  isPeerEncrypted: ContactsFeature.isPeerEncrypted,
  encryptPeerVaultEnvelope,
};

// браузерные глобалы, отсутствующие в Node (в Tauri/WebView есть)
globalThis.alert = () => {};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  // Методы-обёртки над состоянием отправки (ADR-004 Этап A10).
  // send.js пишет через ctx.setSending/ctx.setPendingOutgoing,
  // а читает через getSending/getPendingOutgoingBucket — адресуем во владельца.
  const ctx = Object.assign({
    newMessage: 'привет', activeChat: 'peer@x.ru', activeChatType: 'peer',
    currentGroup: null, sending: false, cryptoReady: true,
    peerKeys: { 'peer@x.ru': 'PUB' }, peerPqKeys: {}, groupKeys: {},
    email: 'me@x.ru', pendingOutgoing: {}, replyTo: null, editingMsgId: null, editingMessage: null,
    lastSend: null, _sendingWatchdog: null,
    isIgnored: () => false, t: (k) => k, showToast: () => {},
    buildEnvelope: async (payload, ttl) => JSON.stringify({ vault: 1, id: 'env' + Math.random().toString(36).slice(2, 6), text: payload }),
    ephemeralTtlOf: async () => 0,
    markPending: () => {}, saveCurrentHistory: () => {}, scrollToBottom: () => {},
    // Модуль-владелец переписки (ADR-004, Этап A1). send.js теперь пишет
    // через ctx.chat.set/append, а не напрямую в ctx.messages.
    chat: createChatStore(),
    // ADR-004 A15: notes-store — единственный владелец заметок для себя.
    notes: createNotesStore(),
    cancelReply: () => {}, replyPreview: () => '', saveDraft: () => {},
    cancelEdit: () => {}, replyBody: (c) => c || '', replyQuote: () => '',
    recordLocalEdit: () => {}, sendEditEmail: async () => {},
    sendChannelPost: () => {},
  }, over);
  ctx.setSending = (val) => { ctx.sending = !!val; return ctx.sending; };
  ctx.getSending = () => ctx.sending;
  ctx.setPendingOutgoing = (chatId, msg) => {
    const b = ctx.pendingOutgoing[chatId] || {};
    if (msg && msg.id) b[msg.id] = msg; else Object.assign(b, msg || {});
    ctx.pendingOutgoing[chatId] = b;
    return b;
  };
  ctx.getPendingOutgoingBucket = (chatId) => ctx.pendingOutgoing[chatId] || (ctx.pendingOutgoing[chatId] = {});
  ctx.mergePendingOutgoing = (chatId, bucket) => { ctx.pendingOutgoing[chatId] = bucket || {}; return ctx.pendingOutgoing[chatId]; };
  ctx.removePendingOutgoing = (chatId, msgId) => { const b = ctx.pendingOutgoing[chatId]; if (b && Object.prototype.hasOwnProperty.call(b, msgId)) { delete b[msgId]; } return b; };
  ctx.clearPendingOutgoing = () => { ctx.pendingOutgoing = {}; return ctx.pendingOutgoing; };
  ctx.dropBucket = (chatId) => { delete ctx.pendingOutgoing[chatId]; return ctx.pendingOutgoing; };
  // A14: newMessage draft owner stubs — пишем в data для чтения в тестах.
  ctx.setDraft = (text) => { ctx.newMessage = text == null ? '' : String(text); return ctx.newMessage; };
  ctx.getDraft = () => ctx.newMessage;
  ctx.clearDraft = () => { ctx.newMessage = ''; return ctx.newMessage; };
  return ctx;
}

const tick = () => new Promise(r => setTimeout(r, 5));

// ── 1. guards: пустое / sending / ignore ───────────────────────
console.log('1. guards: пустое сообщение / sending / заблокирован');
{
  apiMock.sent.length = 0;
  await S.sendMessage(makeCtx({ newMessage: '   ' }), SEND_DEPS);
  check('пустой ввод → ничего не отправлено', apiMock.sent.length === 0);
  await S.sendMessage(makeCtx({ sending: true }), SEND_DEPS);
  check('sending=true → повторный вызов игнорируется', apiMock.sent.length === 0);
  await S.sendMessage(makeCtx({ activeChatType: 'chat', isIgnored: () => true }), SEND_DEPS);
  check('заблокированный чат (activeChatType=chat) → не отправлено', apiMock.sent.length === 0);
}

// ── 2. заметки: локально, без почты ────────────────────────────
console.log('2. «Заметки для себя» — локально, почта не трогается');
{
  apiMock.sent.length = 0;
  const ctx = makeCtx({ activeChat: '__notes__', newMessage: 'заметка' });
  // notes-store использует localStorage (мок globalThis.localStorage).
  ctx.notes.clear(ctx.email);
  await S.sendMessage(ctx, SEND_DEPS);
  check('заметка сохранена локально, почта НЕ трогалась',
    ctx.notes.load(ctx.email).length === 1 && apiMock.sent.length === 0);
  check('поле ввода очищено', ctx.newMessage === '');
}

// ── 3. 1:1 отправка: шифрование + предпросмотр + статус ───────
console.log('3. 1:1: конверт→шифр→api.sendMessage→статус sent');
{
  apiMock.sent.length = 0;
  const ctx = makeCtx({ newMessage: 'тест' });
  await S.sendMessage(ctx, SEND_DEPS);
  // оптимистичный предпросмотр должен появиться СРАЗУ (до await api.sendMessage)
  check('оптимистичный предпросмотр добавлен в messages', ctx.chat.list().length === 1 && ctx.chat.list()[0].from === 'me');
  check('поле ввода очищено сразу', ctx.newMessage === '');
  await tick(); // даём fire-and-forget api.sendMessage разрешиться
  check('api.sendMessage вызван с шифротекстом (ENC(...))',
    apiMock.sent.length === 1 && apiMock.sent[0][0] === 'msg' && String(apiMock.sent[0][2]).startsWith('ENC('));
  check('статус предпросмотра → sent', ctx.chat.list()[0].status === 'sent');
}

// ── 4. групповая отправка: групповой ключ ──────────────────────
console.log('4. группа: шифрование групповым ключом → sendGroupMessage');
{
  apiMock.sent.length = 0;
  const ctx = makeCtx({ activeChatType: 'group', currentGroup: { id: 'G1' }, groupKeys: { G1: 'GK' }, newMessage: 'группа' });
  await S.sendMessage(ctx, SEND_DEPS);
  await tick();
  check('api.sendGroupMessage вызван с групповым шифром (GENC(...))',
    apiMock.sent.length === 1 && apiMock.sent[0][0] === 'grp' && String(apiMock.sent[0][2]).startsWith('GENC('));
  check('статус → sent', ctx.chat.list()[0] && ctx.chat.list()[0].status === 'sent');
}

// ── 5. ошибка доставки → статус failed ─────────────────────────
console.log('5. сбой api.sendMessage → статус failed');
{
  apiMock.sent.length = 0;
  apiMock.sendMessage = async () => { throw new Error('smtp down'); };
  const ctx = makeCtx({ newMessage: 'упс' });
  await S.sendMessage(ctx, SEND_DEPS);
  await tick();
  check('предпросмотр статус failed при сбое', ctx.chat.list()[0] && ctx.chat.list()[0].status === 'failed');
  // restore
  apiMock.sendMessage = async (to, content) => { apiMock.sent.push(['msg', to, content]); };
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
