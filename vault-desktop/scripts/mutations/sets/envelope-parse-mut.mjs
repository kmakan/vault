// Набор мутаций: envelope-parse-mut
// Цель: убедиться, что смоук envelope-rule-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'envelope-parse-mut',
  file: 'src/envelope-rule.js',
  smoke: 'envelope-rule-smoke.mjs',
  mutations: [
    { name: "при отказе моста разбор возвращает «null» строкой (письмо разбирается как мусор)",
      pattern: "    console.error('[envelope] Rust-разбор конверта недоступен:', e && e.message || e);\n    return null;",
      replacement: "    console.error('[envelope] Rust-разбор конверта недоступен:', e && e.message || e);\n    return 'null';" },
    { name: "пустой плейнтекст идёт в мост (лишний вызов и неверный разбор)",
      pattern: "  if (!plain || typeof plain !== 'string') return null;",
      replacement: "  if (false) return null;" },
  ],
};
