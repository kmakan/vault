// Набор мутаций: themes-mut
// Цель: убедиться, что смоук themes-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'themes-mut',
  file: 'src/themes.js',
  smoke: 'themes-smoke.mjs',
  mutations: [
    { name: "выбор темы не сохраняется (после перезапуска — другая тема)",
      pattern: "  localStorage.setItem('vault-theme', themeId)",
      replacement: "  void 0;" },
    { name: "неизвестная тема применяется (стирает оформление)",
      pattern: "  if (!theme) return",
      replacement: "  if (false) return" },
    { name: "сохранённая тема не читается (всегда тёмная)",
      pattern: "  return localStorage.getItem('vault-theme') || 'dark'",
      replacement: "  return 'dark'" },
    { name: "переменные темы не пишутся (тема не применяется)",
      pattern: "    root.style.setProperty(key, value)",
      replacement: "    void 0;" },
  ],
};
