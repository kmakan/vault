// Набор мутаций: ignored-users-mut
// Цель: убедиться, что смоук ignored-users-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'ignored-users-mut',
  file: 'src/features/ignored-users.js',
  smoke: 'ignored-users-smoke.mjs',
  mutations: [
    { name: "чтение ignore-листа не из kv (список всегда пустой)",
      pattern: "    const raw = await deps.db.kvGet(await deps.accountNamespace(deps.email), 'ignored-users');",
      replacement: "    const raw = null;" },
    { name: "запись ignore-листа идёт не в пространство аккаунта (список уезжает другому)",
      pattern: "    await deps.db.kvSet(\n      await deps.accountNamespace(deps.email),",
      replacement: "    await deps.db.kvSet(\n      'anon'," },
    { name: "свой адрес можно заблокировать (скроем собственные письма)",
      pattern: "  if (!key || key === (deps.email || '').toLowerCase()) return false;",
      replacement: "  if (!key) return false;" },
    { name: "адрес не нормализуется (блокировка не срабатывает на другой регистр)",
      pattern: "  const key = String(email || '').toLowerCase().trim();",
      replacement: "  const key = String(email || '').trim();" },
    { name: "заблокированный адрес не попадает в список (блокировка без эффекта)",
      pattern: "    deps.contactsStore.setIgnored(\n      deps.addIgnored(deps.contactsStore.state.ignoredUsers, key, Date.now()),\n    );",
      replacement: "    void 0;" },
    { name: "снятие блокировки ничего не убирает (заблокирован навсегда)",
      pattern: "  deps.contactsStore.setIgnored(\n    deps.removeIgnored(deps.contactsStore.state.ignoredUsers, email, deps.peerKeys),\n  );",
      replacement: "  void 0;" },
    { name: "снятие блокировки не сохраняется (после перезапуска блок вернётся)",
      pattern: "  await saveIgnoredUsers(deps);",
      replacement: "  void 0;" },
  ],
};
