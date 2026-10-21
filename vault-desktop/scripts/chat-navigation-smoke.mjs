// Node-смоук features/chat-navigation.js — открытие чата и группы.
//
// Что ловится: открытие чата — сценарий из десяти шагов, и ошибка в порядке
// тиха: пользователь видит сообщения ПРЕДЫДУЩЕГО чата (одинаковые во всех
// чатах) или, наоборот, пустой чат вместо кэша. Проверяем: порядок шагов
// (черновик → сброс → кэш → состояние → загрузка), «нет ключа → панель
// обмена ключами» (а не пустой чат), сброс счётчиков (непрочитанные,
// избранное, TTL) и догрузку ключа группы.
//
// Отдельно: открытие по ключу (из пуша) должно приводить к тому же чату и
// закрывать настройки, а на мобильном — показывать чат.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/chat-navigation-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Крипто: публичный ключ собеседника ставится, ключ группы «расшифровывается».
const cryptoCalls = [];
globalThis.__cryptoMock = {
  setPeerPublicKey: (k, pq) => { cryptoCalls.push(['peer', k, pq]); },
  decryptGroupKey: async (enc, pk) => { cryptoCalls.push(['decrypt', enc, pk]); return 'GROUPKEY'; },
};
writeFileSync(MOCKS + '/crypto.js', 'export default globalThis.__cryptoMock;\n');

prepareModuleCopy(
  ROOT + '/src/features/chat-navigation.js',
  MOCKS + '/chat-navigation.mjs',
  { '../crypto.js': 'crypto.js' },
  MOCKS,
);
const N = await import(MOCKS + '/chat-navigation.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const st = {
    order: [],
    chat: ['старое'],
    newMessage: 'черновик',
    activeChat: null,
    activeChatType: null,
    starredOnly: true,
    view: 'chats',
    ttl: 999,
    unread: { 'peer@x.ru': 3 },
    qr: false,
    settings: true,
    mobileOpen: false,
    ephemeralMenu: true,
    currentGroup: null,
    loadSeq: 0,
    groupKeys: {},
    peerKeySet: null,
    loaded: [],
    groupLoaded: [],
    starred: [],
    emails: [],
    drafts: [],
    restored: [],
    cached: null,
    scrolled: 0,
    alerts: [],
    emailsLoaded: 0,
  };
  const deps = {
    st,
    peerKeys: () => ({ 'peer@x.ru': 'PK1' }),
    peerPqKeys: () => ({ 'peer@x.ru': 'PQ1' }),
    groupKeys: () => st.groupKeys,
    cryptoReady: () => true,
    isMobile: () => false,
    emails: () => st.emails,
    api: { getMyGroupKey: async () => ({ group_key: 'GK' }) },
    alert: (msg) => { st.alerts.push(msg); },
    tr: (key) => key,
    chat: { set: (list) => { st.chat = list; st.order.push('chat.set'); } },
    setShowQRCode: (v) => { st.qr = v; },
    setShowSettings: (v) => { st.settings = v; },
    setShowEphemeralMenu: (v) => { st.ephemeralMenu = v; },
    setMobileChatOpen: (v) => { st.mobileOpen = v; },
    setNewMessage: (v) => { st.newMessage = v; st.order.push('newMessage'); },
    setActiveChat: (v) => { st.activeChat = v; st.order.push('activeChat'); },
    setActiveChatType: (v) => { st.activeChatType = v; },
    setShowStarredOnly: (v) => { st.starredOnly = v; },
    setCurrentView: (v) => { st.view = v; },
    setCurrentEphemeralTtl: (v) => { st.ttl = v; },
    setCurrentGroup: (v) => { st.currentGroup = v; },
    setGroupKey: (id, k) => { st.groupKeys[id] = k; },
    incLoadSeq: () => { st.loadSeq += 1; },
    saveDraft: () => { st.order.push('saveDraft'); },
    cancelReply: () => { st.order.push('cancelReply'); },
    restoreDraft: (k) => { st.restored.push(k); },
    loadChatCache: async (chat) => { st.cached = [{ ts: 2, id: 'b' }, { ts: 1, id: 'a' }]; return st.cached; },
    msgTs: (m) => m.ts || 0,
    loadStarredFor: (k) => { st.starred.push(k); },
    ephemeralTtlOf: async () => 60,
    resetUnread: (k) => { st.unread[k] = 0; },
    openMobileChat: () => { st.order.push('openMobileChat'); },
    loadEmails: async (force) => { st.emailsLoaded += 1; st.emails.push({}); },
    loadMessages: async (k) => { st.loaded.push(k); },
    loadGroupMessages: async (id, force) => { st.groupLoaded.push([id, force]); },
    backfillGroupFingerprints: () => {},
    scrollToBottom: (force) => { st.scrolled += 1; },
    selectChat: async (email) => { st.order.push('selectChat:' + email); },
    ...over,
  };
  return deps;
}

// ── 1:1-чат: без ключа ─────────────────────────────────────────────────
{
  const deps = makeDeps({ peerKeys: () => ({}) });
  await N.selectChat(deps, 'peer@x.ru');
  check('без ключа: объяснение пользователю', deps.st.alerts.length === 1, deps.st.alerts);
  check('без ключа: открыта панель обмена ключами', deps.st.qr === true, deps.st.qr);
  check('без ключа: чат не грузился', deps.st.loaded.length === 0, deps.st.loaded);
  check('без ключа: состояние не менялось', deps.st.activeChat === null, deps.st.activeChat);
}

