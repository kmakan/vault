// Набор мутаций: logout-mut
// Цель: убедиться, что смоук logout-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'logout-mut',
  file: 'src/features/logout.js',
  smoke: 'logout-smoke.mjs',
  mutations: [
    { name: "поллинг реле не останавливается (ход после выхода)",
      pattern: "  stopPolling();",
      replacement: "  void 0;" },
    { name: "heartbeat присутствия не останавливается",
      pattern: "  stopHeartbeats();",
      replacement: "  void 0;" },
    { name: "сброс логина не выполняется",
      pattern: "  resetLogin();",
      replacement: "  void 0;" },
    { name: "сброс почты не выполняется (письма остаются в ящике)",
      pattern: "  resetMailbox();",
      replacement: "  void 0;" },
    { name: "ошибка IMAP роняет выход (пользователь остаётся в сессии)",
      pattern: "  try { await logoutApi(); } catch (e) { /* ignore — выход всё равно делаем */ }",
      replacement: "  await logoutApi();" },
    { name: "сброс состояния идёт ДО выхода из IMAP (поллинг успеет сходить на сервер)",
      pattern: "  try { await logoutApi(); } catch (e) { /* ignore — выход всё равно делаем */ }\n  resetLogin();",
      replacement: "  resetLogin();\n  try { await logoutApi(); } catch (e) { /* ignore — выход всё равно делаем */ }" },
  ],
};
