// Node-смоук features/groups.js — под-домен «групповые сообщения» (ADR-001 домен 2).
// Мокаем api/crypto/db через tmp-модули, ctx-методы — в makeCtx. Без Vue/Tauri.
// Цель: застраховать ВЫНЕСЕННУЮ из App.vue логику loadGroupMessages:
// no-group-key путь, классификацию (реакция/правка/квитанция/pin/poll/presence/
// meta/hav не рендерятся как сообщения), дедуп по id конверта, crypto-фильтр.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { createChatStore } from '../src/chat-store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/groups-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  groupMessages: [],
  myGroupKey: null,
  getGroupMessages: async () => apiMock.groupMessages,
  getMyGroupKey: async () => apiMock.myGroupKey,
};
const dbMock = { kv: {}, kvGet: async (ns, k) => (dbMock.kv[k] ?? null), kvSet: async (ns, k, v) => { dbMock.kv[k] = v; } };
// crypto-мок: управляем расшифровкой per-тест
const cryptoMock = {
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  decryptWithGroupKey: null, // назначается тестом
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/presence.js',
  'export const ingestSignal = (ctxArg) => { if (globalThis.__presReject) { globalThis.__presGotCtx = (ctxArg && ctxArg.__isCtx === true); return true; } return false; }');

globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__cryptoMock = cryptoMock;

prepareModuleCopy(
  ROOT + '/src/features/groups.js',
  MOCKS + '/groups.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    './presence.js': 'presence.js',
  },
  MOCKS,
);
const G = await import(MOCKS + '/groups.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  const ctx = Object.assign({
    loadSeq: 1, activeChat: 'group:G1', emails: [], cryptoReady: true,
    groupKeys: {}, groupAvatars: {}, pendingOutgoing: {},
    // Модуль-владелец переписки (ADR-004, Этап A1). groups.js пишет через
    // ctx.chat.set/append/clear, а читает через ctx.chat.state.messages.
    chat: createChatStore(),
    pinnedMsgId: null, pinnedPreview: '',
    isOwnSender: (sid) => sid === 'me@x.ru',
    isIgnored: () => false,
    readPinned: async () => null,
    applyPinFromWire: async () => {},
    showHistoryFirst: async () => {},
    mergeHistory: async (chat, list) => list,
    applyReactions: () => {}, applyEdits: () => {}, applyPollVotes: () => {},
    filterDeleted: (l) => l, mergePending: (chat, l) => l,
    parseMessageContent: (raw) => ({ text: typeof raw === 'string' ? raw : String(raw), attachment: null }),
    parseEnvelope: (t) => { try { const o = JSON.parse(t); return (o && o.vault === 1) ? o : null; } catch (e) { return null; } },
    parsePollEnvelope: () => null,
    scheduleEphemeral: () => {}, saveChatCache: () => {},
    saveCurrentHistory: () => {}, sendReadReceipts: () => {},
    noteSeen: () => {}, healGroupAvatarFromMessage: () => {},
    replyGroupAvatarHeal: async () => {}, loadProfiles: () => {},
  }, over);
  // Методы-обёртки над groupKeys/groupAvatars (ADR-004 Этап A9).
  // Замыкание на ctx — единственный надёжный способ в Object.assign
  // контексте: method shorthand внутри литерала терял бы this.
  ctx.setGroupKey = (id, key) => { ctx.groupKeys[id] = key; return key; };
  ctx.setGroupAvatar = (id, avatar) => { ctx.groupAvatars[id] = avatar; return avatar; };
  ctx.mergeGroupKeys = (map) => Object.assign(ctx.groupKeys, map);
  ctx.mergeGroupAvatars = (map) => Object.assign(ctx.groupAvatars, map);
  // sending-store stubs (ADR-004 Этап A10) — для backward-compat с features,
  // которые используют ctx.sending/ctx.pendingOutgoing в makeCtx.
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
  ctx.dropBucket = (chatId) => { delete ctx.pendingOutgoing[chatId]; return ctx.pendingOutgoing; };
  return ctx;
}
const gmail = (content, senderId, mid, createdAt) => ({ content, sender_id: senderId, message_id: mid || '<m@x>', created_at: createdAt || '2026-01-01T00:00:00Z', is_read: false, is_sent: false });

// ── 1. No group key → показ как есть (unencrypted) ─────────────
console.log('1. нет группового ключа → unencrypted-рендер');
{
  cryptoMock.decryptWithGroupKey = null;
  apiMock.myGroupKey = null;
  apiMock.groupMessages = [gmail('привет', 'peer@x.ru', '<a@x>', '2026-01-02T00:00:00Z')];
  const ctx = makeCtx({ groupKeys: {}, cryptoReady: false });
  await G.loadGroupMessages(ctx, 'G1');
  check('сообщение отрисовано, from=them, encrypted=false',
    ctx.chat.state.messages.length === 1 && ctx.chat.state.messages[0].from === 'them' && ctx.chat.state.messages[0].encrypted === false);
}

