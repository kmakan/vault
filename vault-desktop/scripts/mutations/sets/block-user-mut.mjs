// Набор мутаций: block-user-mut
// Цель: убедиться, что смоук block-user-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// РАЗДЕЛКА 25.10. Четыре входные точки блокировки (меню чата, баннер, меню
// сообщения, карточка участника) делают ОДНО И ТО ЖЕ одинаковыми строками —
// `deps.toast('ignore_off_toast')` в четырёх местах, `await
// deps.loadMessages(deps.activeChat())` в двух. Движок берёт первое
// совпадение, поэтому «тост не показывается» мерил только меню чата, а
// «перерисовка» — только ветку меню. Каждый сайт заякорен соседней строкой.

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
    { name: "открытый чат не перерисовывается из меню чата (новые письма остаются видны)",
      pattern: "    // Открытый чат с ним: чистим экран от НОВЫХ (старые остаются),\n    // иначе выглядело бы, что блок не работает.\n    if (deps.activeChatType() === 'chat' && deps.activeChat() === email) {\n      await deps.loadMessages(deps.activeChat());",
      replacement: "    // Открытый чат с ним: чистим экран от НОВЫХ (старые остаются),\n    // иначе выглядело бы, что блок не работает.\n    if (deps.activeChatType() === 'chat' && deps.activeChat() === email) {\n      void 0;" },
    { name: "открытый чат не перерисовывается из меню сообщения (тот же экран, другая ветка)",
      pattern: "    // Перестраиваем чат, если открыт с ним (1:1) — новые уже скрыты.\n    if (deps.activeChatType() === 'chat' && deps.activeChat() === sender) {\n      await deps.loadMessages(deps.activeChat());",
      replacement: "    // Перестраиваем чат, если открыт с ним (1:1) — новые уже скрыты.\n    if (deps.activeChatType() === 'chat' && deps.activeChat() === sender) {\n      void 0;" },
    { name: "баннер чата не перерисовывается (баннер не уходит)",
      pattern: "  await deps.loadMessages(deps.activeChat());\n}",
      replacement: "  void 0;\n}" },
    { name: "тост о разблокировке из меню чата не показывается",
      pattern: "    await deps.unignoreUser(email);\n    deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');",
      replacement: "    await deps.unignoreUser(email);\n    void 0;" },
    { name: "тост о разблокировке из меню сообщения не показывается",
      pattern: "    await deps.unignoreUser(sender);\n    deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');",
      replacement: "    await deps.unignoreUser(sender);\n    void 0;" },
    { name: "тост о разблокировке участника группы не показывается",
      pattern: "  await deps.unignoreUser(email);\n  deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');",
      replacement: "  await deps.unignoreUser(email);\n  void 0;" },
    { name: "тост о разблокировке из баннера не показывается",
      pattern: "  await deps.unignoreUser(deps.activeChat());\n  deps.toast(deps.tr('ignore_off_toast') || 'Разблокирован');",
      replacement: "  await deps.unignoreUser(deps.activeChat());\n  void 0;" },
    { name: "блокировка автора сообщения берёт не того (блокируется не тот человек)",
      pattern: "  const sender = deps.msgSenderEmail(msg)\n    || (deps.activeChatType() === 'chat' ? deps.activeChat() : '');",
      replacement: "  const sender = deps.activeChatType() === 'chat' ? deps.activeChat() : '';" },
    { name: "блокировка участника группы работает без открытой группы (блокируется не в той группе)",
      pattern: "  if (!deps.currentGroup() || !email) return;\n  await deps.ignoreUser(email);",
      replacement: "  if (!email) return;\n  await deps.ignoreUser(email);" },
  ],
};
