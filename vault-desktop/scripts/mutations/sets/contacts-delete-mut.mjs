// Набор мутаций: contacts-delete-mut
// Цель: убедиться, что смоук contacts-delete-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'contacts-delete-mut',
  file: 'src/features/contacts-delete.js',
  smoke: 'contacts-delete-smoke.mjs',
  mutations: [
    { name: "ключ шифрования не сносится",
      pattern: "  await crypto.removePeerKey(email);",
      replacement: "  void 0;" },
    { name: "старые handshake-письма не помечаются обработанными",
      pattern: "  await api.markContactHandshakeDone(email);",
      replacement: "  void 0;" },
    { name: "приглашение не снимается",
      pattern: "  await api.removeInvitedSender(email);",
      replacement: "  void 0;" },
    { name: "контакт не удаляется",
      pattern: "  await api.removeContact(email);",
      replacement: "  void 0;" },
    { name: "закрытый чат удаляемого не сбрасывается",
      pattern: "  const closeChat = state.activeChat === email;",
      replacement: "  const closeChat = false;" },
    { name: "activeChatType не возвращается в chat",
      pattern: "    activeChatType: closeChat ? 'chat' : state.activeChatType,",
      replacement: "    activeChatType: state.activeChatType," },
  ],
};
