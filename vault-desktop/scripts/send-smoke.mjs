// Node-смоук features/send.js — под-домен «отправка 1:1» (ADR-001 домен 2,
// КРИТИЧЕСКИЙ ПУТЬ доставки). Мокаем api/crypto через tmp-модули.
// С W2 (ADR-005) модуль не читает компонент: состояние настраивается у
// ВЛАДЕЛЬЦЕВ (chat/identity/session stores), эффекты — явным deps.
// Цель: застраховать ВЫНЕСЕННУЮ механически (this.*→ctx.*) логику sendMessage:
// guards, заметки, шифрование (группа/пир), оптимистичный предпросмотр + статусы,
// persist. Поведение 1:1 с inline-методом App.vue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { installEnvelopeMock } from './lib/wire-envelope-mock.mjs';
import { createChatStore } from '../src/chat-store.js';
import { createNotesStore } from '../src/features/notes-store.js';
import { createSendingStore } from '../src/features/sending-store.js';
// Владельцы состояния (ADR-004): модуль читает их напрямую, поэтому стенд
// настраивает состояние ими же (absolutizeImports ведёт копию в те же файлы →
// Node отдаёт те же синглтоны).
import { chatStore, sessionStore } from '../src/features/session-store.js';
import { identityStore } from '../src/features/identity-store.js';
import * as ChatFeature from '../src/features/chat.js';
import * as ContactsFeature from '../src/features/contacts.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/send-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
// Мок форматов wire-конверта и сервисных сигналов (ADR-005 W4):
// правила — в Rust, здесь их тестовый двойник.
await installEnvelopeMock(MOCKS);

