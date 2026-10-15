// Feature module: ретрансляция сигналов — затухающие повторы.
// ЗАТУХАЮЩАЯ, с КОНЕЧНЫМ числом повторов (не «лавина»).
//
// Инцидент 12.10.2026: call_request повторялся каждые 15с все 5 минут
// (~20 писем на один звонок), сотни писем с пустой темой сожгли репутацию.
// Повторы только против редкой транзитной потери (SMTP принял, но письмо
// не дошло) — 4 попытки её покрывают. Лавину — нет.
//
// Владелец: createCallResender() — таймер/попытки локализованы здесь,
// а не в App.data/call-state. calls.js делегирует через ctx.callResender /
// ctx.callRequestResender (App provide). shouldContinue()/send() — зависят
// от фичи и передаются в start() на месте вызова.
export const SIGNAL_RESEND_DELAYS_MS = [5000, 15000, 45000, 120000];

// Планировщик повторов ОДНОГО сигнала с затухающей паузой: одна попытка =
// одно письмо, всего не больше SIGNAL_RESEND_DELAYS_MS.length. shouldContinue()
// проверяется перед каждым повтором (звонок мог принять/завершиться/соединиться).
// Идентификатор таймера лежит внутри владельца — штатное завершение звонка
// гасит его через stop() (hangup/cancelCall/stopSignalResend).
export function createCallResender() {
  let timer = null;
  let attempt = 0;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    attempt = 0;
  };

  const start = (shouldContinue, send) => {
    stop();
    const arm = () => {
      const delay = SIGNAL_RESEND_DELAYS_MS[attempt];
      if (delay === undefined) {
        timer = null; // попытки исчерпаны — молчим, ждём собеседника
        return;
      }
      attempt += 1;
      timer = setTimeout(async () => {
        timer = null;
        if (!shouldContinue()) return stop();
        try {
          await send();
        } catch (e) {
          console.warn('[call] signal resend failed:', e && e.message || e);
        }
        arm();
      }, delay);
    };
    arm();
  };

  return {
    get timer() { return timer; },
    get attempt() { return attempt; },
    start,
    stop,
  };
}
