// Набор мутаций: mailbox-api-deps-mut
// Цель: убедиться, что смоук mailbox-api-deps-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'mailbox-api-deps-mut',
  file: 'src/features/mailbox-api.js',
  smoke: 'mailbox-api-deps-smoke.mjs',
  mutations: [
    { name: "ctx вызывающего теряется (берётся неполная проекция)",
      pattern: "    return mod.processIncoming(ctx || makeCtx(), fetched, opts, {",
      replacement: "    return mod.processIncoming(makeCtx(), fetched, opts, {" },
    { name: "загрузка групп теряет ctx вызывающего",
      pattern: "  async loadGroups(ctx) { const mod = await GroupsFeature(); return mod.loadGroups(ctx || makeCtx()); },",
      replacement: "  async loadGroups(ctx) { const mod = await GroupsFeature(); return mod.loadGroups(makeCtx()); }," },
    { name: "тело не пишется в mailboxStore",
      pattern: "    mailboxStore.cacheBody(key, body);",
      replacement: "    void 0;" },
    { name: "cursors не грузятся",
      pattern: "    if (api && typeof api.loadCursors === 'function') return api.loadCursors(accountId);",
      replacement: "    return {};" },
    { name: "проекция отдаёт пустой email",
      pattern: "    email: sessionStore.getCurrentEmail(),",
      replacement: "    email: ''," },
    { name: "скролл не проксируется наружу",
      pattern: "  setScroller(fn) { mailboxApi.scrollToBottom = fn; },",
      replacement: "  setScroller(fn) { void 0; }," },
  ],
};
