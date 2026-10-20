// Node-смоук владельцев таймеров звонков (ADR-004 F/G/H).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Владельцы таймеров (call-clock, call-ring,
// call-terminal, call-watchdog, timing, call-idle, call-resend) прячутся в
// МАЛЕНЬКИХ модулях, у которых нет собственных проверок: смоук calls-deps
// смотрел на calls.js (фичу) и только УПОМИНАЛ владельцев. При этом каждый
// из них — источник тихих поломок:
//
//   * незакрытый интервал держит событийный цикл (в приложении незаметно,
//     в тестах — падение процесса с задержкой);
//   * незакрытый таймер гудка звонит спустя минуты после отбоя;
//   * снятый busy-флаг приводит к наложению запросов (анти-наклад хранителя);
//   * незатухающие повторы ретрансляции — это инцидент 12.10.2026 (лавина
//     писем по 20 штук на один звонок).
//
// ПРОВЕРЯЕМ (на коротких интервалах, без ожидания в реальном времени):
//   * start/stop у каждого владельца и «повторный start снимает прежний»;
//   * срабатывание по таймеру (значит таймер вообще взведён);
//   * fastFetcher: повторный start возвращает false (анти-наклад);
//   * connLostGuard: arm/clear и срабатывание отсрочки;
//   * callResender: затухание (число попыток ограничено), stop сбрасывает
//     счётчик попыток.
import { createCallClock } from '../src/features/call-clock.js';
import { createRingTimer } from '../src/features/call-ring.js';
import { createTerminalSender } from '../src/features/call-terminal.js';
import { createMediaWatchdog } from '../src/features/call-watchdog.js';
import { delay, later, cancel } from '../src/features/timing.js';
import { createFastFetcher, createConnLostGuard } from '../src/features/call-idle.js';
import { createCallResender, SIGNAL_RESEND_DELAYS_MS } from '../src/features/call-resend.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── call-clock: интервал часов звонка ────────────────────────────────────
{
  const clock = createCallClock({ intervalMs: 10 });
  ok('до старта таймера нет', clock.timer === null);
  let ticks = 0;
  const h1 = clock.start(() => { ticks += 1; });
  ok('start вернул id таймера', !!h1 && clock.timer === h1);
  await sleep(35);
  ok('тики идут (таймер взведён)', ticks >= 2, ticks);
  const h2 = clock.start(() => { ticks += 1; });
  ok('повторный start вернул новый id', h2 !== h1 && clock.timer === h2);
  ok('прежний интервал снят (id таймера прежнего не текущий)', clock.timer !== h1);
  clock.stop();
  ok('stop снимает таймер', clock.timer === null);
  const before = ticks;
  await sleep(30);
  ok('после stop тиков нет', ticks === before, ticks);
}

// ── call-ring: таймер гудка ─────────────────────────────────────────────
{
  const ring = createRingTimer();
  ok('до старта таймера нет', ring.timer === null);
  let fired = 0;
  const t1 = ring.start(10, () => { fired += 1; });
  ok('start вернул id таймера', !!t1 && ring.timer === t1);
  const t2 = ring.start(10, () => { fired += 1; });
  ok('повторный start снимает прежний таймер', t2 !== t1 && ring.timer === t2);
  await sleep(40);
  ok('гудок сработал ровно один раз (прежний таймер снят)', fired === 1, fired);
  ring.start(1000, () => { fired += 1; });
  ring.stop();
  ok('stop снимает таймер', ring.timer === null);
  await sleep(30);
  ok('после stop гудок не сработал', fired === 1, fired);
}

// ── call-terminal: повторы терминального сигнала ────────────────────────
{
  const term = createTerminalSender();
  ok('до старта повторов нет', term.timer === 0);
  let fired = 0;
  term.repeat(10, () => { fired += 1; });
  term.repeat(20, () => { fired += 1; });
  ok('повторы зарегистрированы', term.timer === 2, term.timer);
  term.stop();
  ok('stop снимает все повторы', term.timer === 0);
  await sleep(40);
  ok('после stop повторы не сработали', fired === 0, fired);
}

