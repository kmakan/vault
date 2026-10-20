// Набор мутаций: stars-mut
// Цель: убедиться, что смоук stars-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'stars-mut',
  file: 'src/features/stars.js',
  smoke: 'stars-smoke.mjs',
  mutations: [
    { name: "звезда не ставится",
      pattern: "  else list.add(msg.id);",
      replacement: "  else void 0;" },
    { name: "звезда не снимается",
      pattern: "  if (list.has(msg.id)) list.delete(msg.id);",
      replacement: "  if (false) list.delete(msg.id);" },
    { name: "звезда не пишется в kv",
      pattern: "    if (list.size) await db.kvSet(ns, 'starred:' + key, JSON.stringify(Array.from(list)));",
      replacement: "    void 0;" },
    { name: "снятая звезда остаётся в kv",
      pattern: "    else await db.kvDelete(ns, 'starred:' + key);",
      replacement: "    void 0;" },
    { name: "карта мутируется на месте (Vue не увидит)",
      pattern: "  deps.setStarredMap({ ...deps.starredMap(), [key]: Array.from(list) });",
      replacement: "  const m = deps.starredMap(); m[key] = Array.from(list);" },
    { name: "звёзды не загружаются из kv",
      pattern: "    deps.setStarredMap({ ...deps.starredMap(), [chatKey]: Array.isArray(arr) ? arr : [] });",
      replacement: "    void 0;" },
    { name: "звезда ставится в чате заметок",
      pattern: "  if (!key || key === '__notes__') return;",
      replacement: "  if (!key) return;" },
    { name: "звёзды грузятся даже для чата заметок",
      pattern: "  if (!chatKey || chatKey === '__notes__') return;",
      replacement: "  if (!chatKey) return;" },
  ],
};
