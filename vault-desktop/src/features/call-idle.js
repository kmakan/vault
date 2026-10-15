// ADR-004 H. Владельцы idle-таймеров (страховочный fast-fetch + connLost grace).
// call-idle.js — единственный владелец setInterval/setTimeout для idle-цикла.

export function createFastFetcher({ intervalMs = 7000 } = {}) {
  // Страховочный фетч 7с: СПАМ/сигналы звонков, когда постоянный IDLE
  // (Rust-монитор) недоступен. busy-флаг: анти-наклад — если предыдущий
  // fetch длится, следующий пропускаем (аналог _fastFetchBusy).
  let timer = null;
  let busy = false;
  return {
    start(cb) {
      if (timer || busy) return false; // уже запущен или занят
      const tick = () => {
        if (busy) return;
        busy = true;
        try { cb(); }
        catch (e) { console.warn('[idle] fastFetch err:', e && e.message || e); }
        finally { busy = false; }
      };
      tick();
      timer = setInterval(tick, intervalMs);
      return true;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      busy = false;
    },
    later(ms, cb) { return later(ms, cb); },
    get timer() { return timer; },
    get busy() { return busy; },
  };
}

export function createConnLostGuard({ graceMs = 10000 } = {}) {
  // Таймер благоустройной перерыва ICE: disconnected → grace 10с, потом
  // hangup. Владелец таймера — call-idle.js (не calls.js/App.state machine).
  let timer = null;
  return {
    arm(expiryCb) {
      this.clear();
      timer = setTimeout(() => {
        timer = null;
        try { expiryCb(); }
        catch (e) { console.warn('[idle] connLost expiry err:', e && e.message || e); }
      }, graceMs);
      return timer;
    },
    clear() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get timer() { return timer; },
  };
}

// Синглтоны проекта (App.vue + calls.js через ctx или импорт).
export const fastFetcher = createFastFetcher();
export const connLostGuard = createConnLostGuard({ graceMs: 10000 });
