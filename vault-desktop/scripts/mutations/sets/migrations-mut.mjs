// Набор мутаций: migrations-mut
// Цель: убедиться, что смоук migrations-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'migrations-mut',
  file: 'src/migrations.js',
  smoke: 'migrations-smoke.mjs',
  mutations: [
    { name: "перенос истории затирает уже существующий кэш",
      pattern: "    if (existing) return false;   // цель уже занята — чужую историю не трогаем",
      replacement: "    if (false) return false;" },
    { name: "старый ключ истории не удаляется после переноса",
      pattern: "    await db.kvDelete(ns, oldKey);",
      replacement: "    void 0;" },
    { name: "профиль: непустое поле нового профиля затирается старым",
      pattern: "        if ((cur === undefined || cur === null || cur === '')\n          && val !== undefined && val !== null && val !== '') {",
      replacement: "        if (true) {" },
    { name: "перенос профиля не сохраняется в хранилище",
      pattern: "    await db.kvSet('anon', 'profiles', JSON.stringify(profiles));",
      replacement: "    void 0;" },
    { name: "счётчик переименованных групп не растёт (вызывающий не узнает, что что-то переименовано)",
      pattern: "    n++;\n  }\n  return n;",
      replacement: "    void 0;\n  }\n  return n;" },
    { name: "перебор групп пропускает группы, где мы участник (смена почты теряет состав)",
      pattern: "    const mine = String(g.created_by || '').toLowerCase() === old\n      || (g.members || []).some(m => String(m.email || '').toLowerCase() === old);",
      replacement: "    const mine = String(g.created_by || '').toLowerCase() === old;" },
    { name: "переименование не выполняется (в группах остаётся старый адрес)",
      pattern: "    await invoke('groups_rename_member', {\n      groupId: g.id, oldEmail, newEmail,\n    });\n    n++;",
      replacement: "    n++;" },
  ],
};
