// Набор мутаций: mailbox-store-mut
// Цель: убедиться, что смоук mailbox-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'mailbox-store-mut',
  file: 'src/features/mailbox-store.js',
  smoke: 'mailbox-store-smoke.mjs',
  mutations: [
    { name: "письма не пишутся в список",
      pattern: "      this.state.emails = list || [];",
      replacement: "      this.state.emails = [];" },
    { name: "тело письма не кэшируется",
      pattern: "      this.state.emailBodyCache[key] = body;",
      replacement: "      void 0;" },
    { name: "счётчик писем всегда ноль",
      pattern: "      return (this.state.emails || []).length;",
      replacement: "      return 0;" },
    { name: "слияние не дедупит по uid+папка",
      pattern: "        m.set(e.uid + '|' + (e.folder || 'INBOX'), e);",
      replacement: "        m.set(e.uid, e);" },
    { name: "жёсткий сброс не чистит кэш тел",
      pattern: "      this.state.emailBodyCache = {};\n      this.state.emailsLoading = false;",
      replacement: "      void 0;\n      this.state.emailsLoading = false;" },
  ],
};
