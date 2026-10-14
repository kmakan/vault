// Node-смоук features/messages.js — под-домен «сообщения 1:1» (ADR-001 домен 2).
// Мокаем api/crypto/db через tmp-модули, ctx-методы в makeCtx. Без Vue/Tauri.
// Цель: застраховать ВЫНЕСЕННУЮ механически (this.*→ctx.*) логику loadMessages:
// пир-ключ расшифровка, crypto-фильтр (чужие/1:1-не-наши), классификация
// (реакция/правка/квитанция/call не рендерятся), envelope→text, дедуп,
// stale-guard. Поведение 1:1 с исходным inline-методом App.vue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/messages-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = { bodies: {}, fetchBody: async (uid) => apiMock.bodies[uid] || '' };
const dbMock = { kv: {}, kvGet: async (ns, k) => (dbMock.kv[k] ?? null), kvSet: async (ns, k, v) => { dbMock.kv[k] = v; } };
const cryptoMock = {
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  decryptVault: null,       // назначается тестом
  setPeerPublicKey: () => {},
  decryptWithGroupKey: async () => null,
};
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/presence.js', 'export const ingestSignal = () => false;');
globalThis.__apiMock = apiMock; globalThis.__dbMock = dbMock; globalThis.__cryptoMock = cryptoMock;

let m = readFileSync(ROOT + '/src/features/messages.js', 'utf8');
m = m
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"')
  .replace("from './presence.js'", 'from "' + MOCKS + '/presence.js"');
writeFileSync(MOCKS + '/messages.mjs', m);
const M = await import(MOCKS + '/messages.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    loadSeq: 1, activeChat: 'peer@x.ru', activeChatType: 'peer', currentGroup: null,
    emails: [], cryptoReady: true, peerKeys: { 'peer@x.ru': 'PUB' }, peerPqKeys: {},
    groupKeys: {}, messages: [], pendingOutgoing: {},
    isOwnSender: (sid) => sid === 'me@x.ru', isIgnored: () => false,
    aliasesOf: (email) => [String(email).toLowerCase()],
    senderEmail: (raw) => (typeof raw === 'string' ? raw : (raw && raw.address) || ''),
    showHistoryFirst: async () => {}, mergeHistory: async (chat, list) => list,
    applyReactions: () => {}, applyEdits: () => {}, applyPollVotes: () => {},
    filterDeleted: (l) => l, mergePending: (chat, l) => l,
    parseMessageContent: (raw) => ({ text: typeof raw === 'string' ? raw : String(raw), attachment: null }),
    parseEnvelope: (t) => { try { const o = JSON.parse(t); return (o && o.vault === 1) ? o : null; } catch (e) { return null; } },
    parseCallSignal: () => null, handleCallSignal: async () => {},
    scheduleEphemeral: () => {}, saveChatCache: () => {}, saveCurrentHistory: () => {},
    sendReadReceipts: () => {}, noteSeen: () => {}, loadProfiles: () => {},
    applyPinFromWire: async () => {}, replyGroupAvatarHeal: async () => {},
    healGroupAvatarFromMessage: () => {}, t: (k) => k, showToast: () => {},
    parsePollEnvelope: () => null,
  }, over);
}
const mail = (content, fromAddr, mid, uid) => ({ content, from: fromAddr, to: 'me@x.ru', message_id: mid || '<m@x>', uid: uid || 1, folder: 'INBOX', date: '2026-01-01T00:00:00Z' });

// ctx.emailBodyCache — тело письма по 'folder:uid'
function withBody(ctx, m, body) { ctx.emailBodyCache = ctx.emailBodyCache || {}; ctx.emailBodyCache[(m.folder || 'INBOX') + ':' + (m.uid || m.id)] = body; }

// ── 1. crypto-фильтр: не расшифровалось = чужое ───────────────
console.log('1. crypto-фильтр: не-Vault письмо отбрасывается');
{
  cryptoMock.decryptVault = async () => { throw new Error('AAD mismatch'); };
  const ctx = makeCtx({ emails: [mail('ENC:foreign', 'peer@x.ru', '<f@x>', 1)] });
  withBody(ctx, ctx.emails[0], 'ENC:foreign');
  await M.loadMessages(ctx, 'peer@x.ru');
  check('не расшифровалось → не рендерится (список пуст)', ctx.messages.length === 0);
}

// ── 2. конверт-сообщение от пира ──────────────────────────────
console.log('2. конверт {vault:1,text} от собеседника рендерится');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1, id: 'ev1', text: 'привет!' });
  const ctx = makeCtx({ emails: [mail('ENC:1', 'peer@x.ru', '<a@x>', 1)] });
  withBody(ctx, ctx.emails[0], 'ENC:1');
  await M.loadMessages(ctx, 'peer@x.ru');
  check('сообщение отрисовано: content=текст конверта, from=them, id=ev1',
    ctx.messages.length === 1 && ctx.messages[0].content === 'привет!' && ctx.messages[0].from === 'them' && ctx.messages[0].id === 'ev1');
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
  const ctx = makeCtx({
    emails: [mail('ENC:r', 'peer@x.ru', '<r@x>', 1), mail('ENC:k', 'peer@x.ru', '<k@x>', 2), mail('ENC:c', 'peer@x.ru', '<c@x>', 3)],
    parseCallSignal: (t) => { try { const o = JSON.parse(t); return (o && o.type === 'call_request') ? o : null; } catch (e) { return null; } },
  });
  withBody(ctx, ctx.emails[0], 'ENC:r'); withBody(ctx, ctx.emails[1], 'ENC:k'); withBody(ctx, ctx.emails[2], 'ENC:c');
  await M.loadMessages(ctx, 'peer@x.ru');
  check('реакция/квитанция/call не дали карточек (список пуст)', ctx.messages.length === 0);
}

// ── 4. stale-guard: чат переключили → messages не трогаем ────
console.log('4. stale-guard: activeChat сменился → messages не перезаписаны');
{
  cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1, id: 'evX', text: 't' });
  const ctx = makeCtx({ emails: [mail('ENC:x', 'peer@x.ru', '<x@x>', 1)], activeChat: 'other@x.ru', messages: ['KEEP'] });
  withBody(ctx, ctx.emails[0], 'ENC:x');
  await M.loadMessages(ctx, 'peer@x.ru');
  check('stale → messages не тронуты (KEEP)', Array.isArray(ctx.messages) && ctx.messages[0] === 'KEEP');
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
