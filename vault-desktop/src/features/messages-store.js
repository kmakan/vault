// ADR-004 J.7: owner для состояния исчезающих сообщений (ephemeral).
// (быв. App.vue data: ephemeralTimers/ephemeralTick/currentEphemeralTtl.)
// ephemeralTtlOf/setEphemeralTtl инь db-kv (MsgStore.ephemeralTtlOf) —
// остаются тонкими proxy в App.vue (не inject этот owner).
// zero-import: Timer (setTimeout/clearTimeout) — глобалы браузера и Node.
export function createMessagesStore() {
  const state = {
    ephemeralTimers: {},   // { msgKey: timeoutId }, msgKey = chatId + ':' + msgId
    ephemeralTick: 0,      // re-render trigger для индикатора TTL в шапке
    currentEphemeralTtl: 0,// выбранный TTL для 1-на-1 / группы (сек)
  };
  return {
    state,
    tick() { this.state.ephemeralTick += 1; },
    hasTimer(key) { return !!this.state.ephemeralTimers[key]; },
    setTimer(key, fn, ms) { this.state.ephemeralTimers[key] = setTimeout(fn, ms); },
    clearTimer(key) {
      if (this.state.ephemeralTimers[key]) clearTimeout(this.state.ephemeralTimers[key]);
      delete this.state.ephemeralTimers[key];
    },
    clearAllTimers() {
      for (const k of Object.keys(this.state.ephemeralTimers)) clearTimeout(this.state.ephemeralTimers[k]);
      this.state.ephemeralTimers = {};
    },
    setCurrentTtl(ttl) { this.state.currentEphemeralTtl = ttl; },
    getCurrentTtl() { return this.state.currentEphemeralTtl; },
    // Полный сброс (logout/reset).
    reset() {
      for (const k of Object.keys(this.state.ephemeralTimers)) clearTimeout(this.state.ephemeralTimers[k]);
      this.state.ephemeralTimers = {};
      this.state.ephemeralTick = 0;
      this.state.currentEphemeralTtl = 0;
    },
  };
}
export const messagesStore = createMessagesStore();
