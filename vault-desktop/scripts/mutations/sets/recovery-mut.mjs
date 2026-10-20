// Набор мутаций: recovery-mut
// Цель: убедиться, что смоук recovery-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'recovery-mut',
  file: 'src/features/recovery.js',
  smoke: 'recovery-smoke.mjs',
  mutations: [
    { name: "невалидная мнемоника НЕ блокирует экран восстановления",
      pattern: "    if (!(await crypto.recoveryValidateMnemonic(words))) {",
      replacement: "    if (false) {" },
    { name: "маркер восстановления ставится ПОСЛЕ логина (durable-авто-вход пройдёт)",
      pattern: "    if (!RecoverySession.markRecoveryPending()) {",
      replacement: "    if (false) {" },
    { name: "логин идёт С durable-персистом (ключ может не успеть импортироваться)",
      pattern: "      deferPersistence: true,",
      replacement: "      deferPersistence: false," },
    { name: "файл восстановления игнорируется, идём в эскроу",
      pattern: "    if (fileJson) {",
      replacement: "    if (false) {" },
    { name: "ключ генерируется вместо восстановления",
      pattern: "    const keyLoaded = await deps.initCrypto({ allowCreate: false });",
      replacement: "    const keyLoaded = await deps.initCrypto({ allowCreate: true });" },
    { name: "ключ не перезагружается перед входом",
      pattern: "    const keyLoaded = await deps.initCrypto({ allowCreate: false });",
      replacement: "    const keyLoaded = true;" },
    { name: "несовпадение публичного ключа не замечаем",
      pattern: "    if (!keyLoaded || deps.publicKey() !== expectedPublicKey) {",
      replacement: "    if (!keyLoaded) {" },
    { name: "эскроу не ищется, если нет файла",
      pattern: "      restored = await recoverFromEscrow(email, words, { api, crypto, invoke: importInvoke });",
      replacement: "      restored = true;" },
  ],
};