// ── 2. crypto-фильтр: не расшифровалось = не из группы ─────────
console.log('2. crypto-фильтр: чужие/1:1 письма отбрасываются');
{
  apiMock.myGroupKey = { group_key: 'GK' };
  apiMock.groupMessages = [gmail('ENC:foreign', 'peer@x.ru', '<f@x>')];
  cryptoMock.decryptWithGroupKey = async () => { throw new Error('AAD mismatch'); };
  const ctx = makeCtx({ groupKeys: { G1: 'GK' } });
  await G.loadGroupMessages(ctx, 'G1');
  check('не расшифровалось → не рендерится (список пуст)', ctx.chat.state.messages.length === 0);
}

// ── 3. классификация: реакция/правка/квитанция НЕ рендерятся ────
console.log('3. классификация wire-событий (не рендерятся как сообщения)');
{
  apiMock.myGroupKey = null;
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
  const ctx = makeCtx({
    groupKeys: { G1: 'GK' },
    applyReactions: (list, chat, wire) => { seen.react = wire; },
    applyEdits: (list, chat, wire) => { seen.edit = wire; },
  });
  await G.loadGroupMessages(ctx, 'G1');
  check('реакция/правка/квитанция НЕ в messages (0 карточек)', ctx.chat.state.messages.length === 0);
  check('реакция ушла в applyReactions (msg_id X)', seen.react && seen.react['X'] && seen.react['X'][0].emoji === '👍');
  check('правка ушла в applyEdits (msg_id Y)', seen.edit && seen.edit['Y'] && seen.edit['Y'][0].text === 'new');
}

// ── 4. реальное сообщение: конверт + дедуп по id ───────────────
console.log('4. сообщение из конверта + дедуп по id (N-1 копий отправителя)');
{
  apiMock.myGroupKey = null;
  // две копии одного конверта (id=ev1) + одно разные
  apiMock.groupMessages = [
    gmail('ENC:1', 'peer@x.ru', '<c1@x>', '2026-01-03T00:00:00Z'),
    gmail('ENC:2', 'peer@x.ru', '<c2@x>', '2026-01-03T00:00:01Z'),
    gmail('ENC:3', 'peer@x.ru', '<c3@x>', '2026-01-04T00:00:00Z'),
  ];
  cryptoMock.decryptWithGroupKey = async (content) => {
    if (content === 'ENC:1' || content === 'ENC:2') return JSON.stringify({ vault: 1, id: 'ev1', text: 'одно и то же' });
    if (content === 'ENC:3') return JSON.stringify({ vault: 1, id: 'ev2', text: 'другое' });
    return null;
  };
  const ctx = makeCtx({ groupKeys: { G1: 'GK' } });
  await G.loadGroupMessages(ctx, 'G1');
  check('дедуп по id конверта: 2 уникальных сообщения (не 3)', ctx.chat.state.messages.length === 2);
  check('содержимое конверта (env.text), from=them, encrypted=true',
    ctx.chat.state.messages.some(m => m.content === 'одно и то же' && m.encrypted === true));
}

// ── 5. stale-guard: переключение чата отменяет запись ──────────
console.log('5. stale-guard: активный чат сменился → messages не трогаем');
{
  apiMock.myGroupKey = null;
  apiMock.groupMessages = [gmail('ENC:x', 'peer@x.ru', '<x@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ vault: 1, id: 'evX', text: 't' });
  // activeChat != 'group:G1' → stale с первого вызова → ранний return
  const ctx = makeCtx({ groupKeys: { G1: 'GK' }, activeChat: 'group:OTHER' });
  ctx.chat.state.messages = ['KEEP'];
  await G.loadGroupMessages(ctx, 'G1');
  check('stale → messages не перезаписаны (KEEP сохранён)',
    Array.isArray(ctx.chat.state.messages) && ctx.chat.state.messages.length === 1 && ctx.chat.state.messages[0] === 'KEEP');
}

// ── 6. presence-сигнал: ingestSignal(ctx,...) без ReferenceError ──
console.log('6. presence-сигнал через ingestSignal(ctx) — регресс this→ctx');
{
  apiMock.myGroupKey = null;
  apiMock.groupMessages = [gmail('ENC:p', 'peer@x.ru', '<p@x>')];
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ presence: 1, ts: Date.now() });
  const ctx = makeCtx({ groupKeys: { G1: 'GK' }, __isCtx: true });
  globalThis.__presReject = true;   // мок presence вернёт true (сигнал поглощён)
  globalThis.__presGotCtx = false;
  let threw = null;
  try { await G.loadGroupMessages(ctx, 'G1'); } catch (e) { threw = e; }
  check('presence без ReferenceError, ingestSignal получил ctx (не голый this)',
    threw === null && globalThis.__presGotCtx === true && ctx.chat.state.messages.length === 0);
  globalThis.__presReject = false;
}


console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
