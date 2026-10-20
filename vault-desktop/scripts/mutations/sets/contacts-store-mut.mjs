// Набор мутаций: contacts-store-mut
// Цель: убедиться, что смоук contacts-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'contacts-store-mut',
  file: 'src/features/contacts-store.js',
  smoke: 'contacts-store-smoke.mjs',
  mutations: [
    { name: "ignore-лист не записывается",
      pattern: "    setIgnored(map) { this.state.ignoredUsers = map || {}; return this.state.ignoredUsers; }",
      replacement: "    setIgnored(map) { void 0; return this.state.ignoredUsers; }" },
    { name: "сброс контактов не очищает ignore-лист",
      pattern: "    reset() { this.state.contacts = []; this.state.contactAliases = {}; this.state.ignored = []; this.state.ignoredUsers = {}; this.state.lastSeenMap = {}; }",
      replacement: "    reset() { this.state.contacts = []; this.state.contactAliases = {}; }" },
    { name: "отметка «видели» не пишется",
      pattern: "    setLastSeen(email, ts) { this.state.lastSeenMap[email] = ts; return this.state.lastSeenMap; }",
      replacement: "    setLastSeen(email, ts) { void 0; return this.state.lastSeenMap; }" },
  ],
};
