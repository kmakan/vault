// Набор мутаций: forward-state-mut
// Цель: убедиться, что смоук forward-state-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'forward-state-mut',
  file: 'src/features/forward/state.js',
  smoke: 'forward-state-smoke.mjs',
  mutations: [
    { name: "forwardTo не null по умолчанию (диалог пересылки открыт сразу)",
      pattern: "    forwardTo: null,",
      replacement: "    forwardTo: {}," },
    { name: "поле forwardTo отсутствует",
      pattern: "    forwardTo: null,\n  };",
      replacement: "  };" },
  ],
};
