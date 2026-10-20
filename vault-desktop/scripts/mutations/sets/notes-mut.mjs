// Набор мутаций: notes-mut
// Цель: убедиться, что смоук notes-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'notes-mut',
  file: 'src/features/notes.js',
  smoke: 'notes-smoke.mjs',
  mutations: [
    { name: "чат заметок не открывается (сообщения не загружены)",
      pattern: "  deps.chat.set(deps.loadNotes());",
      replacement: "  void 0;" },
    { name: "перетаскивание не начинается (draggedNoteId не выставлен)",
      pattern: "  deps.setDraggedNoteId(msg.id);",
      replacement: "  void 0;" },
    { name: "позиция вставки всегда «до»",
      pattern: "  deps.setDragOverPos((e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after');",
      replacement: "  deps.setDragOverPos('before');" },
    { name: "перетаскивание на себя не снимает подсветку",
      pattern: "  if (!deps.draggedNoteId() || msg.id === deps.draggedNoteId()) {",
      replacement: "  if (false) {" },
    { name: "уход с чужой цели снимает подсветку",
      pattern: "  if (deps.dragOverNoteId() === msg.id) {",
      replacement: "  if (true) {" },
    { name: "заметка не переставляется (порядок не меняется)",
      pattern: "  list.splice(pos === 'after' ? to + 1 : to, 0, moved);",
      replacement: "  void 0;" },
    { name: "переставленная заметка не сохраняется",
      pattern: "  if (deps.saveNotes(list)) deps.chat.set(list);",
      replacement: "  if (false) deps.chat.set(list);" },
    { name: "активный чат не переключается на заметки",
      pattern: "  chatStore.setActiveChat('__notes__');",
      replacement: "  void 0;" },
    { name: "группа не сбрасывается при открытии заметок",
      pattern: "  chatStore.setCurrentGroup(null);",
      replacement: "  void 0;" },
  ],
};
