// Набор мутаций: group-invite-queue-mut
// Цель: убедиться, что смоук group-invite-queue-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'group-invite-queue-mut',
  file: 'src/features/group-invite-queue.js',
  smoke: 'group-invite-queue-smoke.mjs',
  mutations: [
    { name: "ключ не отправляется без публичного ключа получателя",
      pattern: "    if (!peerPub) continue; // всё ещё ждём ключ — остаётся в очереди",
      replacement: "    if (false) continue; // всё ещё ждём ключ — остаётся в очереди" },
    { name: "ожидание не снимается после отправки",
      pattern: "      await invoke('groups_invite_sent', { groupId: it.group_id, email: it.email });",
      replacement: "      void 0;" },
    { name: "отправленный адрес не попадает в результат",
      pattern: "      out.sent.push(it.email);",
      replacement: "      void 0;" },
    { name: "нет ключа группы — всё равно шифруем и отправляем",
      pattern: "      if (!groupKeys.length) throw new Error('No group key');",
      replacement: "      if (false) throw new Error('No group key');" },
    { name: "сбой отправки молча глотается",
      pattern: "      out.failed.push(it.email + ' — ' + ((e && e.message) || e));",
      replacement: "      void 0;" },
    { name: "наложившиеся проходы не слиты (двойная отправка ключа)",
      pattern: "  if (running) return running;",
      replacement: "  if (false) return running;" },
  ],
};
