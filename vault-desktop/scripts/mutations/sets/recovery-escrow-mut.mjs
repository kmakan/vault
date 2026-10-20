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
    { name: "поток: лимит попыток поиска снят",
      pattern: "  if (attempt >= attempts) return false;",
      replacement: "  if (false) return false;" },
    { name: "поток: найденное письмо не копируется во INBOX",
      pattern: "              await copyToInbox(String(uid), folder);",
      replacement: "              void 0;" },
    { name: "поток: после копирования не предупреждаем",
      pattern: "              toast(t('recovery_moved_toast'), 12000);",
      replacement: "              void 0;" },
    { name: "поток: повтор поиска отключён (письмо придёт позже — и не найдётся)",
      pattern: "  return locateEscrowFlow(deps, wrappedJson, attempt + 1);",
      replacement: "  return false;" },
    { name: "поток: сверка только по salt (nonce/wrapped игнорируются)",
      pattern: "        if (p && p.salt === local.salt && p.nonce === local.nonce && p.wrapped === local.wrapped) {",
      replacement: "        if (p && p.salt === local.salt) {" },
  ],
};
