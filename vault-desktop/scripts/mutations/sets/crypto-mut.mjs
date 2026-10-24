// Набор мутаций: crypto-mut
// Цель: убедиться, что смоук crypto-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'crypto-mut',
  file: 'src/crypto.js',
  smoke: 'crypto-smoke.mjs',
  mutations: [
    { name: "PQ-гибридный конверт не распознаётся (isEncrypted → false)",
      pattern: "    if (raw.startsWith('PQ1:')) {",
      replacement: "    if (false) {" },
    { name: "PQ-конверт с неверным числом частей принимается",
      pattern: "      return this.privateKey !== null && raw.split('|').length === 3;",
      replacement: "      return this.privateKey !== null;" },
    { name: "слишком короткий base64 принимается за конверт",
      pattern: "      return decoded.length >= 25 && this.privateKey !== null;",
      replacement: "      return decoded.length >= 1 && this.privateKey !== null;" },
    { name: "пара ключей, где приватный = публичный, проходит",
      pattern: "  if (kp.private_key === kp.public_key) return false;",
      replacement: "  void 0;" },
    { name: "не-hex пара ключей проходит",
      pattern: "  const hex64 = /^[0-9a-f]{64}$/i;",
      replacement: "  const hex64 = /^[0-9a-z]{64}$/i;" },
    { name: "адаптер не передаёт свою почту (own_email = None → страж адреса в мосте не срабатывает никогда)",
      pattern: "      ownEmail: ownEmail || null,",
      replacement: "      ownEmail: null," },
  ],
};
