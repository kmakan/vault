// Набор мутаций: send-mut
// Цель: убедиться, что смоук send-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'send-mut',
  file: 'src/features/send.js',
  smoke: 'send-smoke.mjs',
  mutations: [
    { name: "пустой черновик отправляется",
      pattern: "      if (!draft().trim()) return;",
      replacement: "      void 0;" },
    { name: "оптимистичное сообщение не показывается",
      pattern: "          deps.chat.append(pendingMsg);",
      replacement: "          void 0;" },
    { name: "исходящее не помечается pending (потеряется при перезагрузке)",
      pattern: "          deps.markPending(chatUi.activeChat, pendingMsg);",
      replacement: "          void 0;" },
    { name: "оптимистичная история не сохраняется (до отправки)",
      pattern: "          deps.saveCurrentHistory(chatUi.activeChat);\n          try {",
      replacement: "          void 0;\n          try {" },
    { name: "исчезающее сообщение не получает таймер",
      pattern: "          if (ttl) deps.scheduleEphemeral(pendingMsg, chatUi.activeChat).catch(() => {});",
      replacement: "          void 0;" },
    { name: "черновик не очищается после отправки",
      pattern: "        deps.chat.clearDraft();",
      replacement: "        void 0;" },
  ],
};
