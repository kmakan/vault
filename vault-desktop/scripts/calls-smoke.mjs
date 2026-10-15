// Node-смоук features/calls.js — семантика звонковой state machine без
// Vue/Tauri (паттерн incoming-smoke.mjs). Таймеры/Audio — управляемые моки.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { createChatStore } from '../src/chat-store.js';
import { createCallSession } from '../src/features/call-session.js';
import { createCallResender } from '../src/features/call-resend.js';
// семя callSession из перегруженных полей makeCtx (ADR-004 C/D)
const CALL_SEED_KEYS = [
  'callState', 'currentCall', 'lastCallId', 'callMuted', 'callSpeaker',
  'callMediaConnected', 'callClockSec', 'callClockTimer', 'callRingTimer',
  'callSoundEl', 'callRingtoneIncoming', 'callRingtoneOutgoing',
  '_pendingKemct', '_pendingSenderEk', '_mediaFallbackTimer', '_connLostTimer',
];
const toSessionSeed = (over) => {
  const s = {};
  if (over.callState !== undefined) s.callState = over.callState;
  if (over.currentCall !== undefined) s.currentCall = over.currentCall;
  if (over.lastCallId !== undefined) s.lastCallId = over.lastCallId;
  if (over.callMuted !== undefined) s.callMuted = over.callMuted;
  if (over.callSpeaker !== undefined) s.callSpeaker = over.callSpeaker;
  if (over.callMediaConnected !== undefined) s.callMediaConnected = over.callMediaConnected;
  if (over.callClockSec !== undefined) s.callClockSec = over.callClockSec;
  if (over.callClockTimer !== undefined) s.callClockTimer = over.callClockTimer;
  if (over.callRingTimer !== undefined) s.callRingTimer = over.callRingTimer;
  if (over.callSoundEl !== undefined) s.callSoundEl = over.callSoundEl;
  if (over.callRingtoneIncoming !== undefined) s.callRingtoneIncoming = over.callRingtoneIncoming;
  if (over.callRingtoneOutgoing !== undefined) s.callRingtoneOutgoing = over.callRingtoneOutgoing;
  if (over._pendingKemct !== undefined) s.pendingKemct = over._pendingKemct;
  if (over._pendingSenderEk !== undefined) s.pendingSenderEk = over._pendingSenderEk;
  if (over._mediaFallbackTimer !== undefined) s.mediaFallbackTimer = over._mediaFallbackTimer;
  if (over._connLostTimer !== undefined) s.connLostTimer = over._connLostTimer;
  if (over._pendingKemct !== undefined) s.pendingKemct = over._pendingKemct;
  if (over._pendingSenderEk !== undefined) s.pendingSenderEk = over._pendingSenderEk;
  if (over._mediaFallbackTimer !== undefined) s.mediaFallbackTimer = over._mediaFallbackTimer;
  if (over._connLostTimer !== undefined) s.connLostTimer = over._connLostTimer;
  return s;
};

const ROOT = import.meta.dirname;

