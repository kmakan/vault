// Набор мутаций: message-format-mut
// Цель: убедиться, что смоук message-format-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// Инлайн-текст вложения с 28.10 раскодирует ядро (body-decode.js), поэтому
// здесь меряется проводка: спрашиваем ли мост, ждём ли ответ и обрезаем ли
// уже ДЕКОДИРОВАННЫЙ текст (иначе лимит 8000 считался бы по base64).
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
    { name: "текст вложения не раскодируется — в карточку идёт base64 конверта",
      pattern: "        const decoded = await decodeUrlSafeText(String(parsed.data || ''));",
      replacement: "        const decoded = String(parsed.data || '');" },
    { name: "раскодированный текст не ожидается (в textContent попадает Promise)",
      pattern: "        const decoded = await decodeUrlSafeText(String(parsed.data || ''));",
      replacement: "        const decoded = decodeUrlSafeText(String(parsed.data || ''));" },
    { name: "обрезка длинного текста считается не по декодированному содержимому",
      pattern: "        if (textContent.length > 8000) textContent = textContent.slice(0, 8000) + '\\n…';",
      replacement: "        if (textContent.length > 5000) textContent = textContent.slice(0, 5000) + '\\n…';" },
  ],
};
