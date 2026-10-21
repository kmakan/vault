// Набор мутаций: block-user-mut
// Цель: убедиться, что смоук block-user-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'block-user-mut',
  file: 'src/features/block-user.js',
  smoke: 'block-user-smoke.mjs',
  mutations: [
    { name: "переключение блокировки всегда блокирует (снять нельзя)",
      pattern: "  if (wasIgnored) {\n    await deps.unignoreUser(email);",
      replacement: "  if (false) {\n    await deps.unignoreUser(email);" },
    { name: "переключение блокировки всегда снимает (заблокировать нельзя)",
      pattern: "  } else {\n    await deps.ignoreUser(email);",
      replacement: "  } else if (false) {\n    await deps.ignoreUser(email);" },
    { name: "меню чата не закрывается после блокировки",
      pattern: "  deps.closeChatMenu();",
      replacement: "  void 0;" },
    { name: "открытый чат не перерисовывается (новые письма остаются видны)",
      pattern: "      await deps.loadMessages(deps.activeChat());\n    }\n    deps.toast(deps.tr('ignore_on_toast') || 'Заблокирован');",
      replacement: "      void 0;\n    }\n    deps.toast(deps.tr('ignore_on_toast') || 'Заблокирован');" },
    { name: "баннер чата не перерисовывается (баннер не уходит)",
      pattern: "  await deps.loadMessages(deps.activeChat());\n}",
      replacement: "  void 0;\n}" },
    { name: "блокировка автора сообщения берёт не того (блокируется не тот человек)",
      pattern: "  const sender = deps.msgSenderEmail(msg)\n    || (deps.activeChatType() === 'chat' ? deps.activeChat() : '');",
      replacement: "  const sender = deps.activeChatType() === 'chat' ? deps.activeChat() : '';" },
    { name: "блокировка участника группы работает без открытой группы (блокируется не в той группе)",
      pattern: "  if (!deps.currentGroup() || !email) return;\n  await deps.ignoreUser(email);",
      replacement: "  if (!email) return;\n  await deps.ignoreUser(email);" },
    { name: "тост не показывается (пользователь не понимает, что произошло)",
      pattern: "    deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');",
      replacement: "    void 0;" },
  ],
};
