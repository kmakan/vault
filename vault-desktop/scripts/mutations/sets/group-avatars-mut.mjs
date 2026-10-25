// Набор мутаций: group-avatars-mut
// Цель: убедиться, что смоук group-avatars-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// РАЗДЕЛКА 25.10. replyHeal (ответ на {hav:1}) и requestHeal (сам запрос)
// написаны почти дословно одинаково: rate-limit, `groupKeyOf(deps, groupId)`,
// `sendGroupMeta`, отметка в kv. Движок берёт первое совпадение, поэтому все
// четыре «reply»-мутации били replyHeal, а requestHeal не был измерен НИЧЕМ —
// ровно тот путь, который.fire-and-forget из loadGroups и молча молотит
// почтовый транспорт. Каждый сайт заякорен СВОЕЙ строкой (комментарий/лог).
// Третье совпадение `groupKeyOf(deps, groupId)` было строкой ОПРЕДЕЛЕНИЯ
// функции (L40) — мутация переименовывала параметр, а не проверка на ctx.

export default {
  id: 'group-avatars-mut',
  file: 'src/features/group-avatars.js',
  smoke: 'group-avatars-smoke.mjs',
  mutations: [
    { name: "ответ: внутренний вызов остался на ctx (баг 20.10)",
      pattern: "    const groupKey = await groupKeyOf(deps, groupId);\n    if (!groupKey) { console.log('[group] avatar-heal reply skip: no group key', groupId); return; }",
      replacement: "    const groupKey = await groupKeyOf(ctx, groupId);\n    if (!groupKey) { console.log('[group] avatar-heal reply skip: no group key', groupId); return; }" },
    { name: "запрос: внутренний вызов остался на ctx (баг 20.10)",
      pattern: "    const groupKey = await groupKeyOf(deps, groupId);\n    if (!groupKey) return; // нечем шифровать — группу пропускаем тихо",
      replacement: "    const groupKey = await groupKeyOf(ctx, groupId);\n    if (!groupKey) return; // нечем шифровать — группу пропускаем тихо" },
    { name: "пустой аватар затирает существующий",
      pattern: "  if (!gavatar || typeof gavatar !== 'string') return;",
      replacement: "  if (false) return;" },
    { name: "аватар не пишется в kv",
      pattern: "    await db.kvSet('anon', AVATAR_P + groupId, gavatar);",
      replacement: "    void 0;" },
    { name: "аватар не попадает в owner",
      pattern: "    deps.groups.setGroupAvatar(groupId, gavatar);",
      replacement: "    void 0;" },
    { name: "отвечаем без своего аватара (петля)",
      pattern: "    if (!my) return; // у меня пусто — не отвечаем (защита от петли)",
      replacement: "    if (false) return;" },
    { name: "rate-limit ответа не работает (ответим дважды на одно письмо)",
      pattern: "    if (!(await rateLimitExpired(flagKey))) return; // 24ч rate-limit\n    const groupKey = await groupKeyOf(deps, groupId);\n    if (!groupKey) { console.log('[group] avatar-heal reply skip: no group key', groupId); return; }",
      replacement: "    if (false) return; // 24ч rate-limit\n    const groupKey = await groupKeyOf(deps, groupId);\n    if (!groupKey) { console.log('[group] avatar-heal reply skip: no group key', groupId); return; }" },
    { name: "rate-limit запроса не работает (hav уходит участникам каждые 30 секунд)",
      pattern: "    if (!(await rateLimitExpired(flagKey))) return; // 24ч rate-limit\n    const groupKey = await groupKeyOf(deps, groupId);\n    if (!groupKey) return; // нечем шифровать — группу пропускаем тихо",
      replacement: "    if (false) return; // 24ч rate-limit\n    const groupKey = await groupKeyOf(deps, groupId);\n    if (!groupKey) return; // нечем шифровать — группу пропускаем тихо" },
    { name: "ключ группы не догружается",
      pattern: "      if (kd && kd.group_key) { deps.groups.setGroupKey(groupId, kd.group_key); groupKey = kd.group_key; }",
      replacement: "      if (false) { deps.groups.setGroupKey(groupId, kd.group_key); groupKey = kd.group_key; }" },
    { name: "ответ не отправляется",
      pattern: "    await api.sendGroupMeta(groupId, content);\n    await db.kvSet('anon', flagKey, String(Date.now()));\n    console.log('[group] avatar-heal replied:', groupId);",
      replacement: "    void 0;\n    await db.kvSet('anon', flagKey, String(Date.now()));\n    console.log('[group] avatar-heal replied:', groupId);" },
    { name: "запрос не отправляется (аватар так и останется пустым)",
      pattern: "    await api.sendGroupMeta(groupId, content);\n    await db.kvSet('anon', flagKey, String(Date.now()));\n    console.log('[group] avatar-heal requested:', groupId);",
      replacement: "    void 0;\n    await db.kvSet('anon', flagKey, String(Date.now()));\n    console.log('[group] avatar-heal requested:', groupId);" },
    { name: "отметка «ответили» не ставится",
      pattern: "    await db.kvSet('anon', flagKey, String(Date.now()));\n    console.log('[group] avatar-heal replied:', groupId);",
      replacement: "    void 0;\n    console.log('[group] avatar-heal replied:', groupId);" },
    { name: "отметка «запрашивал» не ставится",
      pattern: "    await db.kvSet('anon', flagKey, String(Date.now()));\n    console.log('[group] avatar-heal requested:', groupId);",
      replacement: "    void 0;\n    console.log('[group] avatar-heal requested:', groupId);" },
  ],
};
