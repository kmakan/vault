// Набор мутаций: mailbox-api-deps-mut
// Цель: убедиться, что смоук mailbox-api-deps-smoke.mjs ЛОВИТ эти поломки.
// Мост теперь — тонкий порт (ADR-004 J.4): никакой второй копии deps,
// никакой ctx. Мутации ломают порт; смоук должен упасть.

export default {
  id: 'mailbox-api-deps-mut',
  file: 'src/features/mailbox-api.js',
  smoke: 'mailbox-api-deps-smoke.mjs',
  mutations: [
    { name: "владелец не проверяется (молчаливая деградация)",
      pattern: "  if (!owner) {",
      replacement: "  if (false) {" },
    { name: "processIncoming не переадресует",
      pattern: "    return need().processIncoming(fetched, opts);",
      replacement: "    return undefined;" },
    { name: "loadMessages теряет email",
      pattern: "    return need().loadMessages(email);",
      replacement: "    return need().loadMessages();" },
    { name: "loadEmails теряет silent",
      pattern: "    return need().loadEmails(silent);",
      replacement: "    return need().loadEmails();" },
    { name: "saveCursors теряет cursors",
      pattern: "    return need().saveCursors(accountId, cursors);",
      replacement: "    return need().saveCursors(accountId);" },
    { name: "loadGroupMessages теряет forceRescan (принудительная перескановка молча исчезает)",
      pattern: "    return need().loadGroupMessages(groupId, forceRescan);",
      replacement: "    return need().loadGroupMessages(groupId);" },
    { name: "cacheBody теряет тело (кэш писем пустой)",
      pattern: "    return need().cacheBody(key, body);",
      replacement: "    return need().cacheBody(key);" },
  ],
};
