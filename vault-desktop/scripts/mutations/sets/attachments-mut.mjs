// Набор мутаций: attachments-mut
// Цель: убедиться, что смоук attachments-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'attachments-mut',
  file: 'src/features/attachments.js',
  smoke: 'attachments-smoke.mjs',
  mutations: [
    { name: "DoD-вложение в состоянии error считается готовым",
      pattern: "  return !!attachment && (attachment.dodStatus === 'ready' || attachment.dodStatus === 'loading');",
      replacement: "  return !!attachment;" },
    { name: "data-письмо ищется не по Message-ID",
      pattern: "  return (emails || []).find(m => (m.message_id || '').trim() === id);",
      replacement: "  return (emails || []).find(m => (m.message_id || '').trim() !== id);" },
    { name: "голосовое не останавливается при повторном тапе",
      pattern: "  if (voicePlayingId === msg.id) {",
      replacement: "  if (false) {" },
  ],
};