// ── Заглушки ───────────────────────────────────────────────────
const MOCKS = '/tmp/calls-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  calls: [],
  sendReadReceipt: async (peer, content) => { apiMock.calls.push(['sendReadReceipt', peer, content]); },
  mediaShowIncomingCall: (name) => { apiMock.calls.push(['showIncoming', name]); },
  mediaDismissIncomingCall: () => { apiMock.calls.push(['dismissIncoming']); },
  reportCallState: (id, st) => { apiMock.calls.push(['reportState', id, st]); },
  mediaStartOutgoing: async (id, key, pq) => ({ sdp: 'OFFER_SDP', kemct: 'KEMCT', sender_ek: 'SEK' }),
  mediaAcceptIncoming: async (id, sdp, key, kemct) => ({ sdp: 'ANSWER_SDP' }),
  mediaSetRemote: async (id, sdp) => { apiMock.calls.push(['setRemote', id, sdp]); },
  mediaSendHangup: (id) => { apiMock.calls.push(['dcHangup', id]); },
  mediaClose: async (id) => { apiMock.calls.push(['close', id]); },
  mediaSetMuted: async (id, v) => { apiMock.calls.push(['setMuted', id, v]); },
  mediaSetSpeaker: async (id, v) => { apiMock.calls.push(['setSpeaker', id, v]); },
  mediaSoundPlay: (name, loop) => { apiMock.calls.push(['soundPlay', name, loop]); },
  mediaSoundStop: async () => { apiMock.calls.push(['soundStop']); },
};
const dbMock = {
  kv: new Map(),
  kvGet: async (acc, k) => (dbMock.kv.has(k) ? dbMock.kv.get(k) : null),
  kvSet: async (acc, k, v) => { dbMock.kv.set(k, v); },
};
const relayMock = {
  pubs: [],
  result: { ok: true }, // что «вернёт» relayPublish; тест может подменить
  relayPublish: (from, to, id, content, opts) => {
    relayMock.pubs.push({ from, to, id, content, opts });
    return Promise.resolve(relayMock.result);
  },
};
const cryptoMock = {
  encVault: [],
  encryptVault: async (p) => { cryptoMock.encVault.push(p); return 'ENC:' + p; },
};
const histMock = {
  store: {},
  saveHistory: (a, c, m) => { histMock.store[c] = JSON.parse(JSON.stringify(m)); },
  loadHistory: async (a, c) => histMock.store[c] ? JSON.parse(JSON.stringify(histMock.store[c])) : null,
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock; export const accountNamespace = (email) => globalThis.__accountNamespaceMock(email);');
writeFileSync(MOCKS + '/relay-client.js', 'export const relayPublish = (...a) => globalThis.__relayMock.relayPublish(...a); export const fingerprintOf = async (k) => null; export const hasPeerToken = async () => false;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/history.js', 'export const saveHistory = (a, c, m) => globalThis.__histMock.saveHistory(a, c, m); export const loadHistory = (a, c) => globalThis.__histMock.loadHistory(a, c);');
globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__accountNamespaceMock = (email) => String(email || '').trim().toLowerCase();
globalThis.__relayMock = relayMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__histMock = histMock;

prepareModuleCopy(
  ROOT + '/../src/features/calls.js',
  MOCKS + '/features-calls.mjs',
  {
    '../api.js': 'api.js',
    '../relay-client.js': 'relay-client.js',
    '../crypto.js': 'crypto.js',
    '../history.js': 'history.js',
  },
  MOCKS,
);
const C = await import(MOCKS + '/features-calls.mjs');

// ── ADR-001: адаптеры под ЯВНЫЕ зависимости ─────────────────────
// Раньше эти функции брали `ctx` целиком и знали 212 полей App.vue.
// Теперь сигнатура — контракт: функция видит ровно перечисленное.
// Адаптеры ниже концентрируют «ctx → набор полей», чтобы сами проверки
// оставались в терминах поведения, а не в терминах разбора контекста.
const seenEmail = (c) => c.email;
const labelFn = (c) => c.t;
const cbDeps = (c) => ({
  activeChat: c.activeChat, activeChatType: c.activeChatType,
  callState: c.session.callState, expCalls: c.expCalls, peerKeys: c.peerKeys,
});

// ── Управляемые таймеры + Audio ────────────────────────────────
const timers = new Map();
let timerSeq = 0;
globalThis.setInterval = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 'i' }); return id; };
globalThis.clearInterval = (id) => { timers.delete(id); };
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 't' }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
async function fireTimer(id) {
  const t = timers.get(id);
  if (!t) return;
  if (t.kind === 't') timers.delete(id);
  await t.fn();
}
const audioInstances = [];
globalThis.Audio = class {
  constructor(src) { this.src = src; this.loop = false; this.volume = 1; audioInstances.push(this); }
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
};

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  const ctx = Object.assign({
    email: 'me@x.ru',
    isAndroid: false,
    // звонковое состояние — вынесено в ctx.session (createCallSession).
    // seed из параметров makeCtx (callState/currentCall/…) — через toSessionSeed.
    session: createCallSession(toSessionSeed(over)),
    // App-only (не call-session): signal-resend таймеры — owner createCallResender
    // (ADR-004 F). callResender — ресенд call_accept/answer; callRequestResender — call_request.
    callResender: createCallResender(),
    callRequestResender: createCallResender(),
    callStartedAt: 0,
    callPeerName: 'Пир',
    // чат-контекст
    activeChat: 'peer@x.ru',
    activeChatType: 'chat',
    peerKeys: { 'peer@x.ru': 'PUB' },
    peerPqKeys: {},
    // Модуль-владелец переписки (ADR-004, Этап A1). calls.js пишет через
    // ctx.chat.set/append/sortBy/clear, а читает через ctx.chat.state.messages.
    chat: createChatStore(),
    unreadCounts: {},
    expCalls: true,
    // методы-контракты
    isIgnored: () => false,
    canonicalOf: (e) => e,
    chatVisible: () => false,
    msgTs: (m) => m.ts || 0,
    saveCurrentHistory: () => {},
    saveChatCache: () => {},
    scrollToBottom: () => {},
    saveUnreadCounts: async () => {},
    showToast: (m, ms) => { toasts.push(m); },
    t: (k) => 'T:' + k,
    idleLoop: () => {},
  }, over);
  // unreadCounts: owner API stub → пишет в data (backward-compat для READS).
  // В реальном App.vue — методы-прокси на this.chat.state.unreadCounts.
  ctx.incUnread = (k) => { ctx.unreadCounts[k] = (ctx.unreadCounts[k] || 0) + 1; return ctx.unreadCounts[k]; };
  ctx.unreadOf = (k) => ctx.unreadCounts[k] || 0;
  ctx.clearUnread = (k) => { delete ctx.unreadCounts[k]; return ctx.unreadCounts; };
  return ctx;
}
const toasts = [];

