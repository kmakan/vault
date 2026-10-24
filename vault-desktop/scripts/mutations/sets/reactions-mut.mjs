// Набор мутаций: reactions-mut
// Цель: убедиться, что смоук reactions-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'reactions-mut',
  file: 'src/features/reactions.js',
  smoke: 'reactions-smoke.mjs',
  mutations: [
    { name: "пикер открывается на звонковой пилюле (callEvent)",
      pattern: "  if (m && m.callEvent) return current;",
      replacement: "  if (false) return current;" },
    { name: "выделенный текст не мешает открыть пикер",
      pattern: "    if (sel && String(sel).length > 0) return current;",
      replacement: "    if (false) return current;" },
    { name: "повторный клик не закрывает пикер",
      // c7a1f65: возврат обёрнут в set(...) — фича теперь сама пишет
      // состояние через deps.setReactionPickerMsgId.
      pattern: "  return set(current === msgId ? null : msgId);",
      replacement: "  return set(msgId);" },
    { name: "реакция не пишется в сообщение",
      pattern: "      if (!msg.reactions.includes(emoji)) msg.reactions.push(emoji);",
      replacement: "      void 0;" },
    { name: "реакция не сохраняется в storage",
      pattern: "  chatReactions[msgId] = cur;\n  stored[chatKey] = chatReactions;\n  saveStoredReactions(email, stored);\n  sendReactionEmail(msgId, emoji, 'add');",
      replacement: "  chatReactions[msgId] = cur;\n  void 0;\n  saveStoredReactions(email, stored);\n  sendReactionEmail(msgId, emoji, 'add');" },
    { name: "письмо-сигнал реакции не уходит",
      pattern: "  sendReactionEmail(msgId, emoji, 'add');",
      replacement: "  void 0;" },
    { name: "пикер не закрывается после реакции",
      pattern: "  if (typeof setReactionPickerMsgId === 'function') setReactionPickerMsgId(null);",
      replacement: "  void 0;" },
    { name: "дубль той же реакции добавляется дважды",
      pattern: "  if (!cur.some(r => r.emoji === emoji && r.user === email)) {",
      replacement: "  if (false) {" },
  ],
};
