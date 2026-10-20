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
  ],
};
