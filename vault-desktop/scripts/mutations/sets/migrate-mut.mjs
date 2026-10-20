// Набор мутаций: migrate-mut
// Цель: убедиться, что смоук migrate-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'migrate-mut',
  file: 'src/features/migrate.js',
  smoke: 'migrate-smoke.mjs',
  mutations: [
    { name: "профиль НЕ мигрируется (смена почты теряет данные)",
      pattern: "  await deps.migrateOwnProfile(oldEmail, newEmail);",
      replacement: "  void 0;" },
    { name: "миграция при одинаковой почте всё равно идёт",
      pattern: "      if (!oldEmail || !newEmail || oldEmail === newEmail) return;",
      replacement: "      if (!oldEmail || !newEmail) return;" },
    { name: "миграция без старого адреса идёт",
      pattern: "      if (!oldEmail || !newEmail || oldEmail === newEmail) return;",
      replacement: "      if (!newEmail || oldEmail === newEmail) return;" },
  ],
};
