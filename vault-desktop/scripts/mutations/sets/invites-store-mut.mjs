// Набор мутаций: invites-store-mut
// Цель: убедиться, что смоук invites-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'invites-store-mut',
  file: 'src/features/invites-store.js',
  smoke: 'invites-store-smoke.mjs',
  mutations: [
    { name: "дубль метки «в обработке» не отсекается",
      pattern: "      if (!this.state.handledInviteKeys.includes(key)) this.state.handledInviteKeys.push(key);",
      replacement: "      this.state.handledInviteKeys.push(key);" },
    { name: "метка «в обработке» не снимается",
      pattern: "      if (i >= 0) this.state.handledInviteKeys.splice(i, 1);",
      replacement: "      if (i >= 0) this.state.handledInviteKeys.splice(i, 0);" },
    { name: "сброс затирает метки «в обработке»",
      pattern: "    reset() {\n      this.state.pendingInvites = [];\n      this.state.pendingContacts = [];\n    }",
      replacement: "    reset() {\n      this.state.pendingInvites = [];\n      this.state.pendingContacts = [];\n      this.state.handledInviteKeys = [];\n      this.state.handledContactKeys = [];\n    }" },
    { name: "инвайт не попадает в очередь",
      pattern: "    pushPendingInvite(inv) { this.state.pendingInvites.push(inv); return this.state.pendingInvites; }",
      replacement: "    pushPendingInvite(inv) { return this.state.pendingInvites; }" },
    { name: "инвайт не убирается из очереди",
      pattern: "    splicePendingInvite(i) { this.state.pendingInvites.splice(i, 1); return this.state.pendingInvites; }",
      replacement: "    splicePendingInvite(i) { return this.state.pendingInvites; }" },
    { name: "метка контакта не ставится",
      pattern: "    markContactHandled(key) {\n      if (!this.state.handledContactKeys.includes(key)) this.state.handledContactKeys.push(key);",
      replacement: "    markContactHandled(key) {\n      if (false) this.state.handledContactKeys.push(key);" },
  ],
};
