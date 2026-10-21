// Набор мутаций: history-mut
// Цель: убедиться, что смоук history-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'history-mut',
  file: 'src/features/history.js',
  smoke: 'history-smoke.mjs',
  mutations: [
    { name: "удалённое (tombstone) сообщение попадает в чат",
      pattern: "    if (isTombstoned && isTombstoned(id)) continue;",
      replacement: "    if (false) continue;" },
    { name: "просроченное pending не отбрасывается",
      pattern: "    if (msg.status !== 'failed' && msg._pendingAt && now - msg._pendingAt > 10 * 60 * 1000) continue;",
      replacement: "    if (false) continue;" },
    { name: "pending дублируют реальное сообщение",
      pattern: "      if (real) continue;",
      replacement: "      if (false) continue;" },
    { name: "тело письма не кэшируется",
      pattern: "export function cacheBody({ emailBodyCache, bodyCacheOrder }, key, body) {",
      replacement: "export function cacheBody({ emailBodyCache, bodyCacheOrder }, key, body) {\n  return body;" },
    { name: "загруженный кэш не попадает в состояние (тела не в памяти)",
      pattern: "  deps.setEmailBodyCache(bodies);\n  deps.setBodyCacheOrder(order);",
      replacement: "  void 0;" },
    { name: "кэш не сохраняется по таймеру (тела теряются при выходе)",
      pattern: "  deps.setBodyCacheSaveTimer(setTimeout(() => deps.persistBodyCache(), 2000));",
      replacement: "  deps.setBodyCacheSaveTimer(null);" },
    { name: "старый таймер не сбрасывается (пишем на каждый пакет, кэш портится)",
      pattern: "  if (deps.bodyCacheSaveTimer()) clearTimeout(deps.bodyCacheSaveTimer());",
      replacement: "  void 0;" },
    { name: "тело не кладётся в кэш (история не перечитывается без сети)",
      pattern: "  cacheBody(\n    { emailBodyCache: deps.emailBodyCache(), bodyCacheOrder: deps.bodyCacheOrder() },\n    key, body,\n  );",
      replacement: "  void 0;" },
  ],
};