// ── 1. Дедуп call-seen ─────────────────────────────────────────
console.log('1. Дедуп звонков (kv call-seen)');
{
  dbMock.kv.clear();
  const ctx = makeCtx();
  check('isCallSeen несуществующего → false', (await C.isCallSeen(seenEmail(ctx), 'c1')) === false);
  await C.rememberCallSeen(seenEmail(ctx), 'c1');
  check('remember→isCallSeen roundtrip', (await C.isCallSeen(seenEmail(ctx), 'c1')) === true);
  // лимит 100: старые вытесняются
  for (let i = 0; i < 120; i++) await C.rememberCallSeen(seenEmail(ctx), 'x' + i);
  const raw = JSON.parse(dbMock.kv.get('call-seen'));
  check('лимит 100 call_id', raw.length === 100 && !raw.includes('c1'));
  // сбой kv — тихо
  const origGet = dbMock.kvGet;
  dbMock.kvGet = async () => { throw new Error('kv down'); };
  check('сбой kv → isCallSeen false', (await C.isCallSeen(seenEmail(ctx), 'zz')) === false);
  await C.rememberCallSeen(seenEmail(ctx), 'zz'); // не бросается
  dbMock.kvGet = origGet;
}

// ── 2. parseCallSignal ─────────────────────────────────────────
console.log('2. parseCallSignal');
{
  check('валидный call_request', C.parseCallSignal(JSON.stringify({ vault: 1, type: 'call_request', call_id: 'c9', sdp: 'X' })).call_id === 'c9');
  check('не-JSON → null', C.parseCallSignal('hello') === null);
  check('не-звонковый тип → null', C.parseCallSignal(JSON.stringify({ vault: 1, type: 'msg', call_id: 'c' })) === null);
  check('без call_id → null', C.parseCallSignal(JSON.stringify({ vault: 1, type: 'call_request' })) === null);
  check('без vault:1 → null', C.parseCallSignal(JSON.stringify({ type: 'call_request', call_id: 'c' })) === null);
  check('null → null', C.parseCallSignal(null) === null);
}

// ── 3. sendCallEnvelope ─────────────────────────────────────────
console.log('3. sendCallEnvelope (релей + SMTP-фон)');
{
  relayMock.pubs.length = 0;
  apiMock.calls.length = 0;
  cryptoMock.encVault.length = 0;
  const ctx = makeCtx();
  await C.sendCallEnvelope(ctx, 'peer@x.ru', { type: 'call_request', call_id: 'c1', sdp: 'SDP1', kemct: 'K', sender_ek: 'E' });
  await new Promise(r => process.nextTick(r));
  check('релей-копия ушла (wake=true для call_request)', relayMock.pubs.length === 1 && relayMock.pubs[0].opts.wake === true);
  const body = JSON.parse(cryptoMock.encVault[0]);
  check('тело: vault:1 + id + type + call_id + ts + sdp + kemct + sender_ek',
    body.vault === 1 && body.id && body.type === 'call_request' && body.call_id === 'c1' && typeof body.ts === 'number' && body.sdp === 'SDP1' && body.kemct === 'K' && body.sender_ek === 'E');
  check('SMTP-письмо ушло (stealth sendReadReceipt)', apiMock.calls.some(c => c[0] === 'sendReadReceipt'));
  // relayDelivered: успешная релей-публикация помечает ЗВОНЯЩИЙ вызов —
  // после этого баунс почтовой копии его НЕ гасит (см. §9, живой звонок
  // 12.10.2026: релей доставил, почта отбилась как спам, вызов упал).
  relayMock.pubs.length = 0;
  const ctxRelayed = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'r1', peer: 'peer@x.ru' } });
  relayMock.result = { ok: true };
  await C.sendCallEnvelope(ctxRelayed, 'peer@x.ru', { type: 'call_request', call_id: 'r1' });
  await new Promise(r => process.nextTick(r));
  check('успешный релей → currentCall.relayDelivered', ctxRelayed.session.currentCall.relayDelivered === true);
  // Провал публикации (нет peer-token / лимит): флаг НЕ ставится — баунс
  // почты по-прежнему считается доказательством недоставки.
  const ctxFailed = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'r2', peer: 'peer@x.ru' } });
  relayMock.result = { ok: false, why: 'no-peer-token' };
  await C.sendCallEnvelope(ctxFailed, 'peer@x.ru', { type: 'call_request', call_id: 'r2' });
  await new Promise(r => process.nextTick(r));
  check('провал релей → relayDelivered не выставлен', !ctxFailed.session.currentCall.relayDelivered);
  relayMock.result = { ok: true };
  // viaRelay=false → только почта
  relayMock.pubs.length = 0;
  await C.sendCallEnvelope(ctx, 'peer@x.ru', { type: 'call_end', call_id: 'c1' }, { viaRelay: false });
  check('viaRelay=false → релей НЕ публикует, wake не важен', relayMock.pubs.length === 0);
  // терминальный сигнал: wake=false
  relayMock.pubs.length = 0;
  await C.sendCallEnvelope(ctx, 'peer@x.ru', { type: 'call_reject', call_id: 'c1' });
  check('терминальный сигнал → wake=false', relayMock.pubs.length === 1 && relayMock.pubs[0].opts.wake === false);
  // SMTP-ретраи: 3 попытки с паузами 3с (фоновая задача)
  apiMock.calls.length = 0;
  const origSend = apiMock.sendReadReceipt;
  let fails = 0;
  apiMock.sendReadReceipt = async () => { if (fails++ < 2) throw new Error('SMTP down'); };
  await C.sendCallEnvelope(ctx, 'peer@x.ru', { type: 'call_request', call_id: 'c2' });
  await new Promise(r => process.nextTick(r));
  // фоновая задача: 1-я попытка упала, ждёт setTimeout 3с
  const retryTimers = [...timers.values()].filter(t => t.kind === 't' && t.ms === 3000);
  check('SMTP-ретрай запланирован (3с)', retryTimers.length >= 1);
  await fireTimer([...timers.entries()].find(([, t]) => t.kind === 't' && t.ms === 3000)[0]);
  await new Promise(r => process.nextTick(r));
  const retryTimers2 = [...timers.entries()].filter(([, t]) => t.kind === 't' && t.ms === 3000);
  if (retryTimers2.length) { await fireTimer(retryTimers2[0][0]); await new Promise(r => process.nextTick(r)); }
  check('ретраи доводят до успеха (3 попытки)', fails === 3);
  apiMock.sendReadReceipt = origSend;
}

