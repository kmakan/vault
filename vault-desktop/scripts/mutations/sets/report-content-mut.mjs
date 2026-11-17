// Набор мутаций: report-content-mut
// Цель: убедиться, что смоук report-content-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// С 17.11 набор меряет не только сборку текста, но и ПУТЬ отправки: жалоба
// уходит письмом из приложения (SMTP моста), а почтовый клиент — запасной
// путь. До этого жалоба молча терялась на Android: mailto-intent без
// обработчика.

export default {
  id: 'report-content-mut',
  file: 'src/features/report-content.js',
  smoke: 'report-content-smoke.mjs',
  mutations: [
    { name: "время сообщения не берётся из created_at",
      pattern: "  return msg.time || msg.created_at || msg.date || '-';",
      replacement: "  return msg.time || msg.date || '-';" },
    { name: "пустой тип жалобы не пропускается",
      pattern: "    tr('report_content_type', 'Тип') + ': ' + (String(type).trim() || '-'),",
      replacement: "    tr('report_content_type', 'Тип') + ': ' + String(type).trim()," },
    { name: "запасной текст перевода не подставляется",
      pattern: "  const tr = (key, fallback) => (t(key) || fallback);",
      replacement: "  const tr = (key, fallback) => t(key);" },
    { name: "пустой id попадает в письмо как undefined",
      pattern: "    tr('report_content_msg_id', 'ID сообщения') + ': ' + (msg.id || '-'),",
      replacement: "    tr('report_content_msg_id', 'ID сообщения') + ': ' + msg.id," },
    { name: "адрес в запасной ссылке подменяется",
      pattern: "  return 'mailto:' + OPERATOR_EMAIL + '?subject=' + encodeURIComponent(subject)",
      replacement: "  return 'mailto:support@example.com?subject=' + encodeURIComponent(subject)" },
    { name: "ящик оператора подменён",
      pattern: "export const OPERATOR_EMAIL = 'vault-msg@ya.ru';",
      replacement: "export const OPERATOR_EMAIL = 'support@vault-msg.ru';" },
    { name: "успешная отправка всё равно открывает почтовый клиент",
      pattern: "    if (deps.notify) deps.notify(deps.tr('report_content_sent') || 'Жалоба отправлена');\n    return;",
      replacement: "    if (deps.notify) deps.notify(deps.tr('report_content_sent') || 'Жалоба отправлена');" },
    { name: "при отказе SMTP жалоба теряется (нет запасного пути)",
      pattern: "    console.warn('[report] in-app send failed, falling back to mailto:', e);",
      replacement: "    return;" },
    { name: "об успехе не сообщается, даже когда письмо ушло",
      pattern: "  try {\n    await deps.sendReport(subject, lines.join('\\n'));",
      replacement: "  try {\n    await deps.sendReport(subject, lines.join('\\n'));\n    return;" },
  ],
};
