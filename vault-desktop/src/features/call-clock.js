// call-clock.js — owner интервала часов звонка (ADR-004 G4).
//
// ЗАЧЕМ. call-session.js (state-owner) больше не пишет setInterval/clearInterval
// напрямую: интервал и очистка инкапсулированы здесь. call-session.startCallClock
// сбрасывает callClockSec и делегирует тик через onTick; timer id (store-id для
// smoke C9) возвращается через .timer и кладётся в ctx.session.callClockTimer.
// Тик живёт владельце — App.vue/Vue уже только читают callClockSec/callClockTimer
// через computed-прокси на session (ADR-004 C/E).
export function createCallClock(opts = {}) {
  const { intervalMs = 1000 } = opts;
  let timer = null;
  return {
    start(tick) {
      if (timer) clearInterval(timer);
      timer = setInterval(tick, intervalMs);
      return timer;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      return null;
    },
    get timer() { return timer; },
  };
}
