// Набор мутаций: duress-state-mut
// Цель: убедиться, что смоук duress-state-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'duress-state-mut',
  file: 'src/features/duress/state.js',
  smoke: 'duress-state-smoke.mjs',
  mutations: [
    { name: "duressLocked по умолчанию true (обычный режим становится декой)",
      pattern: "    duressLocked: false,",
      replacement: "    duressLocked: true," },
    { name: "duressUnlockedThisSession по умолчанию true (декой переживает перезапуск)",
      pattern: "    duressUnlockedThisSession: false,",
      replacement: "    duressUnlockedThisSession: true," },
    { name: "duressPending по умолчанию true",
      pattern: "    duressPending: false,",
      replacement: "    duressPending: true," },
    { name: "поле duressUnlockedThisSession отсутствует вовсе",
      pattern: "    duressUnlockedThisSession: false,\n  };",
      replacement: "  };" },
  ],
};
