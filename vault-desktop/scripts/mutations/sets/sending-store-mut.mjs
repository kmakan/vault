// Набор мутаций: sending-store-mut
// Цель: убедиться, что смоук sending-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'sending-store-mut',
  file: 'src/features/sending-store.js',
  smoke: 'sending-store-smoke.mjs',
  mutations: [
    { name: "pending не записывается",
      pattern: "        bucket[pendingMsg.id] = pendingMsg;",
      replacement: "        void 0;" },
    { name: "pending не удаляется",
      pattern: "        delete bucket[msgId];",
      replacement: "        void 0;" },
    { name: "бакет чата не замещается (старые pending не исчезают)",
      pattern: "      this.state.pendingOutgoing[chatId] = bucket || {};",
      replacement: "      this.state.pendingOutgoing[chatId] = { ...this.state.pendingOutgoing[chatId], ...(bucket || {}) };" },
    { name: "бакет чата не очищается (dropBucket не работает)",
      pattern: "      delete this.state.pendingOutgoing[chatId];",
      replacement: "      void 0;" },
  ],
};
