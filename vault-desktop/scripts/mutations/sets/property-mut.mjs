// Набор мутаций: property-mut
// Цель: property-смоук (scripts/property-smoke.mjs) тоже обязан ЛОВИТ поломки —
// иначе «свойства» останутся красивым текстом без силы.
//
// Набор бьёт по РАЗНЫМ модулям (у каждой мутации свой file) — движок
// применяет мутацию к файлу мутации, а не к общему file набора.

export default {
  id: 'property-mut',
  file: 'src/ephemeral-rule.js',
  smoke: 'property-smoke.mjs',
  mutations: [
    { name: "expireAt: арифметика TTL в мосте сбита",
      file: "src/ephemeral-rule.js",
      pattern: "    return await invoke('vault_ephemeral_expire_at', { baseMs, ttlSecs });",
      replacement: "    return baseMs + ttlSecs * 1000;" },
    { name: "isExpired: граница «истёк ровно в срок» сбита",
      file: "src/ephemeral-rule.js",
      pattern: "    return await invoke('vault_ephemeral_is_expired', { expiresAt, nowMs });",
      replacement: "    return expiresAt > 0 && nowMs > expiresAt;" },
    { name: "звезда не снимается (инволюция ломается)",
      file: "src/features/stars.js",
      pattern: "  if (list.has(msg.id)) list.delete(msg.id);",
      replacement: "  if (false) list.delete(msg.id);" },
    { name: "счётчик непрочитанных не обнуляется",
      file: "src/chat-store.js",
      pattern: "      delete this.state.unreadCounts[chatKey];",
      replacement: "      this.state.unreadCounts[chatKey] = -1;" },
  ],
};
