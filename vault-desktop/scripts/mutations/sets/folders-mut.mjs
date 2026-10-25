// Набор мутаций: folders-mut
// Цель: убедиться, что смоук folders-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'folders-mut',
  file: 'src/features/folders.js',
  smoke: 'folders-smoke.mjs',
  mutations: [
    { name: "флаги не грузятся из kv",
      pattern: "    const raw = await db.kvGet(await accountNamespace(sessionStore.getCurrentEmail()), 'chat-flags');",
      replacement: "    const raw = null;" },
    { name: "битый kv роняет загрузку флагов",
      pattern: "  } catch (e) { foldersStore.loadFromRaw({}, foldersStore.state.chatFoldersNames); }",
      replacement: "  } catch (e) { throw e; }" },
    { name: "флаги не сохраняются в kv",
      pattern: "    await db.kvSet(await accountNamespace(sessionStore.getCurrentEmail()), 'chat-flags',\n      JSON.stringify(foldersStore.state.chatFlags));",
      replacement: "    void 0;" },
    // РАЗДЕЛКА 25.10: `foldersStore.setFlag(key, f);` стоит в трёх функциях
    // одинаково (архив, mute, папка), и «папка не назначается» на самом деле
    // бил архив. Каждый сайт заякорен своей строкой выше/ниже.
    { name: "папка не назначается чату",
      pattern: "  if (name) f.folder = name.slice(0, 24);\n  else delete f.folder;\n  foldersStore.setFlag(key, f);",
      replacement: "  if (name) f.folder = name.slice(0, 24);\n  else delete f.folder;\n  void 0;" },
    { name: "архив не попадает в стор флага (после перезапуска чат снова в списке)",
      pattern: "  f.archived = !f.archived;\n  foldersStore.setFlag(key, f);",
      replacement: "  f.archived = !f.archived;\n  void 0;" },
    { name: "mute не попадает в стор флага (звук возвращается после перезапуска)",
      pattern: "  f.muted = !f.muted;\n  foldersStore.setFlag(key, f);",
      replacement: "  f.muted = !f.muted;\n  void 0;" },
    // Паттерн должен быть УНИКАЛЬНЫМ: `deps.closeChatMenu();` встречается и в
    // toggleArchive/toggleMute — иначе мутация била бы не ту строку, а
    // проверка папки проходила бы на сломанном коде.
    { name: "меню не закрывается после назначения папки",
      pattern: "  foldersStore.setFlag(key, f);\n  deps.closeChatMenu();\n  await saveChatFlags(deps);",
      replacement: "  foldersStore.setFlag(key, f);\n  void 0;\n  await saveChatFlags(deps);" },
    { name: "без цели назначаем папку (порча состояния)",
      pattern: "  if (!menu || !menu.target) return;",
      replacement: "  if (false) return;" },
    { name: "имя папки не обрезается до 24",
      pattern: "  const name = String(uiStore.getFormField('chatFolderNewName') || '').trim().slice(0, 24);",
      replacement: "  const name = String(uiStore.getFormField('chatFolderNewName') || '').trim();" },
    { name: "имя папки не обрезается от пробелов",
      pattern: "  const name = String(uiStore.getFormField('chatFolderNewName') || '').trim().slice(0, 24);",
      replacement: "  const name = String(uiStore.getFormField('chatFolderNewName') || '').slice(0, 24);" },
    { name: "новая папка не добавляется в список",
      pattern: "  foldersStore.addFolderName(name);",
      replacement: "  void 0;" },
    { name: "диалог не закрывается после создания",
      pattern: "  uiStore.setModal('folderDialogOpen', false);",
      replacement: "  void 0;" },
    { name: "архив не переключается (чат навсегда в архиве)",
      pattern: "  f.archived = !f.archived;",
      replacement: "  f.archived = false;" },
    { name: "флаг архива не сохраняется (после перезапуска архив слетает)",
      pattern: "  await deps.saveChatFlags();\n}\n\n// Без звука / со звуком (чат-меню).",
      replacement: "  void 0;\n}\n\n// Без звука / со звуком (чат-меню)." },
    { name: "mute не переключается (звук не возвращается)",
      pattern: "  f.muted = !f.muted;",
      replacement: "  f.muted = false;" },
    { name: "после mute чат-меню не закрывается (меню висит поверх чата)",
      pattern: "  f.muted = !f.muted;\n  foldersStore.setFlag(key, f);\n  deps.closeChatMenu();",
      replacement: "  f.muted = !f.muted;\n  foldersStore.setFlag(key, f);\n  void 0;" },
  ],
};
