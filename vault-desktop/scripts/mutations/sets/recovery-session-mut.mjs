// Набор мутаций: recovery-session-mut
// Цель: убедиться, что смоук recovery-session-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'recovery-session-mut',
  file: 'src/features/recovery-session.js',
  smoke: 'recovery-session-smoke.mjs',
  mutations: [
    { name: "маркер не ставится",
      pattern: "    s.setItem(RECOVERY_MARKER_KEY, '1');",
      replacement: "    void 0;" },
    { name: "маркер не снимается",
      pattern: "    s.removeItem(RECOVERY_MARKER_KEY);",
      replacement: "    void 0;" },
    { name: "прерванное восстановление не блокирует обычный вход",
      pattern: "  if (!isRecoveryPending(storage)) return null;",
      replacement: "  return null;" },
    { name: "значение маркера не сверяется (любое значение = прервано)",
      pattern: "  try { return s.getItem(RECOVERY_MARKER_KEY) === '1'; }",
      replacement: "  try { return !!s.getItem(RECOVERY_MARKER_KEY); }" },
  ],
};
