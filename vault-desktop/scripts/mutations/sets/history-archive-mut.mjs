// Набор мутаций: history-archive-mut
// Цель: убедиться, что смоук history-archive-smoke.mjs ЛОВИТ потерю переписки.
// Дефект живой (22.10.2026): saveHistory перезаписывал архив тем, что на экране
// сейчас, и chat_history активного чата превращался в "[]" — переписка
// пропадала насовсем. Если мутации ниже выживают, смоук ничего не стережёт.

export default {
  id: 'history-archive-mut',
  file: 'src/history.js',
  smoke: 'history-archive-smoke.mjs',
  mutations: [
    { name: 'архив не читается: запись заменяет историю целиком',
      pattern: '      if (Array.isArray(prev)) write = mergeHistoryLists(prev, messages);',
      replacement: '      if (Array.isArray(prev)) write = messages;' },
    { name: 'слияние теряет старые записи (только новый список)',
      pattern: '  for (const m of prev || []) put(m);\n',
      replacement: '' },
    { name: 'мусорные "{}" снова попадают в историю',
      pattern: '      return normalizeHistoryList(arr);',
      replacement: '      return Array.isArray(arr) ? arr : null;' },
    { name: 'параллельные записи идут мимо очереди (наложение затирает архив)',
      pattern: '  const prev = archiveQueue.get(key) || Promise.resolve();',
      replacement: '  const prev = Promise.resolve();' },
    { name: 'чтение не ждёт очередь (сразу после записи виден старый архив)',
      pattern: "  return queued(account + '|' + chatKey, async () => {\n    try {\n      const json = await db.historyLoad(",
      replacement: "  return queued('read:' + account + '|' + chatKey, async () => {\n    try {\n      const json = await db.historyLoad(" },
    { name: 'записям без id не выдаётся id (реакции и правки невозможны)',
      pattern: "    out.push(m && m.id ? m : { ...m, id: 'h:' + digest(k) });",
      replacement: '    out.push(m);' },
  ],
};
