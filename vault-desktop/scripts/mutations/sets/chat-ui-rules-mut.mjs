// Набор мутаций: chat-ui-mut
// Цель: убедиться, что смоук chat-ui-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'chat-ui-rules-mut',
  file: 'src/features/chat-ui-rules.js',
  smoke: 'chat-ui-rules-smoke.mjs',
  mutations: [
    { name: "русская форма «участник» не различает 1 и 11 (11 будет «участник»)",
      pattern: "    if (m10 === 1 && m100 !== 11) return 'участник';",
      replacement: "    if (m10 === 1) return 'участник';" },
    { name: "русская форма «участника» не различает 2 и 12 (12 будет «участника»)",
      pattern: "    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'участника';",
      replacement: "    if (m10 >= 2 && m10 <= 4) return 'участника';" },
    { name: "всегда английская форма (русский интерфейс с английскими подписями)",
      pattern: "  if (lang === 'ru') {",
      replacement: "  if (false) {" },
    { name: "эмодзи не вставляется в поле",
      pattern: "  deps.setNewMessage(deps.newMessage() + emoji);",
      replacement: "  void 0;" },
    { name: "выбор эмодзи не закрывается (окно висит поверх чата)",
      pattern: "  deps.setShowEmojiPicker(false);",
      replacement: "  void 0;" },
  ],
};
