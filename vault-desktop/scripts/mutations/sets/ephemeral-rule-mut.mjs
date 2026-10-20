// Набор мутаций: ephemeral-rule-mut
// Цель: убедиться, что смоук ephemeral-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'ephemeral-rule-mut',
  file: 'src/ephemeral-rule.js',
  smoke: 'ephemeral-smoke.mjs',
  mutations: [
    { name: "мост не зовёт Rust (своя арифметика в JS)",
      pattern: "    return await invoke('vault_ephemeral_expire_at', { baseMs, ttlSecs });",
      replacement: "    return baseMs + ttlSecs * 1000;" },
    { name: "мост игнорирует ответ Rust",
      pattern: "    return await invoke('vault_ephemeral_expire_at', { baseMs, ttlSecs });",
      replacement: "    void 0;" },
    { name: "ttl<=0 всё равно идёт в Rust",
      pattern: "  if (!ttlSecs || ttlSecs <= 0) return 0;",
      replacement: "  if (false) return 0;" },
    { name: "отказ моста роняет вызов (нет отката)",
      pattern: "    console.error('[ephemeral] Rust-правило времени жизни недоступно:', e && e.message || e);\n    return 0;",
      replacement: "    throw e;" },
    { name: "отказ моста → исчезает раньше срока",
      pattern: "    console.error('[ephemeral] Rust-проверка истечения недоступна:', e && e.message || e);\n    return false;",
      replacement: "    console.error('[ephemeral] Rust-проверка истечения недоступна:', e && e.message || e);\n    return true;" },
    { name: "isExpired игнорирует ответ Rust",
      pattern: "    return await invoke('vault_ephemeral_is_expired', { expiresAt, nowMs });",
      replacement: "    return false;" },
  ],
};
