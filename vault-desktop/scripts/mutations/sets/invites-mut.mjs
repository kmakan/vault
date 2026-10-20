// Набор мутаций: invites-mut
// Цель: убедиться, что смоук invites-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

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
    { name: "список групп не перечитывается",
      pattern: "          await loadGroups();",
      replacement: "          void 0;" },
    { name: "очередь инвайтов не очищается (призрачные инвайты)",
      pattern: "          invites.setPendingInvites([]);",
      replacement: "            void 0;" },
    { name: "принятый инвайт не помечается обработанным",
      pattern: "  invites.markInviteHandled(key);",
      replacement: "  void 0;" },
    { name: "принятый инвайт не убирается из очереди",
      pattern: "  invites.splicePendingInvite(invitePopupIndex());",
      replacement: "  void 0;" },
    { name: "отклонённый инвайт возвращается в очередь",
      pattern: "  invites.pushPendingInvite(inv);",
      replacement: "  void 0;" },
  ],
};
