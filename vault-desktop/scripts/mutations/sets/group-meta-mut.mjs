// Набор мутаций: group-meta-mut
// Цель: убедиться, что смоук group-meta-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'group-meta-mut',
  file: 'src/features/group-meta.js',
  smoke: 'group-meta-smoke.mjs',
  mutations: [
    { name: "meta сканируется без входа",
      pattern: "      if (!sessionStore.state.isLoggedIn || !deps.groups || !deps.groups.length) return;",
      replacement: "      if (!deps.groups || !deps.groups.length) return;" },
    { name: "уже применённая meta обрабатывается повторно",
      pattern: "          if (alreadyApplied.has(appliedSig)) continue;",
      replacement: "          void 0;" },
    { name: "ключ группы не догружается",
      pattern: "                deps.groupStore.setGroupKey(g.id, kd.group_key);",
      replacement: "                void 0;" },
    { name: "аватар группы не применяется",
      pattern: "                deps.groupStore.setGroupAvatar(g.id, obj.avatar);",
      replacement: "                void 0;" },
  ],
};
