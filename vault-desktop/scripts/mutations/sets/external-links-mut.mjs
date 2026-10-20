// Набор мутаций: external-links-mut
// Цель: убедиться, что смоук batch2-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'external-links-mut',
  file: 'src/external-links.js',
  smoke: 'batch2-smoke.mjs',
  mutations: [
    { name: "нативная команда Android не используется (ссылка не откроется на телефоне)",
      pattern: "      await invoke('android_open_url', { url });",
      replacement: "      void 0;" },
    { name: "фолбэк через браузер отключён",
      pattern: "    await openExternal(String(url));",
      replacement: "    void 0;" },
    { name: "сайт приложения открывается при пустом APP_SITE_URL",
      pattern: "  if (!APP_SITE_URL) return;",
      replacement: "  void 0;" },
  ],
};
