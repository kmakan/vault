// Набор мутаций: restore-failure-mut
// Цель: убедиться, что смоук restore-failure-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'restore-failure-mut',
  file: 'src/features/restore-failure.js',
  smoke: 'restore-failure-smoke.mjs',
  mutations: [
    { name: "неизвестная причина даёт пустую строку вместо общего текста",
      pattern: "  const e = RESTORE_ERRORS[reason] || RESTORE_ERRORS.generic;",
      replacement: "  const e = RESTORE_ERRORS[reason] || { key: '', fallback: '' };" },
    { name: "запасной текст не подставляется",
      pattern: "  return t(e.key) || e.fallback;",
      replacement: "  return t(e.key) || '';" },
    { name: "порт не приводится к строке",
      pattern: "  return v ? String(v) : '';",
      replacement: "  return v || '';" },
    { name: "порт 0 не считается отсутствующим",
      pattern: "  return v ? String(v) : '';",
      replacement: "  return v === undefined || v === null ? '' : String(v);" },
    { name: "настройки сервера показываются без серверов",
      pattern: "    showServerSettings: !!(fields.imapServer || fields.smtpServer),",
      replacement: "    showServerSettings: true," },
    { name: "провайдер не восстанавливается по IMAP-хосту",
      pattern: "    mailProvider: detectProviderByServer(fields.imapServer),",
      replacement: "    mailProvider: null," },
  ],
};
