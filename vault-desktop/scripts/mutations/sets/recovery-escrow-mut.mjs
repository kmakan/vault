// Набор мутаций: recovery-escrow-mut
// Цель: убедиться, что смоук recovery-escrow-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'recovery-escrow-mut',
  file: 'src/features/recovery-escrow.js',
  smoke: 'recovery-escrow-smoke.mjs',
  mutations: [
    { name: "успех признаётся при ok !== true (ключ не отправлен, а UI говорит «сохранено»)",
      pattern: "  if (!res || res.ok !== true) {",
      replacement: "  if (!res) {" },
    { name: "тело письма не собирается",
      pattern: "  const body = await crypto.recoveryBuildEscrowEmail(wrappedJson);",
      replacement: "  const body = '';" },
    { name: "наружу отдаётся не тот ключ",
      pattern: "  return { wrappedJson, spamToastKey };",
      replacement: "  return { wrappedJson: '', spamToastKey };" },
  ],
};
