// Набор мутаций: calls-mut
// Цель: убедиться, что смоук calls-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'calls-mut',
  file: 'src/features/calls.js',
  smoke: 'calls-smoke.mjs',
  mutations: [
    { name: "звонок завершён — видео НЕ гасится (камера остаётся)",
      pattern: "  if (deps.stopVideo) deps.stopVideo();",
      replacement: "  void 0;" },
    { name: "toggleCallMute НЕ пишет владельцу",
      pattern: "  deps.setMuted(muted);",
      replacement: "  void 0;" },
    { name: "toggleCallMute НЕ зовёт mediaSetMuted",
      pattern: "    api.mediaSetMuted(c.call_id, muted)",
      replacement: "    void 0;" },
    { name: "toggleSpeaker НЕ пишет владельцу",
      pattern: "  deps.setSpeaker(speaker);",
      replacement: "  void 0;" },
    { name: "история не сохраняется",
      pattern: "  deps.saveCurrentHistory(chatKey);",
      replacement: "  void 0;" },
    // ── Проводка плана транспорта (правило — Rust, здесь исполнение) ──
    { name: "выбор транспорта игнорируется: сигнал ретранслируется в релей всегда",
      pattern: "  const viaRelay = opts.viaRelay !== false && plan.relay;",
      replacement: "  const viaRelay = opts.viaRelay !== false;" },
    { name: "состояние релея не передаётся в план (публикация при выключенном релее)",
      pattern: "    sessionStore.getCurrentEmail(), relayState.state.relayEnabled);",
      replacement: "    sessionStore.getCurrentEmail(), true);" },
    { name: "выбор «только релей» не публикуется (звонок молча уходит почтой)",
      pattern: "  const viaRelay = opts.viaRelay !== false && plan.relay;",
      replacement: "  const viaRelay = false;" },
  ],
};
