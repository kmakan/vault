// Набор мутаций: relay-idle-mut
// Цель: убедиться, что смоук relay-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// ПРИМЕЧАНИЕ. Мутация «повторный start поллинг-цикла не отвергается» УБРАНА
// как эквивалентная на наблюдаемом уровне: у вызывающего (relay.js::
// startPolling) есть собственный гвард `if (pollingCycle.timer) return;`, и
// второй таймер всё равно не создаётся.

export default {
  id: 'relay-idle-mut',
  file: 'src/features/relay-idle.js',
  smoke: 'relay-smoke.mjs',
  mutations: [
    { name: "первый тик релея немедленный (двойной consume на старте, bcc2ac21)",
      pattern: "      timer = setInterval(tick, tickMs);",
      replacement: "      void tick();\n      timer = setInterval(tick, tickMs);" },
    { name: "повторный start тикера не отвергается (два таймера релея)",
      pattern: "      if (timer) return false; // уже запущен (idempotent)",
      replacement: "      if (false) return false;" },

    { name: "stop не снимает таймер тикера",
      pattern: "    stop() { if (timer) { clearInterval(timer); timer = null; } },",
      replacement: "    stop() { void 0; }," },
    // Тики createFastFetchCycle и createPollingCycle дословно одинаковы; якорь —
    // строка catch со своим префиксом в console.warn.
    { name: "fastFetch: busy-флаг не поднимается (наложение запросов к IMAP)",
      pattern: "        busy = true;\n        try { await asyncCb(); }\n        catch (e) { console.warn('[relay] fastFetch err:'",
      replacement: "        try { await asyncCb(); }\n        catch (e) { console.warn('[relay] fastFetch err:'" },
    { name: "fastFetch: busy-флаг не снимается (цикл встаёт навсегда)",
      pattern: "        catch (e) { console.warn('[relay] fastFetch err:', e && e.message || e); }\n        finally { busy = false; }",
      replacement: "        catch (e) { console.warn('[relay] fastFetch err:', e && e.message || e); }\n        finally { busy = true; }" },
    { name: "polling: busy-флаг не поднимается (наложение запросов к IMAP)",
      pattern: "        busy = true;\n        try { await asyncCb(); }\n        catch (e) { console.warn('[relay] poll err:'",
      replacement: "        try { await asyncCb(); }\n        catch (e) { console.warn('[relay] poll err:'" },
    { name: "polling: busy-флаг не снимается (цикл встаёт навсегда)",
      pattern: "        catch (e) { console.warn('[relay] poll err:', e && e.message || e); }\n        finally { busy = false; }",
      replacement: "        catch (e) { console.warn('[relay] poll err:', e && e.message || e); }\n        finally { busy = true; }" },
    { name: "idleFallback не снимает предыдущий таймер (двойное срабатывание)",
      pattern: "    arm(cb) {\n      this.clear();",
      replacement: "    arm(cb) {" },
    { name: "состояние IDLE не сбрасывается (остаётся активным после выхода)",
      pattern: "    reset() { idleActive = false; idleStop = false; }",
      replacement: "    reset() { void 0; }" },
  ],
};
