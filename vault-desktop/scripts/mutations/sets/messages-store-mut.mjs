// Набор мутаций: messages-store-mut
// Цель: убедиться, что смоук messages-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'messages-store-mut',
  file: 'src/features/messages-store.js',
  smoke: 'messages-store-smoke.mjs',
  mutations: [
    { name: "таймер не взводится",
      pattern: "    setTimer(key, fn, ms) { this.state.ephemeralTimers[key] = setTimeout(fn, ms); }",
      replacement: "    setTimer(key, fn, ms) { void 0; }" },
    { name: "таймер не очищается",
      pattern: "      delete this.state.ephemeralTimers[key];",
      replacement: "      void 0;" },
    { name: "тик индикатора не растёт",
      pattern: "    tick() { this.state.ephemeralTick += 1; }",
      replacement: "    tick() { void 0; }" },
  ],
};
