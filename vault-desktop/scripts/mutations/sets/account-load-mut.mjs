// Набор мутаций: account-load-mut
// Цель: убедиться, что смоук account-load-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'account-load-mut',
  file: 'src/features/account-load.js',
  smoke: 'account-load-smoke.mjs',
  mutations: [
    { name: "контакты не переносятся в состояние (список пустой)",
      pattern: "  deps.setContacts(deps.contactsStore.state.contacts);",
      replacement: "  void 0;" },
    { name: "алиасы контактов не переносятся (потеряем адрес после смены почты)",
      pattern: "  deps.setContactAliases(deps.contactsStore.state.contactAliases);",
      replacement: "  void 0;" },
    { name: "список групп не переносится (группы исчезли)",
      pattern: "  if (r.groups) deps.setGroups(r.groups);",
      replacement: "  void 0;" },
    { name: "ключи групп не отданы владельцу (группы без ключа — не расшифровать)",
      pattern: "  deps.groupsStore.mergeGroupKeys(r.keys || {});",
      replacement: "  void 0;" },
    { name: "новые контакты из групп не добавляются (контакт потерян)",
      pattern: "  for (const c of r.newContacts) deps.contacts().push(c);",
      replacement: "  void 0;" },
    { name: "профиль при смене почты не переносится (аватар старый)",
      pattern: "  deps.setUserAvatarUrl((r.profile || {}).avatar || deps.userAvatarUrl());",
      replacement: "  void 0;" },
    { name: "локальные кэши не грузятся (томбстоуны и курсоры пустые)",
      pattern: "  if (r.cursors) deps.setCursorsCache(r.cursors);",
      replacement: "  void 0;" },
  ],
};
