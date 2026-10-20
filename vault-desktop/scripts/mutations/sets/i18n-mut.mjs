// Набор мутаций: i18n-mut
// Цель: убедиться, что смоук i18n-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'i18n-mut',
  file: 'src/i18n.js',
  smoke: 'i18n-smoke.mjs',
  mutations: [
    { name: "непереведённый ключ показывается как сам ключ (пользователь видит «report_send»)",
      pattern: "    let s = locales[state.locale]?.[key] || locales.en[key] || key",
      replacement: "    let s = locales[state.locale]?.[key] || key" },
    { name: "английский fallback отключён (в ru ключ из en не подставляется)",
      pattern: "    let s = locales[state.locale]?.[key] || locales.en[key] || key",
      replacement: "    let s = locales[state.locale]?.[key] || ''" },
    { name: "параметры не подставляются в {плейсхолдер}",
      pattern: "        s = s.replaceAll('{' + k + '}', String(v))",
      replacement: "        void 0;" },
    { name: "подставляется только первый параметр (остальные висят плейсхолдерами)",
      pattern: "      for (const [k, v] of Object.entries(params)) {",
      replacement: "      for (const [k, v] of Object.entries(params).slice(0, 1)) {" },
    { name: "неизвестный язык переключается (интерфейс на несуществующем языке)",
      pattern: "    if (locales[locale]) {",
      replacement: "    if (true) {" },
    { name: "выбор языка не сохраняется (после перезапуска язык сбрасывается)",
      pattern: "      localStorage.setItem('vault-locale', locale)",
      replacement: "      void 0;" },
  ],
};