// ── 4. handleCallSignal: роутер ─────────────────────────────────
console.log('4. handleCallSignal (роутер входящих)');
{
  dbMock.kv.clear();
  // 4a. stale-конверт (>10 мин): игнор + remember + missed-пилюля
  const ctx = makeCtx(); // activeChat=peer@x.ru (чат открыт) → пилюля в messages
  const oldTs = Date.now() - 700000;
  await C.handleCallSignal(ctx, { vault: 1, type: 'call_request', call_id: 'stale1', ts: oldTs }, 'peer@x.ru');
  check('stale: звонок не поднят', ctx.session.callState === 'idle');
  check('stale: call_id запомнен', (await C.isCallSeen(seenEmail(ctx), 'stale1')) === true);
  check('stale call_request → missed-пилюля в messages', ctx.chat.state.messages.some(m => m.id === 'call-stale1' && m.callEvent.kind === 'missed'));
  histMock.store = {};
  // повторный stale того же call_id — НЕ дублирует пилюлю
  await C.handleCallSignal(ctx, { vault: 1, type: 'call_request', call_id: 'stale1', ts: oldTs }, 'peer@x.ru');
  check('повторный stale — пилюля не задвоена', ctx.chat.state.messages.filter(m => m.id === 'call-stale1').length === 1);
  // 4b. игнор-лист
  const ig = makeCtx({ isIgnored: () => true });
  await C.handleCallSignal(ig, { vault: 1, type: 'call_request', call_id: 'ig1', ts: Date.now() }, 'peer@x.ru');
  check('ignored: звонок погашен до state machine', ig.session.callState === 'idle');
  // 4c. новый call_request: полный подъём
  const ctx2 = makeCtx();
  apiMock.calls.length = 0;
  await C.handleCallSignal(ctx2, { vault: 1, type: 'call_request', call_id: 'new1', ts: Date.now(), sdp: 'OFFER', kemct: 'K', sender_ek: 'E' }, 'peer@x.ru');
  check('call_request → incoming_ringing + currentCall', ctx2.session.callState === 'incoming_ringing' && ctx2.session.currentCall.call_id === 'new1');
  check('offer/kemct/senderEk сохранены', ctx2.session.currentCall.offerSdp === 'OFFER' && ctx2.session.currentCall.kemct === 'K' && ctx2.session.currentCall.senderEk === 'E');
  check('ринг-таймер 180с', timers.get(ctx2.session.callRingTimer) && timers.get(ctx2.session.callRingTimer).ms === 180000);
  check('звук входящего (desktop) + системный оверлей', apiMock.calls.some(c => c[0] === 'soundPlay' && c[1] === 'incoming' && c[2] === true) && apiMock.calls.some(c => c[0] === 'showIncoming'));
  check('call-seen запомнен при подъёме', (await C.isCallSeen(seenEmail(ctx2), 'new1')) === true);
  // ретрансляция того же call_id при живом звонке — дубль, гасится
  await C.handleCallSignal(ctx2, { vault: 1, type: 'call_request', call_id: 'new1', ts: Date.now() }, 'peer@x.ru');
  check('ретрансляция живого call_id — игнор', ctx2.session.currentCall && ctx2.session.currentCall.call_id === 'new1' && ctx2.session.callState === 'incoming_ringing');
  // 4d. дедуп после отклонения: юзер уже решил — гасим
  await C.hangup(ctx2, 'reject');
  await C.handleCallSignal(ctx2, { vault: 1, type: 'call_request', call_id: 'new1', ts: Date.now() }, 'peer@x.ru');
  check('call_request после отклонения — гасится (юзер решил)', ctx2.session.callState === 'idle');
  // 4e. чужой звонок во время активного — занято
  const busy = makeCtx({ callState: 'active', currentCall: { call_id: 'mine', peer: 'peer@x.ru' } });
  relayMock.pubs.length = 0;
  cryptoMock.encVault.length = 0;
  await C.handleCallSignal(busy, { vault: 1, type: 'call_request', call_id: 'other', ts: Date.now() }, 'peer@x.ru');
  const rejBody = cryptoMock.encVault.map(p => { try { return JSON.parse(p); } catch (e) { return null; } }).filter(b => b && b.type === 'call_reject');
  check('чужой звонок в active → call_reject + missed-пилюля', rejBody.length === 1 && rejBody[0].call_id === 'other' && busy.chat.state.messages.some(m => m.id === 'call-other'));
  histMock.store = {};
  // 4f. call_accept при исходящем (hasLocalOffer) — mediaSetRemote
  const out = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'o1', peer: 'peer@x.ru', hasLocalOffer: true } });
  apiMock.calls.length = 0;
  await C.handleCallSignal(out, { vault: 1, type: 'call_accept', call_id: 'o1', ts: Date.now(), sdp: 'ANSWER' }, 'peer@x.ru');
  check('call_accept → active + setRemote(answer)', out.session.callState === 'active' && apiMock.calls.some(c => c[0] === 'setRemote' && c[2] === 'ANSWER'));
  check('ринг-таймер снят, watchdog взведён (90с)', out.session.callRingTimer === null && timers.get(out.session.mediaFallbackTimer) && timers.get(out.session.mediaFallbackTimer).ms === 90000);
  // 4g. call_sdp-гвард: не-active → дроп
  apiMock.calls.length = 0;
  await C.handleCallSignal(makeCtx(), { vault: 1, type: 'call_sdp', call_id: 'o1', ts: Date.now(), role: 'answer', sdp: 'A' }, 'peer@x.ru');
  check('call_sdp вне active — дроп (guard)', !apiMock.calls.some(c => c[0] === 'setRemote'));
  // 4h. терминальный call_end: трубка кладётся
  const act = makeCtx({ callState: 'active', currentCall: { call_id: 'a1', peer: 'peer@x.ru' } });
  await C.handleCallSignal(act, { vault: 1, type: 'call_end', call_id: 'a1', ts: Date.now() }, 'peer@x.ru');
  check('call_end → hangup(remote) → idle + ended-пилюля', act.session.callState === 'idle' && act.chat.state.messages.some(m => m.callEvent && m.callEvent.kind === 'ended'));
  check('терминал запомнен', (await C.isCallSeen(seenEmail(act), 'a1')) === true);
  histMock.store = {};
}

