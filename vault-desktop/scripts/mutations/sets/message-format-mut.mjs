// Набор мутаций: message-format-mut
// Цель: убедиться, что смоук message-format-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'message-format-mut',
  file: 'src/message-format.js',
  smoke: 'message-format-smoke.mjs',
  mutations: [
    { name: "цитата ответа теряется",
      pattern: "export function replyQuote(content) {\n  return splitReply(content).quote;\n}",
      replacement: "export function replyQuote(content) {\n  return '';\n}" },
    { name: "тело ответа теряется",
      pattern: "export function replyBody(content) {\n  return splitReply(content).body;\n}",
      replacement: "export function replyBody(content) {\n  return content;\n}" },
  ],
};
