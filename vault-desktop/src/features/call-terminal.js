// call-terminal.js — owner повторов терминального сигнала (ADR-004 G3).
//
// ЗАЧЕМ. sendTerminalRepeat (call_end/call_cancel/call_reject) шлёт сигнал
// почтой, затем 2 fire-and-forget повтора через 3с и 7с — если первое письмо
// потеряется, собеседник не остаётся с поднятой трубкой. Дубли у приёмника
// безопасны (ветка remote_late / guard по состоянию), а здесь — чтобы гудки
// не висели 15-60с после отбоя на другом конце.
//
// Повторы только почтой: релей-копия уже в очереди получателя, повтор на релей
// жёг бы суточный лимит издателя.
//
// owner хранит pending timer ids; stop() гасит все повторы (напр. при
// повторном terminal от другого узла). timer id не кладётся в session —
// terminal-repeat живёт лишь до fire или stop.
export function createTerminalSender() {
  const timers = new Set();
  return {
    // repeat(ms, fn): fire-and-forget. id сохраняется для stop().
    repeat(ms, fn) {
      const id = setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    stop() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
    get timer() { return timers.size; },
  };
}