// ── 5. lifecycle: startCall / acceptCall / hangup ───────────────
console.log('5. lifecycle');
{
  dbMock.kv.clear();
  timers.clear();
  relayMock.pubs.length = 0;
  apiMock.calls.length = 0;
  // startCall: гудки ДО отправки, offer при наборе, ретрансляция 15с
  const ctx = makeCtx();
  await C.startCall(ctx);
  const cid = ctx.session.currentCall && ctx.session.currentCall.call_id;
  check('startCall → outgoing_ringing + hasLocalOffer', ctx.session.callState === 'outgoing_ringing' && ctx.session.currentCall.hasLocalOffer === true);
  check('call_request ушел с offer+kemct', cryptoMock.encVault.some(p => { try { const b = JSON.parse(p); return b.type === 'call_request' && b.sdp === 'OFFER_SDP' && b.kemct === 'KEMCT'; } catch (e) { return false; } }));
  check('ринг-таймер 300с + 1-й повтор через 5с (затухание, не 15с-лавина)', timers.get(ctx.session.callRingTimer).ms === 300000 && timers.get(ctx.callRequestResender.timer).ms === 5000);
  // ретрансляция тикает (viaRelay=false)
  relayMock.pubs.length = 0;
  await fireTimer(ctx.callRequestResender.timer);
  check('ретрансляция call_request — только почтой', apiMock.calls.filter(c => c[0] === 'sendReadReceipt').length >= 1 && relayMock.pubs.length === 0);
  // таймаут гудков
  await fireTimer(ctx.session.callRingTimer);
  check('таймаут гудков → cancel → idle + no_answer-пилюля', ctx.session.callState === 'idle' && ctx.chat.state.messages.some(m => m.callEvent && m.callEvent.kind === 'no_answer'));
  histMock.store = {};
  // startCall без ключа пира — no-op
  const nokey = makeCtx({ peerKeys: {} });
  await C.startCall(nokey);
  check('без peer-ключа — no-op', nokey.session.callState === 'idle');
  // stale ring timeout при active — не рвёт живой звонок
  const alive = makeCtx({ callState: 'active', currentCall: { call_id: 'z', peer: 'peer@x.ru' } });
  await C.cancelCall(alive, 'timeout');
  check('stale ring timeout в active — игнор', alive.session.callState === 'active');
  // hangup: сброс всего
  apiMock.calls.length = 0;
  const hu = makeCtx({ callState: 'active', currentCall: { call_id: 'h1', peer: 'peer@x.ru' }, callClockSec: 204, _connLostTimer: setTimeout(() => {}, 9999) });
  await C.hangup(hu, 'end');
  check('hangup: полный сброс состояния', hu.session.callState === 'idle' && hu.session.currentCall === null && hu.session.callMuted === false && hu.session.connLostTimer === null);
  check('hangup: ended-пилюля с длительностью 03:24', hu.chat.state.messages.some(m => m.callEvent && m.callEvent.kind === 'ended' && m.callEvent.duration === 204));
  check('hangup: mediaClose + звук конца', apiMock.calls.some(c => c[0] === 'close' && c[1] === 'h1') && apiMock.calls.some(c => c[0] === 'soundPlay' && c[1] === 'end'));
  histMock.store = {};
}

