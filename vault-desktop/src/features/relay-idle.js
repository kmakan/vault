// ADR-004 H+. Владельцы таймеров релейного IDLE-цикла (relay.js).
// Вынесены setInterval/setTimeout из relay.js, чтобы он был state-machine.
export function createRelayTicker({ tickMs = 5000 } = {}) {
  // Тик релейного health-consume 5с. asyncCb — fire-and-forget (unhandled
  // rejections ловятся внутри relay.js, здесь — сторожевой catch).
  //
  // ПЕРВЫЙ ТИК — ЧЕРЕЗ ИНТЕРВАЛ, не немедленно (восстановлено по bcc2ac21).
  // Немедленный тик давал ДВОЙНОЙ мгновенный consume: relay.js сразу после
  // start сам зовёт relayConsume(ctx) («мгновенный первый consume» — чтобы
  // ntfy-пуш разбудил холодный старт и call_request не ждал 5с).
  let timer = null;
  return {
    start(asyncCb) {
      if (timer) return false; // уже запущен (idempotent)
      const tick = () => {
        void asyncCb().catch((e) =>
          console.warn('[relay] ticker err:', e && e.message || e)
        );
      };
      timer = setInterval(tick, tickMs);
      return true;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    get timer() { return timer; },
  };
}

export function createFastFetchCycle({ tickMs = 7000 } = {}) {
  // Страховочный фетч email 7с (СПАМ + сигналы звонков) — аналог fastFetcher
  // из call-idle.js, но async-загрузка (loadEmailsFast). busy-флаг = анти-налож.
  //
  // Первый тик — через интервал (восстановлено по bcc2ac21): немедленный фетч
  // на старте конкурировал за IMAP-lock с идущей загрузкой почты.
  let timer = null, busy = false;
  return {
    start(asyncCb) {
      if (timer) return false;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try { await asyncCb(); }
        catch (e) { console.warn('[relay] fastFetch err:', e && e.message || e); }
        finally { busy = false; }
      };
      timer = setInterval(() => { void tick(); }, tickMs);
      return true;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } busy = false; },
    get timer() { return timer; },
    get busy() { return busy; },
  };
}

export function createPollingCycle({ intervalMs = 30000 } = {}) {
  // Поллинг 30с (fallback при мёртвом релее). busy-флаг: anti-наложение
  // IMAP lock (Gmail троттлит → 35с удерживает lock, следующий тик skip).
  //
  // Первый тик — через интервал (восстановлено по bcc2ac21): немедленный
  // полный поллинг на старте дрался за IMAP-lock с первичной загрузкой
  // почты — «Timed out waiting for email client lock», чаты пустые.
  let timer = null, busy = false;
  return {
    start(asyncCb, ms = intervalMs) {
      if (timer) return false;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try { await asyncCb(); }
        catch (e) { console.warn('[relay] poll err:', e && e.message || e); }
        finally { busy = false; }
      };
      timer = setInterval(() => { void tick(); }, ms);
      return true;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } busy = false; },
    get timer() { return timer; },
    get busy() { return busy; },
  };
}

export function createIdleFallback({ delayMs = 60000 } = {}) {
  // Одиночный 60с fallback к idleLoop при падении Rust-monitor IDLE.
  let timer = null;
  return {
    arm(cb) {
      this.clear();
      timer = setTimeout(() => {
        timer = null;
        try { cb(); } catch (e) { console.warn('[relay] idleFallback err:', e && e.message || e); }
      }, delayMs);
      return timer;
    },
    clear() { if (timer) { clearTimeout(timer); timer = null; } },
    get timer() { return timer; },
  };
}

export const relayTicker = createRelayTicker();
export const fastFetchCycle = createFastFetchCycle();
export const pollingCycle = createPollingCycle();
export const idleFallback = createIdleFallback();

// ADR-004 I.3: IMAP IDLE state — singleton-владелец для idleActive/idleStop
// (relay.js раньше держал их в App.data и писал через ctx). Теперь relay.js
// оперирует idleState напрямую — без ctx.*_idle props.
export function createIdleState() {
  let idleActive = false, idleStop = false;
  return {
    get idleActive() { return idleActive; },
    get idleStop() { return idleStop; },
    setIdleActive(v) { idleActive = !!v; },
    setIdleStop(v) { idleStop = !!v; },
    reset() { idleActive = false; idleStop = false; },
  };
}
export const idleState = createIdleState();

// ADR-004 I.4: relay-domain state (ecoMode/relayEnabled/ecoAutonomous/режим).
// relay.js читает/пишет через него напрямую вместо ctx.*props. App.vue
// Oборачивает через reactive(createRelayStore()) для Vue-реактивности.
import { createRelayStore } from './relay-store.js';
export const relayState = createRelayStore();
