// Набор мутаций: chat-store-mut
// Цель: убедиться, что смоук chat-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'chat-store-mut',
  file: 'src/chat-store.js',
  smoke: 'chat-store-smoke.mjs',
  mutations: [
    { name: "счётчик непрочитанных не растёт",
      pattern: "      this.state.unreadCounts[chatKey] = b + 1;",
      replacement: "      this.state.unreadCounts[chatKey] = b;" },
    { name: "сброс счётчика не работает",
      pattern: "      delete this.state.unreadCounts[chatKey];",
      replacement: "      this.state.unreadCounts[chatKey] = 0;" },
    { name: "полный сброс не очищает счётчики",
      pattern: "      this.state.unreadCounts = {};",
      replacement: "      void 0;" },
    { name: "черновик не очищается",
      pattern: "    clearDraft() {\n      this.state.newMessage = '';",
      replacement: "    clearDraft() {\n      void 0;\n      this.state.newMessage = 'x';" },
  ],
};
