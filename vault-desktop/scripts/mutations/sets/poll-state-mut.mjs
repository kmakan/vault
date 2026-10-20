// Набор мутаций: poll-state-mut
// Цель: убедиться, что смоук poll-state-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'poll-state-mut',
  file: 'src/features/poll/state.js',
  smoke: 'poll-state-smoke.mjs',
  mutations: [
    { name: "pollDialog открыт по умолчанию",
      pattern: "    pollDialog: false,",
      replacement: "    pollDialog: true," },
    { name: "pollTimer не null по умолчанию",
      pattern: "    pollTimer: null,",
      replacement: "    pollTimer: 0," },
    { name: "поле pollDialog отсутствует",
      pattern: "    pollDialog: false,\n",
      replacement: "" },
  ],
};
