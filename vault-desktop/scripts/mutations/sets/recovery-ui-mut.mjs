// Набор мутаций: recovery-ui-mut
// Цель: убедиться, что смоук recovery-ui-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'recovery-ui-mut',
  file: 'src/features/recovery-ui.js',
  smoke: 'recovery-ui-smoke.mjs',
  mutations: [
    { name: "файл восстановления не читается (восстановить нечего)",
      pattern: "  deps.setRecoveryFileJson(await file.text());",
      replacement: "  void 0;" },
    { name: "имя файла не сохраняется (пользователь не видит, что выбрал)",
      pattern: "  deps.setRecoveryFileName(file.name);",
      replacement: "  void 0;" },
    { name: "причину отказа не показывают (пользователь видит пустую форму)",
      pattern: "  deps.setLoginError(st.loginError);",
      replacement: "  void 0;" },
    { name: "серверы из сохранённой конфигурации не подставляются (нечего чинить)",
      pattern: "  deps.setImapServer(st.imapServer);",
      replacement: "  void 0;" },
    { name: "сохранённый адрес не подхватывается (пользователь логинится не тем ящиком)",
      pattern: "  deps.setEmail(deps.apiEmail() || deps.email());",
      replacement: "  void 0;" },
    { name: "эскроу-письмо не отправляется (ключ восстановления пропадёт)",
      pattern: "    const r = await deps.sendEscrowEmail(deps.email(), mnemonic, 'recovery_spam_toast');",
      replacement: "    const r = { spamToastKey: 'recovery_spam_toast', wrappedJson: '{}' };" },
    { name: "предупреждение «Gmail удалит спам» не показывается (ключ пропадёт молча)",
      pattern: "    deps.toast(deps.tr(r.spamToastKey), 10000);",
      replacement: "    void 0;" },
    { name: "папка эскроу-письма не ищется (пользователь не найдёт письмо)",
      pattern: "    deps.locateEscrow(r.wrappedJson);",
      replacement: "    void 0;" },
  ],
};
