// call-ring.js — owner таймера гудка (ring timeout).
// ADR-004 G: bare setTimeout/clearTimeout для callRingTimer вынесены из calls.js.
// owner хранит timer id; calls.js кладёт его в ctx.session.callRingTimer (store id
// для smoke fireTimer — backward-compat). onTimeout — cancelCall(ctx,'timeout').
export function createRingTimer() {
  let timer = null;

  const start = (ms, onTimeout) => {
    stop();
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
    }, ms);
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
