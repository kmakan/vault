// Набор мутаций: folders-store-mut
// Цель: убедиться, что смоук folders-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'folders-store-mut',
  file: 'src/features/folders-store.js',
  smoke: 'folders-store-smoke.mjs',
  mutations: [
    // Паттерн — if + else: раньше мутант оставлял «голый else» (SyntaxError),
    // и падение смоука ничего не доказывало.
    { name: "пустой флаг не удаляется",
      pattern: "      if (!f || (!f.archived && !f.muted && !f.folder)) delete this.state.chatFlags[key];\n      else this.state.chatFlags[key] = f;",
      replacement: "      this.state.chatFlags[key] = f;" },
    { name: "переименование папки не применяется",
      pattern: "      const i = names.indexOf(oldName);",
      replacement: "      const i = -1;" },
    { name: "имя папки добавляется дважды",
      pattern: "      if (name && !this.state.chatFoldersNames.includes(name)) this.state.chatFoldersNames.push(name);",
      replacement: "      if (name) this.state.chatFoldersNames.push(name);" },
  ],
};
