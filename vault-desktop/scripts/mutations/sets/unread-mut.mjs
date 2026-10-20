// Набор мутаций: unread-mut
// Цель: убедиться, что смоук unread-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'unread-mut',
  file: 'src/features/unread.js',
  smoke: 'unread-smoke.mjs',
  mutations: [
    { name: "счётчики не загружаются",
      pattern: "    deps.setUnreadCounts(raw ? JSON.parse(raw) : {});",
      replacement: "    void 0;" },
    { name: "дедуп-отметки не загружаются",
      pattern: "    deps.setProcessedUnreadIds(new Set(seenRaw ? JSON.parse(seenRaw) : []));",
      replacement: "    void 0;" },
    { name: "битый kv НЕ сбрасывает значения",
      pattern: "    deps.setUnreadCounts({});\n    deps.setProcessedUnreadIds(new Set());",
      replacement: "    void 0;\n    void 0;" },
    { name: "счётчики не сохраняются",
      pattern: "    await db.kvSet(ns, 'unread-counts', JSON.stringify(deps.unreadCounts()));",
      replacement: "    void 0;" },
    { name: "дедуп-отметки не сохраняются",
      pattern: "    await db.kvSet(ns, 'unread-seen', JSON.stringify(Array.from(deps.processedUnreadIds())));",
      replacement: "    void 0;" },
    { name: "счётчик чата не сбрасывается",
      pattern: "    deps.clearUnread(chatKey);",
      replacement: "    void 0;" },
    { name: "сброс без сохранения (в kv остаётся старое)",
      pattern: "    await saveUnreadCounts(deps);",
      replacement: "    void 0;" },
    { name: "сброс без счётчика тоже сохраняет (лишняя запись)",
      pattern: "  if (deps.unreadOf(chatKey) > 0) {",
      replacement: "  if (true) {" },
    { name: "флаг «без звука» игнорируется",
      pattern: "  return !!foldersStore.flagOf(String(key || '').toLowerCase()).muted;",
      replacement: "  return false;" },
  ],
};
