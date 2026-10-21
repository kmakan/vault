// Набор мутаций: batch2-mut
// Цель: убедиться, что смоук batch2-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'batch2-mut',
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
    { name: "перенос аккаунта выполняется, даже когда namespace не изменился",
      pattern: "    if (!ns || ns === oldEmail) {",
      replacement: "    if (!ns) {",
      file: "src/migrations.js" },
    { name: "ошибка переноса аккаунта не гасится",
      pattern: "  } catch (e) {\n    console.warn('[identity] migrateAccountData failed:', e);\n  }",
      replacement: "  } catch (e) {\n    throw e;\n  }",
      file: "src/migrations.js" },
    { name: "свои группы не переименовываются при смене почты",
      pattern: "    const mine = String(g.created_by || '').toLowerCase() === old\n      || (g.members || []).some(m => String(m.email || '').toLowerCase() === old);",
      replacement: "    const mine = false;",
      file: "src/migrations.js" },
  ],
};
