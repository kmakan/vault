// Набор мутаций: envelope-id-mut
// Цель: убедиться, что смоук envelope-id-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'envelope-id-mut',
  file: 'src/features/envelope-id.js',
  smoke: 'envelope-id-smoke.mjs',
  mutations: [
    // Разбор конверта уехал в Rust (ADR-005 W4): мутация бьёт по адаптеру —
    // если он вернёт фиксированный id, дедуп оптимистичных сообщений
    // начнёт склеивать чужие.
    { name: "id конверта всегда одинаковый (коллизии в дедупе)",
      pattern: "  return WireSignalRule.envelopeId(envelope);",
      replacement: "  return 'env-fixed';" },
    { name: "pending-id не распознаётся как pending",
      pattern: "export function isPendingId(id) {",
      replacement: "export function isPendingId(id) {\n  return false;" },
  ],
};
