// Набор мутаций: m0-wire-mut
// Цель: убедиться, что смоук m0-wire-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'm0-wire-mut',
  file: 'src/message-format.js',
  smoke: 'm0-wire-smoke.mjs',
  mutations: [
    { name: "конверт без метки vault:1 принимается",
      pattern: "    if (obj && obj.vault === 1 && typeof obj.text === 'string') {",
      replacement: "    if (obj && typeof obj.text === 'string') {" },
    { name: "ttl конверта не читается",
      pattern: "ttl: Number(obj.ttl) || 0,",
      replacement: "ttl: 0," },
    { name: "битый конверт роняет разбор вместо null",
      pattern: "  } catch { /* not an envelope — legacy plaintext */ }",
      replacement: "  } catch { throw new Error('not an envelope'); }" },
  ],
};