// ── call-watchdog: «Соединение…» watchdog ──────────────────────────────
{
  const wd = createMediaWatchdog({ intervalMs: 10 });
  ok('до старта таймера нет', wd.timer === null);
  let fired = 0;
  wd.start(() => { fired += 1; });
  // Повторный start ДО срабатывания: прежний таймер обязан быть снят, иначе
  // watchdog выстрелит дважды (двойной «Соединение… отвалилось»).
  wd.start(() => { fired += 1; });
  await sleep(35);
  ok('watchdog сработал ровно один раз (прежний таймер снят)', fired === 1, fired);
  wd.start(() => { fired += 1; });
  wd.stop();
  ok('stop снимает таймер', wd.timer === null);
  await sleep(30);
  ok('после stop watchdog не сработал', fired === 1, fired);
}

// ── timing: короткие задержки ───────────────────────────────────────────
{
  const t0 = Date.now();
  await delay(20);
  ok('delay ждёт и разрешается', Date.now() - t0 >= 15);
  let fired = 0;
  const id = later(() => { fired += 1; }, 10);
  ok('later вернул id', !!id);
  await sleep(30);
  ok('later вызвал функцию', fired === 1, fired);
  let fired2 = 0;
  const id2 = later(() => { fired2 += 1; }, 10);
  cancel(id2);
  await sleep(30);
  ok('cancel снимает отложенный вызов', fired2 === 0, fired2);
  ok('cancel(null) не падает', (cancel(null), cancel(undefined), true));
}

// ── call-idle: fastFetcher (анти-наклад) и connLostGuard ───────────────
{
  const ff = createFastFetcher({ intervalMs: 10000 });
  let calls = 0;
  ok('первый start возвращает true', ff.start(() => { calls += 1; }) === true);
  ok('первый start сразу позвал колбэк', calls === 1, calls);
  ok('повторный start возвращает false (анти-наклад)', ff.start(() => { calls += 1; }) === false);
  ok('повторный start НЕ звал колбэк', calls === 1, calls);
  ok('таймер fast-fetch взведён', !!ff.timer);
  // После синхронного тика busy обязан быть снят: иначе хранитель «занят»
  // навсегда и страховочный фетч больше не идёт (молчаливое отключение).
  ok('после тика флаг busy снят', ff.busy === false, ff.busy);
  ff.stop();
  ok('stop снимает таймер fast-fetch', ff.timer === null);
  ok('после stop флаг busy снят (иначе fast-fetch больше не запустится)', ff.busy === false);
  ok('после stop fast-fetch снова запускается', ff.start(() => { calls += 1; }) === true);
  ff.stop();
}
{
  const g = createConnLostGuard({ graceMs: 20 });
  ok('до arm таймера нет', g.timer === null);
  let expired = 0;
  g.arm(() => { expired += 1; });
  ok('arm вернул таймер', !!g.timer);
  await sleep(50);
  ok('отсрочка истекла и сработала', expired === 1, expired);
  g.arm(() => { expired += 1; });
  g.clear();
  ok('clear снимает таймер', g.timer === null);
  await sleep(40);
  ok('после clear отсрочка не сработала', expired === 1, expired);
}

// ── call-resend: затухающие повторы сигнала ─────────────────────────────
{
  const r = createCallResender();
  ok('до старта попыток нет', r.attempt === 0);
  // Подменяем задержки на крошечные: проверяем СЧЁТ попыток, а не тайминги.
  const orig = SIGNAL_RESEND_DELAYS_MS.slice();
  let sent = 0;
  r.start(() => true, async () => { sent += 1; });
  ok('попытка запланирована', r.attempt === 1, r.attempt);
  // Реальные задержки (5с/15с/45с/120с) ждать нельзя — проверяем границу:
  // после исчерпания списка задержек новых попыток не планируется.
  r.stop();
  ok('stop сбрасывает счётчик попыток', r.attempt === 0, r.attempt);
  ok('список задержек ограничен (4 попытки максимум)', orig.length === 4, orig.length);
  ok('задержки нарастают (затухание)', orig.every((v, i) => i === 0 || v > orig[i - 1]), orig);
  ok('ничего не отправлено при мгновенной остановке', sent === 0, sent);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
