// Набор мутаций: groups-mut
// Цель: убедиться, что смоук groups-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'groups-mut',
  file: 'src/features/groups.js',
  smoke: 'groups-smoke.mjs',
  mutations: [
    { name: "закрепление не пишется в kv",
      pattern: "    await db.kvSet('anon', 'pinned:' + groupId, JSON.stringify({ msg_id: pin.msg_id, preview: pin.preview || '', ts: pin.ts || Date.now() }));",
      replacement: "    void 0;" },
    { name: "открепление не чистит kv",
      pattern: "    await db.kvDelete('anon', 'pinned:' + groupId);",
      replacement: "    void 0;" },
    { name: "старый pin перетирает новый",
      pattern: "  if (pin.ts && cur && cur.ts && Number(pin.ts) < Number(cur.ts)) return;",
      replacement: "  void 0;" },
    { name: "закрепление применяется без проверки времени (старый перетирает новый)",
      pattern: "  if (pin.ts && cur && cur.ts && Number(pin.ts) < Number(cur.ts)) return;",
      replacement: "  void 0;" },
    { name: "не админ может закреплять",
      pattern: "  if (!deps.isGroupAdmin() || !deps.currentGroup() || !msg || !msg.id) return;",
      replacement: "  if (!deps.currentGroup() || !msg || !msg.id) return;" },
    // Целый вызов (две строки): половинка оставляла битые аргументы.
    { name: "закрепление не применяется локально",
      pattern: "  await setPinnedState(deps, gid,\n    decision.action === PinWire.PIN_ACTION.PIN ? decision : null);",
      replacement: "  void 0;" },
    { name: "pin-письмо не уходит",
      pattern: "    await api.sendGroupMeta(gid, content);",
      replacement: "    void 0;" },
    { name: "открепление не вызывает pinGroupMessage",
      pattern: "  deps.pinGroupMessage({ id: deps.pinnedMsgId(), content: '' });",
      replacement: "  void 0;" },
    { name: "прокрутка к закреплённому не работает",
      pattern: "  el.scrollTo({ top: t.offsetTop - 24, behavior: 'smooth' });",
      replacement: "  void 0;" },
  ],
};
