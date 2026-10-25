// Набор мутаций: invites-mut
// Цель: убедиться, что смоук invites-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// РАЗДЕЛКА 25.10. Одинаковые строки живут в РАЗНЫХ местах: `await loadGroups()`
// — в ветке accept-писем и в ветке contact-accepts; `markInviteHandled` +
// `splicePendingInvite` — в acceptInvite и в declineInvite. Движок берёт
// первое совпадение, поэтому второй сайт каждого правила не мерился ничем,
// хотя тесты для него есть. Каждый сайт заякорен соседней строкой.

export default {
  id: 'invites-mut',
  file: 'src/features/invites.js',
  smoke: 'invites-smoke.mjs',
  mutations: [
    { name: "ожидающие инвайты не попадают в очередь",
      pattern: "            invites.setPendingInvites(fresh);",
      replacement: "            void 0;" },
    { name: "ожидающие контактные инвайты не попадают в очередь",
      pattern: "            invites.setPendingContacts(fresh);",
      replacement: "            void 0;" },
    { name: "профили не перечитываются после инвайтов",
      pattern: "        loadProfiles();",
      replacement: "        void 0;" },
    { name: "участники принявшего не обновляются",
      pattern: "            await refreshGroupMembers();",
      replacement: "            void 0;" },
    { name: "accept-письма: список групп не перечитывается",
      pattern: "        if (accepts.length) {\n          await loadGroups();",
      replacement: "        if (accepts.length) {\n          void 0;" },
    { name: "contact-accepts: список групп не перечитывается",
      pattern: "          await loadContacts();\n          await loadGroups();",
      replacement: "          await loadContacts();\n          void 0;" },
    { name: "очередь инвайтов не очищается (призрачные инвайты)",
      pattern: "          invites.setPendingInvites([]);",
      replacement: "            void 0;" },
    { name: "принятый инвайт не помечается обработанным",
      pattern: "  invites.markInviteHandled(key);\n  invites.splicePendingInvite(invitePopupIndex());\n  setShowInvitePopup(false);\n  try {\n    if (groups().some(g => g.id === inv.group_id)) {",
      replacement: "  void 0;\n  invites.splicePendingInvite(invitePopupIndex());\n  setShowInvitePopup(false);\n  try {\n    if (groups().some(g => g.id === inv.group_id)) {" },
    { name: "принятый инвайт не убирается из очереди",
      pattern: "  invites.markInviteHandled(key);\n  invites.splicePendingInvite(invitePopupIndex());\n  setShowInvitePopup(false);\n  try {\n    if (groups().some(g => g.id === inv.group_id)) {",
      replacement: "  invites.markInviteHandled(key);\n  void 0;\n  setShowInvitePopup(false);\n  try {\n    if (groups().some(g => g.id === inv.group_id)) {" },
    { name: "отклонённый инвайт не помечается обработанным (всплывёт при следующем поллинге)",
      pattern: "  invites.markInviteHandled(key);\n  invites.splicePendingInvite(invitePopupIndex());\n  setShowInvitePopup(false);\n  try {\n    await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);",
      replacement: "  void 0;\n  invites.splicePendingInvite(invitePopupIndex());\n  setShowInvitePopup(false);\n  try {\n    await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);" },
    { name: "отклонённый инвайт не убирается из очереди",
      pattern: "  invites.markInviteHandled(key);\n  invites.splicePendingInvite(invitePopupIndex());\n  setShowInvitePopup(false);\n  try {\n    await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);",
      replacement: "  invites.markInviteHandled(key);\n  void 0;\n  setShowInvitePopup(false);\n  try {\n    await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);" },
    { name: "отклонённый инвайт возвращается в очередь",
      pattern: "  invites.pushPendingInvite(inv);",
      replacement: "  void 0;" },
    { name: "зашифрованный ключ уходит на сервер как есть (сервер сохранит блоб вместо секрета группы)",
      pattern: "      groupKey = await decryptGroupKey(inv.group_key_enc, inv.sender_public_key);",
      replacement: "      groupKey = inv.group_key_enc;" },
    { name: "ключ группы не обязателен (принимаем без секрета — в группу писать нельзя)",
      pattern: "    if (!groupKey) throw new Error('В приглашении нет ключа группы');",
      replacement: "    // ключ не обязателен" },
    { name: "готовность криптографии не проверяется (шифрованный инвайт принимается вслепую)",
      pattern: "    if (!groupKey && inv.group_key_enc && inv.sender_public_key && isCryptoReady()) {",
      replacement: "    if (!groupKey && inv.group_key_enc && inv.sender_public_key) {" },
  ],
};
