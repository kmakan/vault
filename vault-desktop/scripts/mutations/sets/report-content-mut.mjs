// Набор мутаций: report-content-mut
// Цель: убедиться, что смоук report-content-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

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
    { name: "адрес поддержки подменяется",
      pattern: "  return 'mailto:support@vault-msg.ru?subject=' + encodeURIComponent(subject)",
      replacement: "  return 'mailto:support@example.com?subject=' + encodeURIComponent(subject)" },
  ],
};
