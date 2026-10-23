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
    { name: "счётчик переименованных групп не возвращается (вызывающий не узнает, что что-то поменялось)",
      pattern: "  return n;",
      replacement: "  return 0;" },
    { name: "пустой адрес не отсекается (в мост уходит пара с пустым адресом)",
      pattern: "  if (!oldEmail || !newEmail) return 0;",
      replacement: "  if (!oldEmail && !newEmail) return 0;" },
    { name: "переименование не выполняется (перебор так и остался на фронте или вызов потерян)",
      pattern: "    n = await renameMeInGroups(oldEmail, newEmail);",
      replacement: "    n = 0;" },
    { name: "список не перечитывается после переименования (на экране старые адреса)",
      pattern: "      if (onRenamed) {",
      replacement: "      if (false) {" },
    { name: "список перечитывается даже когда ничего не поменялось",
      pattern: "    if (n) {",
      replacement: "    if (true) {" },
  ],
};
