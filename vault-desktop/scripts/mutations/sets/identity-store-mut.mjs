// Набор мутаций: identity-store-mut
// Цель: убедиться, что смоук identity-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'identity-store-mut',
  file: 'src/features/identity-store.js',
  smoke: 'identity-store-smoke.mjs',
  mutations: [
    { name: "ключи пиров не грузятся",
      pattern: "        this.state.peerKeys[pk.email] = pk.public_key;",
      replacement: "        void 0;" },
    { name: "очистка ключей не работает (удалённый ключ остаётся)",
      pattern: "      for (const k of Object.keys(this.state.peerKeys)) delete this.state.peerKeys[k];",
      replacement: "      void 0;" },
    { name: "ключ пира не нормализуется (регистр ломает поиск)",
      pattern: "    setPeerKey(email, key, pq = null) {\n      const norm = _normalizeKey(email);",
      replacement: "    setPeerKey(email, key, pq = null) {\n      const norm = email;" },
    { name: "удаление пира не убирает ключ",
      pattern: "      delete this.state.peerKeys[norm];",
      replacement: "      void 0;" },
  ],
};