// ── 6. Пилюли: recordCallEvent / лейблы / callback ──────────────
console.log('6. Пилюли пропущенных');
{
  histMock.store = {};
  // чат не открыт → запись напрямую в историю
  const ctx = makeCtx({ activeChat: 'other@x.ru', unreadCounts: {}, chatVisible: () => false });
  await C.recordCallEvent(ctx, 'peer@x.ru', 'missed', Date.now(), 0, 'm1');
  check('чат закрыт → пилюля в sqlite-истории', histMock.store['peer@x.ru'] && histMock.store['peer@x.ru'].length === 1);
  check('missed + чат невидим → unread-бейдж', ctx.unreadCounts['peer@x.ru'] === 1);
  // чат открыт → в messages + сортировка
  const open = makeCtx({ activeChat: 'peer@x.ru' });
  open.chat.state.messages = [{ id: 'old', ts: 1 }];
  await C.recordCallEvent(open, 'peer@x.ru', 'ended', Date.now(), 65, 'm2');
  check('чат открыт → messages (отсортировано)', open.chat.state.messages.length === 2 && open.chat.state.messages[0].id === 'old' && open.chat.state.messages[1].id === 'call-m2');
  // дедуп пилюли
  await C.recordCallEvent(open, 'peer@x.ru', 'ended', Date.now(), 65, 'm2');
  check('повторный call_id — пилюля не задвоена', open.chat.state.messages.length === 2);
  // лейблы
  check('лейбл ended с длительностью 01:05', C.callEventLabel(labelFn(open), { callEvent: { kind: 'ended', duration: 65 } }) === 'T:call_ended · 01:05');
  check('лейбл missed', C.callEventLabel(labelFn(open), { callEvent: { kind: 'missed', duration: 0 } }) === 'T:call_missed');
  check('лейбл без callEvent → пусто', C.callEventLabel(labelFn(open), {}) === '');
  // иконки
  check('callPillIcon: ended=phone, остальное phone-off', C.callPillIcon({ callEvent: { kind: 'ended' } }) === 'phone' && C.callPillIcon({ callEvent: { kind: 'missed' } }) === 'phone-off');
  // canCallBack
  check('canCallBack: idle+ключ+expCalls', C.canCallBack(cbDeps(open), { callEvent: { kind: 'missed' } }) === true);
  check('canCallBack в active → false', C.canCallBack(cbDeps(makeCtx({ callState: 'active' })), { callEvent: {} }) === false);
}