// ── 1:1-чат: штатное открытие ──────────────────────────────────────────
{
  const deps = makeDeps();
  await N.selectChat(deps, 'peer@x.ru');
  // -1 (черновик НЕ сохранён) тоже был бы «меньше» индекса сброса —
  // поэтому проверяем и наличие, и порядок.
  check('чат: черновик сохранён ДО сброса',
    deps.st.order.indexOf('saveDraft') >= 0
      && deps.st.order.indexOf('saveDraft') < deps.st.order.indexOf('chat.set'), deps.st.order);
  check('чат: поле ввода очищено', deps.st.newMessage === '', deps.st.newMessage);
  check('чат: ответ отменён', deps.st.order.includes('cancelReply'), deps.st.order);
  check('чат: кэш показан (и отсортирован по ts)',
    deps.st.chat.length === 2 && deps.st.chat[0].id === 'a', deps.st.chat);
  check('чат: активный чат установлен', deps.st.activeChat === 'peer@x.ru', deps.st.activeChat);
  check('чат: тип — 1:1', deps.st.activeChatType === 'chat', deps.st.activeChatType);
  check('чат: режим «только избранные» сброшен', deps.st.starredOnly === false, deps.st.starredOnly);
  check('чат: TTL взят из kv (не от прошлого чата)', deps.st.ttl === 60, deps.st.ttl);
  check('чат: счётчик непрочитанных сброшен', deps.st.unread['peer@x.ru'] === 0, deps.st.unread);
  check('чат: токен загрузки инкрементирован', deps.st.loadSeq === 1, deps.st.loadSeq);
  check('чат: публичный ключ собеседника установлен', cryptoCalls.some((c) => c[0] === 'peer' && c[1] === 'PK1'), cryptoCalls);
  check('чат: письма загружены', deps.st.loaded.length === 1 && deps.st.loaded[0] === 'peer@x.ru', deps.st.loaded);
  check('чат: прокрутка вниз', deps.st.scrolled === 1, deps.st.scrolled);
  check('чат: избранное перечитано', deps.st.starred.includes('peer@x.ru'), deps.st.starred);
}

// ── 1:1-чат: письма ещё не загружены — грузим сразу ────────────────────
{
  const deps = makeDeps();
  await N.selectChat(deps, 'peer@x.ru');
  check('чат: при пустом почтовом ящике письма догружены сразу', deps.st.emailsLoaded === 1, deps.st.emailsLoaded);
}
{
  const deps = makeDeps({ emails: () => [{ id: 'x' }] });
  await N.selectChat(deps, 'peer@x.ru');
  check('чат: при непустом ящике догрузка не нужна', deps.st.emailsLoaded === 0, deps.st.emailsLoaded);
}

// ── Открытие по ключу (из пуша) ─────────────────────────────────────────
{
  const deps = makeDeps();
  await N.openChatByKey(deps, 'PEER@X.RU');
  check('по ключу: адрес в нижний регистр', deps.st.order.includes('selectChat:peer@x.ru'), deps.st.order);
  check('по ключу: настройки закрыты', deps.st.settings === false, deps.st.settings);
}
{
  const deps = makeDeps();
  await N.openChatByKey(deps, '');
  check('по ключу: пустой ключ — ничего', deps.st.order.length === 0, deps.st.order);
}
{
  const deps = makeDeps({ isMobile: () => true });
  await N.openChatByKey(deps, 'peer@x.ru');
  check('по ключу: на мобильном чат показан', deps.st.mobileOpen === true, deps.st.mobileOpen);
}

// ── Группа ─────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  const group = { id: 'g1', created_by: 'owner@x.ru', members: [] };
  await N.selectGroup(deps, group);
  check('группа: активный чат = group:<id>', deps.st.activeChat === 'group:g1', deps.st.activeChat);
  check('группа: тип — группа', deps.st.activeChatType === 'group', deps.st.activeChatType);
  check('группа: текущая группа установлена', deps.st.currentGroup === group, deps.st.currentGroup);
  check('группа: ключ догружен', deps.st.groupKeys['g1'] === 'GK', deps.st.groupKeys);
  check('группа: сообщения загружены', deps.st.groupLoaded.length === 1 && deps.st.groupLoaded[0][0] === 'g1', deps.st.groupLoaded);
  check('группа: меню TTL закрыто', deps.st.ephemeralMenu === false, deps.st.ephemeralMenu);
  check('группа: счётчик непрочитанных сброшен', deps.st.unread['group:g1'] === 0, deps.st.unread);
  check('группа: черновик восстановлен для этой группы', deps.st.restored.includes('group:g1'), deps.st.restored);
}
{
  let keyFetches = 0;
  const deps = makeDeps({
    groupKeys: () => ({ g1: 'ЕСТЬ' }),
    api: { getMyGroupKey: async () => { keyFetches += 1; throw new Error('сеть'); } },
  });
  const group = { id: 'g1', created_by: 'owner@x.ru', members: [] };
  await N.selectGroup(deps, group);
  check('группа: ключ уже в памяти — с сервера не грузим (сеть даже не нужна)',
    keyFetches === 0, keyFetches);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
