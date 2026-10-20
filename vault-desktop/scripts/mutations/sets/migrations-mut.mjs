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
    { name: "перенос профиля не сохран��ется в хранилище",
      pattern: "    await db.kvSet('anon', 'profiles', JSON.stringify(profiles));",
      replacement: "    void 0;" },
    { name: "группы, где мы участник, не переименовываются",
      pattern: "      const has = String(g.created_by || '').toLowerCase() === oldLc\n        || (g.members || []).some(m => String(m.email || '').toLowerCase() === oldLc);",
      replacement: "      const has = String(g.created_by || '').toLowerCase() === oldLc;" },
    { name: "счётчик переименованных групп не растёт",
      pattern: "      n++;",
      replacement: "      void 0;" },
  ],
};