// ── 7. Mute/speaker/ретрансляции/watchdog/часы ──────────────────
console.log('7. mute/speaker/resend/watchdog/часы');
{
  timers.clear();
  apiMock.calls.length = 0;
  const ctx = makeCtx({ currentCall: { call_id: 'q1', peer: 'peer@x.ru' } });
  // ADR-001: переключатели возвращают новое значение, App.vue его присваивает.
  // Раньше фича писала в ctx сама — проверка читала ctx.session.callMuted.
  const muteDeps = () => ({ callMuted: ctx.session.callMuted, currentCall: ctx.session.currentCall });
  const spkDeps = () => ({ callSpeaker: ctx.session.callSpeaker, currentCall: ctx.session.currentCall });
  // mute
  ctx.session.setMuted(C.toggleCallMute(muteDeps()));
  check('toggleCallMute → mediaSetMuted(true)', ctx.session.callMuted === true && apiMock.calls.some(c => c[0] === 'setMuted' && c[2] === true));
  ctx.session.setMuted(C.toggleCallMute(muteDeps()));
  check('повторный mute → false', ctx.session.callMuted === false && apiMock.calls.some(c => c[0] === 'setMuted' && c[2] === false));
  // speaker
  ctx.session.setSpeaker(C.toggleSpeaker(spkDeps()));
  check('toggleSpeaker → mediaSetSpeaker(true)', ctx.session.callSpeaker === true && apiMock.calls.some(c => c[0] === 'setSpeaker' && c[2] === true));
  // startSignalResend: тик 10с, повтор пока не connected
  ctx.session.setCallState('active');
  ctx.session.setCallMediaConnected(false);
  apiMock.calls.length = 0;
  C.startSignalResend(ctx, 'peer@x.ru', { type: 'call_accept', call_id: 'q1' }, 'q1');
  const st = timers.get(ctx.callResender.timer);
  check('resend-таймер: 1-я пауза 5с', st && st.ms === 5000);
  check('лест revпов: [5с,15с,45с,120с] — не больше 4 писем на вызов',
    JSON.stringify(C.SIGNAL_RESEND_DELAYS_MS) === JSON.stringify([5000, 15000, 45000, 120000]),
    C.SIGNAL_RESEND_DELAYS_MS);
  await fireTimer(ctx.callResender.timer);
  check('resend тик повторяет сигнал почтой', apiMock.calls.some(c => c[0] === 'sendReadReceipt'));
  // media connected → resend самоостанавливается
  ctx.session.setCallMediaConnected(true);
  await fireTimer(ctx.callResender.timer);
  check('media connected → resend остановлен', ctx.callResender.timer === null);
  // ЗАТУХАНИЕ (инцидент 12.10.2026): лавина писем сожгла почтовый резерв
  // (Яндекс: 554 5.7.1 SPAM). Максимум 4 повтора, дальше паузы нет.
  const cap = makeCtx({ currentCall: { call_id: 'cap1', peer: 'peer@x.ru' }, callState: 'active', callMediaConnected: false });
  apiMock.calls.length = 0;
  C.startSignalResend(cap, 'peer@x.ru', { type: 'call_accept', call_id: 'cap1' }, 'cap1');
  const delays = [];
  for (let i = 0; i < 6 && cap.callResender.timer; i++) {
    delays.push(timers.get(cap.callResender.timer).ms);
    await fireTimer(cap.callResender.timer);
  }
  check('ровно 4 повтора по [5000,15000,45000,120000]',
    JSON.stringify(delays) === JSON.stringify([5000, 15000, 45000, 120000]), delays);
  check('после 4-го повтора пауза не взводится (лавины нет)', cap.callResender.timer === null);
  check('ровно 4 письма за цикл ожидания', apiMock.calls.filter(c => c[0] === 'sendReadReceipt').length === 4);
  // sendTerminalRepeat: 3 отправки (сейчас + 3с + 7с)
  timers.clear();
  apiMock.calls.length = 0;
  relayMock.pubs.length = 0;
  C.sendTerminalRepeat(ctx, 'peer@x.ru', 'call_end', 'q1');
  const t3 = [...timers.entries()].find(([, t]) => t.ms === 3000);
  const t7 = [...timers.entries()].find(([, t]) => t.ms === 7000);
  await fireTimer(t3[0]); await fireTimer(t7[0]);
  check('sendTerminalRepeat: 3 письма; релей — ровно 1 первое отправление с wake=false', apiMock.calls.filter(c => c[0] === 'sendReadReceipt').length === 3 && relayMock.pubs.length === 1 && relayMock.pubs[0].opts.wake === false);
  // watchdog: 90с без медиа → auto hangup
  timers.clear();
  const wd = makeCtx({ callState: 'active', currentCall: { call_id: 'w1', peer: 'peer@x.ru' }, callMediaConnected: false });
  C.armMediaFallback(wd);
  await fireTimer(wd.session.mediaFallbackTimer);
  check('watchdog 90с → hangup(connect_timeout) + call_end собеседнику', wd.session.callState === 'idle' && apiMock.calls.some(c => c[0] === 'sendReadReceipt'));
  // часы — владелец session.startCallClock/stopCallClock (ADR-004 E).
  // setInterval-хендл попадает в управляемую карту timers → fireTimer тикует.
  const ck = makeCtx();
  const id = ck.session.startCallClock();
  await fireTimer(id);
  await fireTimer(id);
  check('часы тикают (2с)', ck.session.callClockSec === 2);
  ck.session.stopCallClock();
  check('stopCallClock', ck.session.callClockTimer === null);
  // fastPolling — делегирует idleLoop (зависимость передаётся функцией)
  let idleCalled = 0;
  C.startFastPolling(() => idleCalled++);
  check('startFastPolling → idleLoop', idleCalled === 1);
}

