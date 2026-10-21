// Набор мутаций: local-store-mut
// Цель: убедиться, что смоук local-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'local-store-mut',
  file: 'src/features/local-store.js',
  smoke: 'local-store-smoke.mjs',
  mutations: [
    { name: "курсоры не сохраняются в кэш (повторное чтение писем с начала)",
      pattern: "      deps.setCursors(cursors);",
      replacement: "      void 0;" },
    { name: "курсоры не пишутся в sqlite (синхронизация встаёт)",
      pattern: "      deps.db.cursorsSave(accountId, JSON.stringify(cursors));",
      replacement: "      void 0;" },
    { name: "пустые курсоры затирают сохранённые (синхронизация начинается с нуля)",
      pattern: "    if (cursors && Object.keys(cursors).length) {",
      replacement: "    if (cursors) {" },
    { name: "ключ отметок не разделён по аккаунтам (чужие «прочитано» уезжают)",
      pattern: "  return 'vault-reads-sent-' + (deps.email || 'anon');",
      replacement: "  return 'vault-reads-sent';" },
    { name: "битые отметки роняют чтение (приложение падает на битом localStorage)",
      pattern: "  try {\n    return JSON.parse(storage.getItem(readsSentStorageKey(deps)) || '{}');\n  } catch (e) {\n    return {};\n  }",
      replacement: "  return JSON.parse(storage.getItem(readsSentStorageKey(deps)) || '{}');" },
    { name: "отметки не сохраняются (квитанции «прочитано» уходят каждый раз)",
      pattern: "    storage.setItem(readsSentStorageKey(deps), JSON.stringify(data));",
      replacement: "    void 0;" },
  ],
};