const apiMock = {
  sent: [],
  sendMessage: async (to, content) => { apiMock.sent.push(['msg', to, content]); (globalThis.__order || []).push('send'); },
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
writeFileSync(MOCKS + '/message-store.js', 'export const ephemeralTtlOf = (chatId) => globalThis.__ttl(chatId);');
globalThis.__ttl = () => 0;
// Релей-двойник управляемый (globalThis.__relayMock): доставка считается
// состоявшейся, если сработал ХОТЯ БЫ ОДИН транспорт (релей или SMTP).
globalThis.__relayMock = { ok: true, why: undefined };
writeFileSync(MOCKS + '/relay-client.js',
  'export const fingerprintOf = async () => null;'
  + ' export const relayPublish = async () => { (globalThis.__order || []).push(\'relay\'); return { ...globalThis.__relayMock }; };');
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
    '../wire-signal-rule.js': 'wire-signal-rule.js',
    // Оригинал писал все четыре .replace В ОДНУ СТРОКУ, и построчный разбор
    // увидел только первый: остальные моки молча потерялись, а модуль начал
    // подтягивать настоящие api/crypto/relay-client — и падал на localStorage.
    // Без них тест проходил бы на подделке, а не на коде.
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../relay-client.js': 'relay-client.js',
    '../message-store.js': 'message-store.js',
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
// Состояние мира: чат/адрес/ключи — через владельцев, как в проде.
function resetWorld({ activeChat = 'peer@x.ru', activeChatType = 'peer', currentGroup = null,
                      email = 'me@x.ru', peerKeys = { 'peer@x.ru': 'PUB' } } = {}) {
  chatStore.setActiveChat(activeChat);
  chatStore.setActiveChatType(activeChatType);
  chatStore.setCurrentGroup(currentGroup);
  sessionStore.setCurrentEmail(email);
  identityStore.state.peerKeys = peerKeys;
}

// Эффекты и состояние, принадлежащие компоненту, — явным контрактом.
// Счётчики вызовов: проверяем ИМЕННО эффекты, а не «что-то произошло».
function makeDeps(over = {}) {
  const deps = {
    ...SEND_DEPS,
    // sending-store — владелец pendingOutgoing/sending (per-app экземпляр).
    sending: createSendingStore(),
    notes: createNotesStore(),
    chat: createChatStore(),
    groupKeys: {},
    setGroupKey: (id, k) => (deps.groupKeys[id] = k),
    cryptoReady: true,
    lastSend: null,
    getLastSend: () => deps.lastSend,
    setLastSend: (v) => (deps.lastSend = v),
    watchdog: null,
    getWatchdog: () => deps.watchdog,
    setWatchdog: (t) => (deps.watchdog = t),
    editingMessage: null,
    replyTo: null,
    cancelEditCalls: 0,
    cancelEdit: () => { deps.cancelEditCalls++; },
    cancelReplyCalls: 0,
    cancelReply: () => { deps.cancelReplyCalls++; },
    saveDraftCalls: 0,
    saveDraft: () => { deps.saveDraftCalls++; },
    isIgnored: () => false,
    buildEnvelope: async (payload, ttl) => JSON.stringify({ vault: 1, id: 'env' + Math.random().toString(36).slice(2, 6), text: payload }),
    markPendingCalls: [],
    markPending: (...a) => { deps.markPendingCalls.push(a); },
    historyCalls: [],
    // ПОРЯДОК вызовов: «история сохранена» не отличает оптимистичное
    // сохранение (ДО отправки — ради этого оно и нужно) от сохранения после
    // успешной отправки. Без порядка мутация одной из точек замаскируется
    // другой.
    order: [],
    saveCurrentHistory: (...a) => { deps.historyCalls.push(a); deps.order.push('history'); },
    recordLocalEdit: () => {},
    sendEditEmail: async () => {},
    scheduleEphemeralCalls: [],
    scheduleEphemeral: (...a) => { deps.scheduleEphemeralCalls.push(a); return Promise.resolve(); },
    sendChannelPost: () => {},
    ...over,
  };
  return deps;
}

const tick = () => new Promise(r => setTimeout(r, 5));

// ── 1. guards: пустое / sending / ignore ───────────────────────
console.log('1. guards: пустое сообщение / sending / заблокирован');
{
  apiMock.sent.length = 0;
  resetWorld();
  const d0 = makeDeps();
  d0.chat.setDraft('   ');
  await S.sendMessage(d0);
  check('пустой ввод → ничего не отправлено', apiMock.sent.length === 0);

  // sending — состояние владельца (sending-store), не поле компонента.
  const d1 = makeDeps();
  d1.chat.setDraft('привет');
  d1.sending.setSending(true);
  await S.sendMessage(d1);
  check('sending=true → повторный вызов игнорируется', apiMock.sent.length === 0);

  resetWorld({ activeChatType: 'chat' });
  const d2 = makeDeps({ isIgnored: () => true });
  d2.chat.setDraft('привет');
  await S.sendMessage(d2);
  check('заблокированный чат (activeChatType=chat) → не отправлено', apiMock.sent.length === 0);
}

// ── 2. заметки: локально, без почты ────────────────────────────
console.log('2. «Заметки для себя» — локально, почта не трогается');
{
  apiMock.sent.length = 0;
  // Адрес — из владельца сессии (не из ctx.email).
  resetWorld({ activeChat: '__notes__', email: 'notes@x.ru' });
  const d = makeDeps();
  d.chat.setDraft('заметка');
  d.notes.clear('notes@x.ru');
  await S.sendMessage(d);
  check('заметка сохранена локально под адресом из sessionStore, почта НЕ трогалась',
    d.notes.load('notes@x.ru').length === 1 && apiMock.sent.length === 0);
  check('поле ввода очищено (черновик chat-store)', d.chat.state.newMessage === '');
  check('заметки: ни pending, ни история не трогаются',
    d.historyCalls.length === 0 && d.markPendingCalls.length === 0,
    [d.historyCalls.length, d.markPendingCalls.length]);
}

// ── 3. 1:1 отправка: шифрование + предпросмотр + статус ───────
console.log('3. 1:1: конверт→шифр→api.sendMessage→статус sent');
{
  apiMock.sent.length = 0;
  resetWorld();
  const d = makeDeps();
  globalThis.__order = d.order;     // журнал порядка для apiMock.sendMessage
  d.chat.setDraft('тест');
  await S.sendMessage(d);
  // оптимистичный предпросмотр должен появиться СРАЗУ (до await api.sendMessage)
  check('оптимистичный предпросмотр добавлен в messages', d.chat.list().length === 1 && d.chat.list()[0].from === 'me');
  check('поле ввода очищено сразу', d.chat.state.newMessage === '');
  check('watchdog взведён, sending снят в finally',
    d.getWatchdog() !== null && d.sending.getSending() === false,
    [d.getWatchdog() !== null, d.sending.getSending()]);
  check('анти-дубль запомнил отправку (get/set в компоненте)',
    !!d.getLastSend() && d.getLastSend().chat === 'peer@x.ru' && d.getLastSend().text === 'тест', d.getLastSend());
  check('pending + история по ключу чата из владельца',
    d.markPendingCalls.length === 1 && d.historyCalls.length >= 1 && d.historyCalls[0][0] === 'peer@x.ru',
    [d.markPendingCalls.length, d.historyCalls]);

  await tick(); // даём fire-and-forget api.sendMessage разрешиться
  // ОПТИМИСТИЧНОЕ сохранение обязано быть ДО отправки: иначе при падении
  // SMTP своё сообщение пропало бы из истории (а после отправки — поздно).
  // Сравниваем с ЛЮБЫМ транспортом, не только с SMTP: релей вызывается
  // раньше и доставляет за секунду, поэтому «history < send» зелёный и на
  // коде без оптимистичной записи (первый history тогда — из finishOk relay).
  {
    const iHist = d.order.indexOf('history');
    const iSend = d.order.indexOf('send');
    const iRelay = d.order.indexOf('relay');
    const iTransport = Math.min(iSend === -1 ? Infinity : iSend, iRelay === -1 ? Infinity : iRelay);
    check('история сохранена ДО ЛЮБОГО транспорта (оптимистично)',
      iHist !== -1 && iHist < iTransport, d.order);
  }
  // После УСПЕШНОЙ отправки история пересохраняется: статус изменился на
  // 'sent' — иначе в персисте остался бы 'sending'.
  check('после отправки история пересохранена (статус sent)',
    d.historyCalls.length >= 2, d.historyCalls.length);
  check('api.sendMessage вызван с шифротекстом (ENC(...))',
    apiMock.sent.length === 1 && apiMock.sent[0][0] === 'msg' && String(apiMock.sent[0][2]).startsWith('ENC('));
  check('статус предпросмотра → sent', d.chat.list()[0].status === 'sent');

  // Анти-дубль ПОСЛЕ отправки: тот же текст в тот же чат в пределах 30 с.
  apiMock.sent.length = 0;
  d.chat.setDraft('тест');
  await S.sendMessage(d);
  await tick();
  check('повторный тот же текст в тот же чат → не отправлен', apiMock.sent.length === 0);
}

// ── 4. групповая отправка: групповой ключ ──────────────────────
console.log('4. группа: шифрование групповым ключом → sendGroupMessage');
{
  apiMock.sent.length = 0;
  resetWorld({ activeChatType: 'group', currentGroup: { id: 'G1' } });
  const d = makeDeps({ groupKeys: { G1: 'GK' } });
  d.chat.setDraft('группа');
  await S.sendMessage(d);
  await tick();
  check('api.sendGroupMessage вызван с групповым шифром (GENC(...))',
    apiMock.sent.length === 1 && apiMock.sent[0][0] === 'grp' && String(apiMock.sent[0][2]).startsWith('GENC('));
  check('статус → sent', d.chat.list()[0] && d.chat.list()[0].status === 'sent');
  check('группа: история/pending по ключу group:G1',
    d.historyCalls[0][0] === 'group:G1' && d.markPendingCalls[0][0] === 'group:G1',
    [d.historyCalls[0], d.markPendingCalls[0]]);
}

// ── 4b. ленивый backfill группового ключа (через владельца) ────
console.log('4b. lazy-backfill ключа группы');
{
  apiMock.sent.length = 0;
  apiMock.getMyGroupKey = async () => ({ group_key: 'GK2' });
  resetWorld({ activeChatType: 'group', currentGroup: { id: 'G2' } });
  const d = makeDeps({ groupKeys: {} });
  d.chat.setDraft('x');
  await S.sendMessage(d);
  await tick();
  check('ключ записан через setGroupKey (владелец групп) и сообщение ушло',
    d.groupKeys.G2 === 'GK2' && apiMock.sent.length === 1, [d.groupKeys, apiMock.sent.length]);
  delete apiMock.getMyGroupKey;
}

// ── 5. отказ ОБОИХ транспортов → статус failed ─────────────────
// Семантика: «отправлено» = сообщение вышло с устройства любым транспортом.
// Релей доставляет пиру за секунды, SMTP-копия в ящик — резерв. Поэтому
// failed только тогда, когда отказали оба; отказ одного при успехе другого
// — это доставленное сообщение (раньше маркер врал красным).
console.log('5. сбой api.sendMessage и релея → статус failed');
{
  apiMock.sent.length = 0;
  apiMock.sendMessage = async () => { throw new Error('smtp down'); };
  globalThis.__relayMock = { ok: false, why: 'no-live-relay' };
  resetWorld();
  const d = makeDeps();
  d.chat.setDraft('упс');
  await S.sendMessage(d);
  await tick();
  check('предпросмотр статус failed при сбое обоих транспортов',
    d.chat.list()[0] && d.chat.list()[0].status === 'failed');
  // restore
  apiMock.sendMessage = async (to, content) => { apiMock.sent.push(['msg', to, content]); (globalThis.__order || []).push('send'); };
  globalThis.__relayMock = { ok: true };
}

// ── 5b. SMTP отказал, но релей доставил → sent (не врём красным) ─────────
console.log('5b. релей доставил, SMTP отказал → статус sent');
{
  apiMock.sent.length = 0;
  apiMock.sendMessage = async () => { throw new Error('smtp timeout'); };
  globalThis.__relayMock = { ok: true };
  resetWorld();
  const d = makeDeps();
  d.chat.setDraft('через релей');
  await S.sendMessage(d);
  await tick();
  check('статус sent, когда доставил релей', d.chat.list()[0] && d.chat.list()[0].status === 'sent');
  apiMock.sendMessage = async (to, content) => { apiMock.sent.push(['msg', to, content]); (globalThis.__order || []).push('send'); };
}

// ── 5c. Релей недоступен, но SMTP прошёл → sent ─────────────────────────
console.log('5c. релей отказал, SMTP прошёл → статус sent');
{
  apiMock.sent.length = 0;
  globalThis.__relayMock = { ok: false, why: 'no-live-relay' };
  resetWorld();
  const d = makeDeps();
  d.chat.setDraft('через smtp');
  await S.sendMessage(d);
  await tick();
  check('статус sent, когда доставил SMTP', d.chat.list()[0] && d.chat.list()[0].status === 'sent');
  globalThis.__relayMock = { ok: true };
}

// ── Исчезающие сообщения: TTL из kv → таймер взводится ────────────────────
console.log('исчезающее сообщение: TTL → таймер');
{
  const d = makeDeps();
  globalThis.__order = d.order;
  globalThis.__ttl = () => 300;                 // чат с TTL
  d.chat.state.newMessage = 'исчезающий текст';
  await S.sendMessage(d);
  globalThis.__ttl = () => 0;                  // возвращаем как было
  check('исчезающее: таймер взведён (scheduleEphemeral)',
    d.scheduleEphemeralCalls.length === 1, d.scheduleEphemeralCalls);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
