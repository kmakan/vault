// Набор мутаций: транспорт входа (src/api.js).
//
// Здесь проверяется САМОЕ ОПАСНОЕ место входа: порядок durable-состояния при
// восстановлении. Правила:
//   * deferPersistence=true → durable-состояние (localStorage/credentials/
//     миграция) НЕ трогаем: иначе падение между логином и импортом ключа
//     зафиксировало бы «вход без ключей»;
//   * commitRecoveryLogin → durable token/email → credentials → миграция →
//     маркер снят ПОСЛЕДНИМ (любая ошибка оставляет маркер, и следующий
//     старт обязан снова пройти восстановление);
//   * commit без сессии в памяти — ошибка, а не тихий «успех».
export default {
  id: 'api-login',
  file: 'src/api.js',
  smoke: 'recovery-session-smoke.mjs',
  mutations: [
    { name: 'deferPersistence игнорируется (durable-состояние пишется до импорта ключа)',
      pattern: '    if (deferPersistence) {',
      replacement: '    if (false) {' },
    { name: 'токен не пишется в localStorage (вход не переживёт перезапуск)',
      pattern: "    localStorage.setItem('vault-token', this.token);\n    localStorage.setItem('vault-email', email);",
      replacement: "    localStorage.setItem('vault-email', email);" },
    { name: 'учётные данные сохраняются даже при remember=false',
      pattern: '    if (remember) {\n      try {',
      replacement: '    if (true) {\n      try {' },
    { name: 'commit: маркер прерванного восстановления не снимается (восстановление зациклится)',
      pattern: "    if (!recoveryClearPending()) throw new Error('Recovery state could not be committed');",
      replacement: '    void 0;' },
    { name: 'commit без сессии в памяти проходит (тихий «успех» входа)',
      pattern: "    if (!this.email) throw new Error('commitRecoveryLogin: no session in memory');",
      replacement: '    void 0;' },
    { name: 'commit: durable-токен не пишется (восстановление не закрепится)',
      pattern: "    localStorage.setItem('vault-token', this.token);\n    localStorage.setItem('vault-email', this.email);\n    if (remember) {",
      replacement: "    localStorage.setItem('vault-email', this.email);\n    if (remember) {" },
  ],
};
