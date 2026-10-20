// Набор мутаций: session-store-mut
// Цель: убедиться, что смоук session-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'session-store-mut',
  file: 'src/features/session-store.js',
  smoke: 'session-store-smoke.mjs',
  mutations: [
    { name: "пароль не очищается",
      pattern: "    clearPassword() { this.state.password = ''; return this.state.password; }",
      replacement: "    clearPassword() { return this.state.password; }" },
    { name: "выход не сбрасывает флаг входа",
      pattern: "    logout() {\n      this.state.isLoggedIn = false;",
      replacement: "    logout() {\n      void 0;" },
  ],
};
