// Набор мутаций: merge-emails-mut
// Цель: убедиться, что смоук merge-emails-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'merge-emails-mut',
  file: 'src/features/mailbox-store.js',
  smoke: 'merge-emails-smoke.mjs',
  mutations: [
    { name: "дедуп по ключу uid|папка отключён",
      pattern: "      const m = new Map(this.state.emails.map((m) => [m.uid + '|' + (m.folder || 'INBOX'), m]));",
      replacement: "      const m = new Map(this.state.emails.map((m) => [m.uid, m]));" },
    { name: "письмо без папки попадает не в INBOX",
      pattern: "        m.set(e.uid + '|' + (e.folder || 'INBOX'), e);",
      replacement: "        m.set(e.uid + '|' + (e.folder || 'UNKNOWN'), e);" },
    { name: "сортировка по дате отключена",
      pattern: "      this.state.emails = [...m.values()].sort((a, b) =>\n        new Date(b.date || 0) - new Date(a.date || 0));",
      replacement: "      this.state.emails = [...m.values()];" },
    { name: "mergeEmails возвращает копию массива",
      pattern: "        new Date(b.date || 0) - new Date(a.date || 0));\n      return this.state.emails;",
      replacement: "        new Date(b.date || 0) - new Date(a.date || 0));\n      return [...this.state.emails];" },
  ],
};
