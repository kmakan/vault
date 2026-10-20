// Набор мутаций: groups-store-mut
// Цель: убедиться, что смоук groups-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'groups-store-mut',
  file: 'src/features/groups-store.js',
  smoke: 'groups-store-smoke.mjs',
  mutations: [
    { name: "ключ группы не сохраняется",
      pattern: "    setGroupKey(id, key) {\n      this.state.groupKeys[id] = key;",
      replacement: "    setGroupKey(id, key) {\n      void 0;" },
    { name: "аватар группы не сохраняется",
      pattern: "    setGroupAvatar(id, avatar) {\n      this.state.groupAvatars[id] = avatar;",
      replacement: "    setGroupAvatar(id, avatar) {\n      void 0;" },
    { name: "очистка ключей не работает",
      pattern: "    clearGroupKeys() {\n      this.state.groupKeys = {};",
      replacement: "    clearGroupKeys() {\n      void 0;\n      this.state.groupKeys = { _stale: 1 };" },
    { name: "слияние ключей не применяется",
      pattern: "    mergeGroupKeys(map) {\n      Object.assign(this.state.groupKeys, map);",
      replacement: "    mergeGroupKeys(map) {\n      void 0;" },
  ],
};
