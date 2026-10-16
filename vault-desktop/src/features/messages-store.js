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
    tick() { state.ephemeralTick += 1; },
    hasTimer(key) { return !!state.ephemeralTimers[key]; },
    setTimer(key, fn, ms) { state.ephemeralTimers[key] = setTimeout(fn, ms); },
    clearTimer(key) {
      if (state.ephemeralTimers[key]) clearTimeout(state.ephemeralTimers[key]);
      delete state.ephemeralTimers[key];
    },
    clearAllTimers() {
      for (const k of Object.keys(state.ephemeralTimers)) clearTimeout(state.ephemeralTimers[k]);
      state.ephemeralTimers = {};
    },
    setCurrentTtl(ttl) { state.currentEphemeralTtl = ttl; },
    getCurrentTtl() { return state.currentEphemeralTtl; },
    // Полный сброс (logout/reset).
    reset() {
      for (const k of Object.keys(state.ephemeralTimers)) clearTimeout(state.ephemeralTimers[k]);
      state.ephemeralTimers = {};
      state.ephemeralTick = 0;
      state.currentEphemeralTtl = 0;
    },
  };
}
export const messagesStore = createMessagesStore();
