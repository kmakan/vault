// Набор мутаций: note-id-mut
// Цель: убедиться, что смоук note-id-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'note-id-mut',
  file: 'src/note-id.js',
  smoke: 'note-id-smoke.mjs',
  mutations: [
    { name: "префикс note- теряется (заметка не отличима от сообщения)",
      pattern: "  return 'note-' + now.toString(36) + Math.random().toString(36).substr(2, 5);",
      replacement: "  return now.toString(36) + Math.random().toString(36).substr(2, 5);" },
    { name: "случайная часть теряется (две заметки получают один id)",
      pattern: "Math.random().toString(36).substr(2, 5);",
      replacement: "''; " },
    { name: "время не в base36 (id не читается и не сортируется)",
      pattern: "now.toString(36)",
      replacement: "String(now)" },
  ],
};
