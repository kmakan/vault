// Node-смоук features/calls.js — семантика звонковой state machine без
// Vue/Tauri (паттерн incoming-smoke.mjs). Таймеры/Audio — управляемые моки.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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
  relayPublish: (from, to, id, content, opts) => { relayMock.pubs.push({ from, to, id, content, opts }); },
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

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/relay-client.js', 'export const relayPublish = (...a) => globalThis.__relayMock.relayPublish(...a);');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/history.js', 'export const saveHistory = (a, c, m) => globalThis.__histMock.saveHistory(a, c, m); export const loadHistory = (a, c) => globalThis.__histMock.loadHistory(a, c);');
globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__relayMock = relayMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__histMock = histMock;

let src = readFileSync(ROOT + '/../src/features/calls.js', 'utf8');
src = src
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../relay-client.js'", 'from "' + MOCKS + '/relay-client.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"')
  .replace("from '../history.js'", 'from "' + MOCKS + '/history.js"');
writeFileSync(MOCKS + '/features-calls.mjs', src);
const C = await import(MOCKS + '/features-calls.mjs');

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
  return Object.assign({
    email: 'me@x.ru',
    isAndroid: false,
    // звонковое состояние
    callState: 'idle',
    currentCall: null,
    lastCallId: null,
    callMuted: false,
    callSpeaker: false,
    callMediaConnected: false,
    callClockSec: 0,
    callClockTimer: null,
    callRingTimer: null,
    callResendTimer: null,
    callSoundEl: null,
    callStartedAt: 0,
    callRingtoneIncoming: null,
    callRingtoneOutgoing: null,
    _signalResendTimer: null,
    _mediaFallbackTimer: null,
    _connLostTimer: null,
    _pendingKemct: null,
    _pendingSenderEk: null,
    callPeerName: 'Пир',
    // чат-контекст
    activeChat: 'peer@x.ru',
    activeChatType: 'chat',
    peerKeys: { 'peer@x.ru': 'PUB' },
    peerPqKeys: {},
    messages: [],
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
}
const toasts = [];

// ── 1. Дедуп call-seen ─────────────────────────────────────────
console.log('1. Дедуп звонков (kv call-seen)');
{
  dbMock.kv.clear();
  const ctx = makeCtx();
  check('isCallSeen несуществующего → false', (await C.isCallSeen(ctx, 'c1')) === false);
  await C.rememberCallSeen(ctx, 'c1');
  check('remember→isCallSeen roundtrip', (await C.isCallSeen(ctx, 'c1')) === true);
  // лимит 100: старые вытесняются
  for (let i = 0; i < 120; i++) await C.rememberCallSeen(ctx, 'x' + i);
  const raw = JSON.parse(dbMock.kv.get('call-seen'));
  check('лимит 100 call_id', raw.length === 100 && !raw.includes('c1'));
  // сбой kv — тихо
  const origGet = dbMock.kvGet;
  dbMock.kvGet = async () => { throw new Error('kv down'); };
  check('сбой kv → isCallSeen false', (await C.isCallSeen(ctx, 'zz')) === false);
  await C.rememberCallSeen(ctx, 'zz'); // не бросается
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
  check('stale: звонок не поднят', ctx.callState === 'idle');
  check('stale: call_id запомнен', (await C.isCallSeen(ctx, 'stale1')) === true);
  check('stale call_request → missed-пилюля в messages', ctx.messages.some(m => m.id === 'call-stale1' && m.callEvent.kind === 'missed'));
  histMock.store = {};
  // повторный stale того же call_id — НЕ дублирует пилюлю
  await C.handleCallSignal(ctx, { vault: 1, type: 'call_request', call_id: 'stale1', ts: oldTs }, 'peer@x.ru');
  check('повторный stale — пилюля не задвоена', ctx.messages.filter(m => m.id === 'call-stale1').length === 1);
  // 4b. игнор-лист
  const ig = makeCtx({ isIgnored: () => true });
  await C.handleCallSignal(ig, { vault: 1, type: 'call_request', call_id: 'ig1', ts: Date.now() }, 'peer@x.ru');
  check('ignored: звонок погашен до state machine', ig.callState === 'idle');
  // 4c. новый call_request: полный подъём
  const ctx2 = makeCtx();
  apiMock.calls.length = 0;
  await C.handleCallSignal(ctx2, { vault: 1, type: 'call_request', call_id: 'new1', ts: Date.now(), sdp: 'OFFER', kemct: 'K', sender_ek: 'E' }, 'peer@x.ru');
  check('call_request → incoming_ringing + currentCall', ctx2.callState === 'incoming_ringing' && ctx2.currentCall.call_id === 'new1');
  check('offer/kemct/senderEk сохранены', ctx2.currentCall.offerSdp === 'OFFER' && ctx2.currentCall.kemct === 'K' && ctx2.currentCall.senderEk === 'E');
  check('ринг-таймер 180с', timers.get(ctx2.callRingTimer) && timers.get(ctx2.callRingTimer).ms === 180000);
  check('звук входящего (desktop) + системный оверлей', apiMock.calls.some(c => c[0] === 'soundPlay' && c[1] === 'incoming' && c[2] === true) && apiMock.calls.some(c => c[0] === 'showIncoming'));
  check('call-seen запомнен при подъёме', (await C.isCallSeen(ctx2, 'new1')) === true);
  // ретрансляция того же call_id при живом звонке — дубль, гасится
  await C.handleCallSignal(ctx2, { vault: 1, type: 'call_request', call_id: 'new1', ts: Date.now() }, 'peer@x.ru');
  check('ретрансляция живого call_id — игнор', ctx2.currentCall && ctx2.currentCall.call_id === 'new1' && ctx2.callState === 'incoming_ringing');
  // 4d. дедуп после отклонения: юзер уже решил — гасим
  await C.hangup(ctx2, 'reject');
  await C.handleCallSignal(ctx2, { vault: 1, type: 'call_request', call_id: 'new1', ts: Date.now() }, 'peer@x.ru');
  check('call_request после отклонения — гасится (юзер решил)', ctx2.callState === 'idle');
  // 4e. чужой звонок во время активного — занято
  const busy = makeCtx({ callState: 'active', currentCall: { call_id: 'mine', peer: 'peer@x.ru' } });
  relayMock.pubs.length = 0;
  cryptoMock.encVault.length = 0;
  await C.handleCallSignal(busy, { vault: 1, type: 'call_request', call_id: 'other', ts: Date.now() }, 'peer@x.ru');
  const rejBody = cryptoMock.encVault.map(p => { try { return JSON.parse(p); } catch (e) { return null; } }).filter(b => b && b.type === 'call_reject');
  check('чужой звонок в active → call_reject + missed-пилюля', rejBody.length === 1 && rejBody[0].call_id === 'other' && busy.messages.some(m => m.id === 'call-other'));
  histMock.store = {};
  // 4f. call_accept при исходящем (hasLocalOffer) — mediaSetRemote
  const out = makeCtx({ callState: 'outgoing_ringing', currentCall: { call_id: 'o1', peer: 'peer@x.ru', hasLocalOffer: true } });
  apiMock.calls.length = 0;
  await C.handleCallSignal(out, { vault: 1, type: 'call_accept', call_id: 'o1', ts: Date.now(), sdp: 'ANSWER' }, 'peer@x.ru');
  check('call_accept → active + setRemote(answer)', out.callState === 'active' && apiMock.calls.some(c => c[0] === 'setRemote' && c[2] === 'ANSWER'));
  check('ринг-таймер снят, watchdog взведён (90с)', out.callRingTimer === null && timers.get(out._mediaFallbackTimer) && timers.get(out._mediaFallbackTimer).ms === 90000);
  // 4g. call_sdp-гвард: не-active → дроп
  apiMock.calls.length = 0;
  await C.handleCallSignal(makeCtx(), { vault: 1, type: 'call_sdp', call_id: 'o1', ts: Date.now(), role: 'answer', sdp: 'A' }, 'peer@x.ru');
  check('call_sdp вне active — дроп (guard)', !apiMock.calls.some(c => c[0] === 'setRemote'));
  // 4h. терминальный call_end: трубка кладётся
  const act = makeCtx({ callState: 'active', currentCall: { call_id: 'a1', peer: 'peer@x.ru' } });
  await C.handleCallSignal(act, { vault: 1, type: 'call_end', call_id: 'a1', ts: Date.now() }, 'peer@x.ru');
  check('call_end → hangup(remote) → idle + ended-пилюля', act.callState === 'idle' && act.messages.some(m => m.callEvent && m.callEvent.kind === 'ended'));
  check('терминал запомнен', (await C.isCallSeen(act, 'a1')) === true);
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
  const cid = ctx.currentCall && ctx.currentCall.call_id;
  check('startCall → outgoing_ringing + hasLocalOffer', ctx.callState === 'outgoing_ringing' && ctx.currentCall.hasLocalOffer === true);
  check('call_request ушел с offer+kemct', cryptoMock.encVault.some(p => { try { const b = JSON.parse(p); return b.type === 'call_request' && b.sdp === 'OFFER_SDP' && b.kemct === 'KEMCT'; } catch (e) { return false; } }));
  check('ринг-таймер 300с + ретрансляция 15с', timers.get(ctx.callRingTimer).ms === 300000 && timers.get(ctx.callResendTimer).ms === 15000);
  // ретрансляция тикает (viaRelay=false)
  relayMock.pubs.length = 0;
  await fireTimer(ctx.callResendTimer);
  check('ретрансляция call_request — только почтой', apiMock.calls.filter(c => c[0] === 'sendReadReceipt').length >= 1 && relayMock.pubs.length === 0);
  // таймаут гудков
  await fireTimer(ctx.callRingTimer);
  check('таймаут гудков → cancel → idle + no_answer-пилюля', ctx.callState === 'idle' && ctx.messages.some(m => m.callEvent && m.callEvent.kind === 'no_answer'));
  histMock.store = {};
  // startCall без ключа пира — no-op
  const nokey = makeCtx({ peerKeys: {} });
  await C.startCall(nokey);
  check('без peer-ключа — no-op', nokey.callState === 'idle');
  // stale ring timeout при active — не рвёт живой звонок
  const alive = makeCtx({ callState: 'active', currentCall: { call_id: 'z', peer: 'peer@x.ru' } });
  await C.cancelCall(alive, 'timeout');
  check('stale ring timeout в active — игнор', alive.callState === 'active');
  // hangup: сброс всего
  apiMock.calls.length = 0;
  const hu = makeCtx({ callState: 'active', currentCall: { call_id: 'h1', peer: 'peer@x.ru' }, callClockSec: 204, _connLostTimer: setTimeout(() => {}, 9999) });
  await C.hangup(hu, 'end');
  check('hangup: полный сброс состояния', hu.callState === 'idle' && hu.currentCall === null && hu.callMuted === false && hu._connLostTimer === null);
  check('hangup: ended-пилюля с длительностью 03:24', hu.messages.some(m => m.callEvent && m.callEvent.kind === 'ended' && m.callEvent.duration === 204));
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
  const open = makeCtx({ activeChat: 'peer@x.ru', messages: [{ id: 'old', ts: 1 }] });
  await C.recordCallEvent(open, 'peer@x.ru', 'ended', Date.now(), 65, 'm2');
  check('чат открыт → messages (отсортировано)', open.messages.length === 2 && open.messages[0].id === 'old' && open.messages[1].id === 'call-m2');
  // дедуп пилюли
  await C.recordCallEvent(open, 'peer@x.ru', 'ended', Date.now(), 65, 'm2');
  check('повторный call_id — пилюля не задвоена', open.messages.length === 2);
  // лейблы
  check('лейбл ended с длительностью 01:05', C.callEventLabel(open, { callEvent: { kind: 'ended', duration: 65 } }) === 'T:call_ended · 01:05');
  check('лейбл missed', C.callEventLabel(open, { callEvent: { kind: 'missed', duration: 0 } }) === 'T:call_missed');
  check('лейбл без callEvent → пусто', C.callEventLabel(open, {}) === '');
  // иконки
  check('callPillIcon: ended=phone, остальное phone-off', C.callPillIcon({ callEvent: { kind: 'ended' } }) === 'phone' && C.callPillIcon({ callEvent: { kind: 'missed' } }) === 'phone-off');
  // canCallBack
  check('canCallBack: idle+ключ+expCalls', C.canCallBack(open, { callEvent: { kind: 'missed' } }) === true);
  check('canCallBack в active → false', C.canCallBack(makeCtx({ callState: 'active' }), { callEvent: {} }) === false);
}

// ── 7. Mute/speaker/ретрансляции/watchdog/часы ──────────────────
console.log('7. mute/speaker/resend/watchdog/часы');
{
  timers.clear();
  apiMock.calls.length = 0;
  const ctx = makeCtx({ currentCall: { call_id: 'q1', peer: 'peer@x.ru' } });
  // mute
  C.toggleCallMute(ctx);
  check('toggleCallMute → mediaSetMuted(true)', ctx.callMuted === true && apiMock.calls.some(c => c[0] === 'setMuted' && c[2] === true));
  C.toggleCallMute(ctx);
  check('повторный mute → false', ctx.callMuted === false && apiMock.calls.some(c => c[0] === 'setMuted' && c[2] === false));
  // speaker
  C.toggleSpeaker(ctx);
  check('toggleSpeaker → mediaSetSpeaker(true)', ctx.callSpeaker === true && apiMock.calls.some(c => c[0] === 'setSpeaker' && c[2] === true));
  // startSignalResend: тик 10с, повтор пока не connected
  ctx.callState = 'active';
  ctx.callMediaConnected = false;
  apiMock.calls.length = 0;
  C.startSignalResend(ctx, 'peer@x.ru', { type: 'call_accept', call_id: 'q1' }, 'q1');
  const st = timers.get(ctx._signalResendTimer);
  check('resend-таймер 10с', st && st.ms === 10000);
  await fireTimer(ctx._signalResendTimer);
  check('resend тик повторяет сигнал почтой', apiMock.calls.some(c => c[0] === 'sendReadReceipt'));
  // media connected → resend самоостанавливается
  ctx.callMediaConnected = true;
  await fireTimer(ctx._signalResendTimer);
  check('media connected → resend остановлен', ctx._signalResendTimer === null);
  // sendTerminalRepeat: 3 отправки (сейчас + 3с + 7с)
  timers.clear();
  apiMock.calls.length = 0;
  relayMock.pubs.length = 0;
  C.sendTerminalRepeat(ctx, 'peer@x.ru', 'call_end', 'q1');
  const t3 = [...timers.entries()].find(([, t]) => t.ms === 3000);
  const t7 = [...timers.entries()].find(([, t]) => t.ms === 7000);
  await fireTimer(t3[0]); await fireTimer(t7[0]);
  check('sendTerminalRepeat: 3 попытки, все viaRelay=false', apiMock.calls.filter(c => c[0] === 'sendReadReceipt').length === 3 && relayMock.pubs.length === 0);
  // watchdog: 90с без медиа → auto hangup
  timers.clear();
  const wd = makeCtx({ callState: 'active', currentCall: { call_id: 'w1', peer: 'peer@x.ru' }, callMediaConnected: false });
  C.armMediaFallback(wd);
  await fireTimer(wd._mediaFallbackTimer);
  check('watchdog 90с → hangup(connect_timeout) + call_end собеседнику', wd.callState === 'idle' && apiMock.calls.some(c => c[0] === 'sendReadReceipt'));
  // часы
  const ck = makeCtx();
  C.startCallClock(ck);
  await fireTimer(ck.callClockTimer);
  await fireTimer(ck.callClockTimer);
  check('часы тикают (2с)', ck.callClockSec === 2);
  C.stopCallClock(ck);
  check('stopCallClock', ck.callClockTimer === null);
  // fastPolling — делегирует idleLoop
  let idleCalled = 0;
  C.startFastPolling({ idleLoop: () => idleCalled++ });
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
  check('stopCallSound: Audio.pause + (desktop) mediaSoundStop', audioInstances[1].paused === true && s.callSoundEl === null);
  const s2 = makeCtx();
  C.stopCallSound(s2);
  check('stopCallSound desktop → mediaSoundStop', apiMock.calls.some(c => c[0] === 'soundStop'));
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
