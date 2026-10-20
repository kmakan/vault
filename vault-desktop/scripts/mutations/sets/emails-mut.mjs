// Набор мутаций: emails-mut
// Цель: убедиться, что смоук emails-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'emails-mut',
  file: 'src/features/emails.js',
  smoke: 'emails-smoke.mjs',
  mutations: [
    { name: "курсоры не сохраняются (каждое письмо перечитывается)",
      pattern: "        deps.saveCursors(account.id, res.cursors);",
      replacement: "        void 0;" },
    { name: "ошибка фетча не показывается пользователю",
      pattern: "        if (!silent) mailboxState.setEmailError('fetch: ' + (e && e.message || e));",
      replacement: "        if (false) mailboxState.setEmailError('fetch: ' + (e && e.message || e));" },
    { name: "«не подключено» не пробрасывается (вход не спросит пароль)",
      pattern: "        if (String(e && e.message || e).toLowerCase().includes('not connected')) {\n          throw e;\n        }",
      replacement: "        if (false) { throw e; }" },
    { name: "персист писем не восстанавливается (чаты без истории пустые)",
      pattern: "        if (Array.isArray(stored) && stored.length) {",
      replacement: "        if (false) {" },
  ],
};
