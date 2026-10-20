// Набор мутаций: drafts-mut
// Цель: убедиться, что смоук drafts-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'drafts-mut',
  file: 'src/features/drafts.js',
  smoke: 'drafts-smoke.mjs',
  mutations: [
    { name: "черновик не сохраняется",
      pattern: "      if (text.trim()) drafts[chatKey] = text;",
      replacement: "      if (false) drafts[chatKey] = text;" },
    { name: "пустой текст НЕ стирает черновик",
      pattern: "      else delete drafts[chatKey];",
      replacement: "      else drafts[chatKey] = text;" },
    { name: "черновик пишется не под тем чатом",
      pattern: "  const chatKey = chatStore.state.activeChatType === 'group' && chatStore.state.currentGroup\n    ? 'group:' + chatStore.state.currentGroup.id\n    : chatStore.state.activeChat;",
      replacement: "  const chatKey = 'wrong:key';" },
    { name: "без активного чата пишем в kv",
      pattern: "  if (!chatKey) return;",
      replacement: "  void 0;" },
    { name: "черновик не пишется в kv",
      pattern: "      await db.kvSet(await accountNamespace(sessionStore.getCurrentEmail()), 'drafts', JSON.stringify(drafts));",
      replacement: "      void 0;" },
    { name: "восстановление не ставит текст",
      pattern: "      deps.chat.setDraft(drafts[chatKey] || '');",
      replacement: "      void 0;" },
    { name: "восстановление без черновика ставит мусор",
      pattern: "      deps.chat.setDraft(drafts[chatKey] || '');",
      replacement: "      deps.chat.setDraft('мусор');" },
    { name: "ошибка в очереди рвёт цепочку",
      pattern: "  DRAFT_QUEUE = DRAFT_QUEUE.then(fn, fn);",
      replacement: "  DRAFT_QUEUE = DRAFT_QUEUE.then(fn);" },
  ],
};
