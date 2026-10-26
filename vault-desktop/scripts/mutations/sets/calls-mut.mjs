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
    // Паттерн — ВЕСЬ вызов с .catch: поломка «звонка в мост нет» должна
    // моделировать забытый вызов, а не оставлять `.catch` на `void 0`
    // (такой мутант не парсится, и падение смоука ничего не доказывает).
    { name: "toggleCallMute НЕ зовёт mediaSetMuted",
      pattern: "    api.mediaSetMuted(c.call_id, muted)\n      .catch((e) => console.error('[call] set muted failed:', e));",
      replacement: "    void 0;" },
    { name: "toggleSpeaker НЕ пишет владельцу",
      pattern: "  deps.setSpeaker(speaker);",
      replacement: "  void 0;" },
    { name: "история не сохраняется",
      pattern: "  deps.saveCurrentHistory(chatKey);",
      replacement: "  void 0;" },
    // ── Конверт сигнала собирает ядро (26.10) ─────────────────────────
    { name: "отказ ядра игнорируется: письмо уходит с пустым телом",
      pattern: "  if (!wire) {",
      replacement: "  if (false) {" },
    { name: "relay-токен отправителя не доезжает до конверта (собеседник не узнает наш адрес)",
      pattern: "    tok: myTok,",
      replacement: "    tok: ''," },
    { name: "в ядро уходит не тот call_id (сигнал чужому звонку)",
      pattern: "    call_id: payload.call_id,",
      replacement: "    call_id: ''," },
    { name: "sdp не передаётся в конверт (соединение не установится)",
      pattern: "    sdp: payload.sdp,",
      replacement: "    sdp: null," },
    { name: "время сигнала — 1970-й (получатель сверяет свежесть вызова)",
      pattern: "    ts: Date.now(),",
      replacement: "    ts: 0," },
    { name: "в релей публикуется чужой id (дедуп сигналов не сходится)",
      pattern: "{ id }, content, { wake, urgent: wake, peerFp })",
      replacement: "{ id: 'call' }, content, { wake, urgent: wake, peerFp })" },
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