// ── 8. Звук ────────────────────────────────────────────────────
console.log('8. playCallSound/stopCallSound');
{
  audioInstances.length = 0;
  apiMock.calls.length = 0;
  // desktop: cpal через api
  const d = makeCtx();
  C.playCallSound(d, 'incoming', true);
  check('desktop: mediaSoundPlay(incoming, loop)', apiMock.calls.some(c => c[0] === 'soundPlay' && c[1] === 'incoming' && c[2] === true));
  // маппинг рингтонов из настроек
  apiMock.calls.length = 0;
  C.playCallSound(makeCtx({ callRingtoneIncoming: 'classic' }), 'incoming', true);
  check('маппинг выбранного рингтона', apiMock.calls.some(c => c[0] === 'soundPlay' && c[1] === 'classic'));
  // Android: HTML5 Audio
  const a = makeCtx({ isAndroid: true });
  C.playCallSound(a, 'incoming', true);
  check('Android: Audio(/sounds/ring_incoming.wav), loop, vol 0.85', audioInstances.length === 1 && audioInstances[0].src === '/sounds/ring_incoming.wav' && audioInstances[0].loop === true && audioInstances[0].volume === 0.85);
  C.playCallSound(a, 'end', false);
  check('Android одноразовый: старый остановлен, новый без loop', audioInstances[0].paused === true && audioInstances[1].loop === false);
  // звук никогда не бросает
  const origPlay = apiMock.mediaSoundPlay;
  apiMock.mediaSoundPlay = () => { throw new Error('cpal boom'); };
  C.playCallSound(makeCtx(), 'incoming', true); // не бросает
  check('звук не бросает (state machine важнее)', true);
  apiMock.mediaSoundPlay = origPlay;
  // stopCallSound
  apiMock.calls.length = 0;
  const s = makeCtx({ isAndroid: true, callSoundEl: audioInstances[1] });
  C.stopCallSound(s);
  check('stopCallSound: Audio.pause + (desktop) mediaSoundStop', audioInstances[1].paused === true && s.session.callSoundEl === null);
  const s2 = makeCtx();
  C.stopCallSound(s2);
  check('stopCallSound desktop → mediaSoundStop', apiMock.calls.some(c => c[0] === 'soundStop'));
}

// ── 9. Баунс письма-вызова → мгновенная отмена (12.10.2026) ─────
console.log('9. onMailBounce (DSN: письмо-вызов не дошло)');
{
  // Регресс-цена: раньше DSN не разбирался вовсе (incoming.js отбрасывает
  // не-шифртекст) → вызов висел в гудках и писал «нет ответа», хотя письмо
  // отбито провайдером.
  const ctx = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'b1', peer: 'peer@x.ru' } });
  toasts.length = 0;
  const hit = await C.onMailBounce(ctx, ['peer@x.ru'], '554 5.7.1 Message rejected under suspicion of SPAM');
  check('баунс про собеседника → вызов отменён', hit === true && ctx.session.callState === 'idle', { state: ctx.session.callState });
  check('тост с причиной показан', toasts.length === 1, toasts);
  check('пилюля undeliverable (не «нет ответа»)', ctx.chat.state.messages.some(m => m.callEvent && m.callEvent.kind === 'undeliverable'), ctx.chat.state.messages.map(m => m.callEvent));
  check('иконка лейбла — phone-off', C.callPillIcon({ callEvent: { kind: 'undeliverable' } }) === 'phone-off');
  check('лейбл undeliverable', C.callEventLabel(labelFn(ctx), { callEvent: { kind: 'undeliverable', duration: 0 } }) === 'T:call_undeliverable');

  // Живой звонок 12.10.2026 (это и был «сброшенный вызов при приложении на
  // экране»): релей принял call_request, телефон показал входящий, но
  // ПОЧТОВАЯ копия отбилась как спам — старый код гасил вызов по баунсу.
  // Теперь при relayDelivered баунс дубля игнорируется: вызов живёт.
  const relayed = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'b6', peer: 'peer@x.ru', relayDelivered: true } });
  toasts.length = 0;
  const relayedHit = await C.onMailBounce(relayed, ['peer@x.ru'], '554 5.7.1 Message rejected under suspicion of SPAM');
  check('relayDelivered → баунс НЕ гасит вызов', relayedHit === false && relayed.callState === 'outgoing_ringing', { state: relayed.callState });
  check('relayDelivered → нет ложного тоста «письмо не доставлено»', toasts.length === 0, toasts);

  // Регистр и алиасы: адрес в DSN может быть в другом регистре.
  const up = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'b2', peer: 'Peer@X.ru' } });
  const upHit = await C.onMailBounce(up, ['PEER@x.ru'], '550 5.1.1 User unknown');
  check('регистр адреса не мешает', upHit === true && up.session.callState === 'idle');

  // Чужой адресат: баунс не про наш звонок — НЕ гасим живой вызов.
  const other = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'b3', peer: 'peer@x.ru' } });
  const otherHit = await C.onMailBounce(other, ['someone@ya.ru'], '550');
  check('чужой получатель → вызов не тронут', otherHit === false && other.session.callState === 'outgoing_ringing');

  // Адрес не распознали (незнакомый провайдер): тоже не гасим — ложная
  // отмена живого вызова хуже лишних минут гудков.
  const unparsed = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'b4', peer: 'peer@x.ru' } });
  const unparsedHit = await C.onMailBounce(unparsed, [], '');
  check('пустой recipients → не гасим', unparsedHit === false && unparsed.session.callState === 'outgoing_ringing');

  // Живой разговор баунсами не рвём.
  const live = makeCtx({ callState: 'active', currentCall: { call_id: 'b5', peer: 'peer@x.ru' } });
  check('active-звонок не рвём', (await C.onMailBounce(live, ['peer@x.ru'], '')) === false && live.session.callState === 'active');

  timers.clear(); toasts.length = 0;
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
