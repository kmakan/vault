// call-watchdog.js — «Соединение…» watchdog (90с) + часы разговора.
// ADR-004 F: таймер mediaFallback вынесен из calls.js в owner.
// timer id сохраняется в ctx.session.mediaFallbackTimer (store id для smoke
// fireTimer), но start/stop/clear инкапсулированы в createMediaWatchdog —
// calls.js больше не держит bare setTimeout/clearTimeout для watchdog.
export function createMediaWatchdog(opts = {}) {
  const { intervalMs = 90000 } = opts;

  let timer = null;

  const start = (onTimeout) => {
    stop();
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
    }, intervalMs);
    return timer;
  };

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    get timer() { return timer; },
    start,
    stop,
  };
}
