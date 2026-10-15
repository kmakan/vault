// timing.js — fire-and-forget задержки для calls.js (ADR-004 G).
//
// Убирает bare setTimeout/clearTimeout из state-machine calls.js:
// - delay(ms)         — await-задержка (retry backoff, connect-await).
// - later(fn, ms)     — fire-and-forget одиночный таймер (без stop).
// - cancel(id)        — очистка fire-and-forget id.
//
// Владельцы persistent-таймеров (call-ring/watchdog/resend/terminal/clock)
// импортируют setInterval/setTimeout напрямую — это их инкапсуляция
// (start/stop/timer), а не state-machine. timing.js — только короткие
// одиночные задержки, которые не нуждаются в owner-lifecycle.
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export const later = (fn, ms) => setTimeout(fn, ms);
export const cancel = (id) => { if (id != null) clearTimeout(id); };
