// Node-смоук features/send.js — под-домен «отправка 1:1» (ADR-001 домен 2,
// КРИТИЧЕСКИЙ ПУТЬ доставки). Мокаем api/crypto через tmp-модули, ctx в makeCtx.
// Цель: застраховать ВЫНЕСЕННУЮ механически (this.*→ctx.*) логику sendMessage:
// guards, заметки, шифрование (группа/пир), оптимистичный предпросмотр + статусы,
// persist. Поведение 1:1 с inline-методом App.vue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
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

// браузерные глобалы, отсутствующие в Node (в Tauri/WebView есть)
globalThis.alert = () => {};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    newMessage: 'привет', activeChat: 'peer@x.ru', activeChatType: 'peer',
    currentGroup: null, sending: false, cryptoReady: true,
    peerKeys: { 'peer@x.ru': 'PUB' }, peerPqKeys: {}, groupKeys: {},
    email: 'me@x.ru', messages: [], pendingOutgoing: {}, replyTo: null, editingMsgId: null, editingMessage: null,
    lastSend: null, _sendingWatchdog: null,
    isIgnored: () => false, t: (k) => k, showToast: () => {},
    buildEnvelope: async (payload, ttl) => JSON.stringify({ vault: 1, id: 'env' + Math.random().toString(36).slice(2, 6), text: payload }),
    ephemeralTtlOf: async () => 0,
    markPending: () => {}, saveCurrentHistory: () => {}, scrollToBottom: () => {},
    cancelReply: () => {}, replyPreview: () => '', saveDraft: () => {},
    cancelEdit: () => {}, replyBody: (c) => c || '', replyQuote: () => '',
    recordLocalEdit: () => {}, sendEditEmail: async () => {},
    saveNotes: () => true, loadNotes: () => [], sendChannelPost: () => {},
  }, over);
}

const tick = () => new Promise(r => setTimeout(r, 5));

// ── 1. guards: пустое / sending / ignore ───────────────────────
console.log('1. guards: пустое сообщение / sending / заблокирован');
{
  apiMock.sent.length = 0;
  await S.sendMessage(makeCtx({ newMessage: '   ' }));
  check('пустой ввод → ничего не отправлено', apiMock.sent.length === 0);
  await S.sendMessage(makeCtx({ sending: true }));
  check('sending=true → повторный вызов игнорируется', apiMock.sent.length === 0);
  await S.sendMessage(makeCtx({ activeChatType: 'chat', isIgnored: () => true }));
  check('заблокированный чат (activeChatType=chat) → не отправлено', apiMock.sent.length === 0);
}

// ── 2. заметки: локально, без почты ────────────────────────────
console.log('2. «Заметки для себя» — локально, почта не трогается');
{
  apiMock.sent.length = 0;
  const ctx = makeCtx({ activeChat: '__notes__', newMessage: 'заметка' });
  let saved = null; ctx.saveNotes = (l) => { saved = l; return true; }; ctx.loadNotes = () => [];
  await S.sendMessage(ctx);
  check('заметка сохранена локально, почта НЕ трогалась', saved && saved.length === 1 && apiMock.sent.length === 0);
  check('поле ввода очищено', ctx.newMessage === '');
}

// ── 3. 1:1 отправка: шифрование + предпросмотр + статус ───────
console.log('3. 1:1: конверт→шифр→api.sendMessage→статус sent');
{
  apiMock.sent.length = 0;
  const ctx = makeCtx({ newMessage: 'тест' });
  await S.sendMessage(ctx);
  // оптимистичный предпросмотр должен появиться СРАЗУ (до await api.sendMessage)
  check('оптимистичный предпросмотр добавлен в messages', ctx.messages.length === 1 && ctx.messages[0].from === 'me');
  check('поле ввода очищено сразу', ctx.newMessage === '');
  await tick(); // даём fire-and-forget api.sendMessage разрешиться
  check('api.sendMessage вызван с шифротекстом (ENC(...))',
    apiMock.sent.length === 1 && apiMock.sent[0][0] === 'msg' && String(apiMock.sent[0][2]).startsWith('ENC('));
  check('статус предпросмотра → sent', ctx.messages[0].status === 'sent');
}

// ── 4. групповая отправка: групповой ключ ──────────────────────
console.log('4. группа: шифрование групповым ключом → sendGroupMessage');
{
  apiMock.sent.length = 0;
  const ctx = makeCtx({ activeChatType: 'group', currentGroup: { id: 'G1' }, groupKeys: { G1: 'GK' }, newMessage: 'группа' });
  await S.sendMessage(ctx);
  await tick();
  check('api.sendGroupMessage вызван с групповым шифром (GENC(...))',
    apiMock.sent.length === 1 && apiMock.sent[0][0] === 'grp' && String(apiMock.sent[0][2]).startsWith('GENC('));
  check('статус → sent', ctx.messages[0] && ctx.messages[0].status === 'sent');
}

// ── 5. ошибка доставки → статус failed ─────────────────────────
console.log('5. сбой api.sendMessage → статус failed');
{
  apiMock.sent.length = 0;
  apiMock.sendMessage = async () => { throw new Error('smtp down'); };
  const ctx = makeCtx({ newMessage: 'упс' });
  await S.sendMessage(ctx);
  await tick();
  check('предпросмотр статус failed при сбое', ctx.messages[0] && ctx.messages[0].status === 'failed');
  // restore
  apiMock.sendMessage = async (to, content) => { apiMock.sent.push(['msg', to, content]); };
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
