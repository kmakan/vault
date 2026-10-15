// call-session — владелец состояния звонка (ADR-004, Этап C).
//
// ЗАЧЕМ. calls.js (самый связный feature, 145 ссылок на ctx) мутировал 13
// state-полей App.data напрямую: currentCall/callState/callClockSec/…/_connLostTimer.
// Состояние звонка — не capability (capability вынесен в Этап B/deps). Функции
// звонка работают через владельца: в Vue `reactive(createCallSession())` в
// composition root, в тестах — `s.setX()`/`s.X`.
//
// ПАТТЕРН this.state (как chat-store): мутаторы пишут this.state.*, поэтому
// `reactive(createCallSession())` перехватывает writes через Vue Proxy.
// Замыкание `state`, обходящее Proxy, — проверенная ошибка (smoke C5).
//
// subscribe: для non-Vue тестов. Vue использует reactive автоматически.
// п 5.3 ADR-003: state — plain object, reactivity добавит composition root.
export function createCallSession(initial = {}) {
  const state = {
    currentCall: null,
    callState: 'idle',
    callClockSec: 0,
    callClockTimer: null,
    callRingTimer: null,
    callRingtoneIncoming: 'incoming',
    callRingtoneOutgoing: 'outgoing',
    callSoundEl: null,
    callMuted: false,
    callSpeaker: false,
    lastCallId: null,
    pendingKemct: null,
    pendingSenderEk: null,
    callMediaConnected: false,
    mediaFallbackTimer: null,
    connLostTimer: null,
    sendSeen: false,
    localOffer: null,
    remoteOffer: null,
    ...initial,
  };
  const listeners = new Set();
  const _notify = () => listeners.forEach((l) => l());
  const api = {
    state,
    // ── READ ──
    get currentCall() { return this.state.currentCall; },
    get callState() { return this.state.callState; },
    get callClockSec() { return this.state.callClockSec; },
    get callClockTimer() { return this.state.callClockTimer; },
    get callRingTimer() { return this.state.callRingTimer; },
    get callRingtoneIncoming() { return this.state.callRingtoneIncoming; },
    get callRingtoneOutgoing() { return this.state.callRingtoneOutgoing; },
    get callSoundEl() { return this.state.callSoundEl; },
    get callMuted() { return this.state.callMuted; },
    get callSpeaker() { return this.state.callSpeaker; },
    get lastCallId() { return this.state.lastCallId; },
    get pendingKemct() { return this.state.pendingKemct; },
    get pendingSenderEk() { return this.state.pendingSenderEk; },
    get callMediaConnected() { return this.state.callMediaConnected; },
    get mediaFallbackTimer() { return this.state.mediaFallbackTimer; },
    get connLostTimer() { return this.state.connLostTimer; },
    get sendSeen() { return this.state.sendSeen; },
    get localOffer() { return this.state.localOffer; },
    get remoteOffer() { return this.state.remoteOffer; },
    // aliases (calls.js legacy callMuted→muted, callSpeaker→speaker)
    get muted() { return this.state.callMuted; },
    get speaker() { return this.state.callSpeaker; },
    // ── WRITE ──
    setCurrentCall(v) { this.state.currentCall = v; _notify(); },
    setCallState(v) { this.state.callState = v; _notify(); },
    setCallClockSec(v) { this.state.callClockSec = v; _notify(); },
    setCallClockTimer(v) { this.state.callClockTimer = v; _notify(); },
    setCallRingTimer(v) { this.state.callRingTimer = v; _notify(); },
    setRingtone(kind, v) {
      if (kind === 'incoming') this.state.callRingtoneIncoming = v;
      else this.state.callRingtoneOutgoing = v;
      _notify();
    },
    setSoundEl(v) { this.state.callSoundEl = v; _notify(); },
    setMuted(v) { this.state.callMuted = !!v; _notify(); },
    setSpeaker(v) { this.state.callSpeaker = !!v; _notify(); },
    setLastCallId(v) { this.state.lastCallId = v; _notify(); },
    setPendingKemct(v) { this.state.pendingKemct = v; _notify(); },
    setPendingSenderEk(v) { this.state.pendingSenderEk = v; _notify(); },
    setCallMediaConnected(v) { this.state.callMediaConnected = !!v; _notify(); },
    setMediaFallbackTimer(v) { this.state.mediaFallbackTimer = v; _notify(); },
    setConnLostTimer(v) { this.state.connLostTimer = v; _notify(); },
    setSendSeen(v) { this.state.sendSeen = !!v; _notify(); },
    setOffers({ local, remote }) {
      if (local !== undefined) this.state.localOffer = local;
      if (remote !== undefined) this.state.remoteOffer = remote;
      _notify();
    },
    reset() {
      Object.assign(this.state, {
        currentCall: null, callState: 'idle', callClockSec: 0, callClockTimer: null,
        callRingTimer: null, callRingtoneIncoming: null, callRingtoneOutgoing: null,
        callSoundEl: null, callMuted: false, callSpeaker: false, lastCallId: null,
        pendingKemct: null, pendingSenderEk: null, callMediaConnected: false,
        mediaFallbackTimer: null, connLostTimer: null, sendSeen: false,
        localOffer: null, remoteOffer: null,
      });
      _notify();
    },
    // non-Vue subscribe; Vue использует reactive автоматически.
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _all() { return { ...this.state }; },
  };
  return api;
}
