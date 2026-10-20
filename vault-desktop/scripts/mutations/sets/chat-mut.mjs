// Набор мутаций: chat-mut
// Цель: убедиться, что смоук chat-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'chat-mut',
  file: 'src/features/chat.js',
  smoke: 'chat-smoke.mjs',
  mutations: [
    { name: "ключ группы собирается неверно",
      pattern: "export function resolveChatKey({ activeChat, activeChatType, currentGroup }) {",
      replacement: "export function resolveChatKey({ activeChat, activeChatType, currentGroup }) {\n  return activeChat;" },
    { name: "дубли отправки не отсекаются",
      pattern: "export function isRecentDuplicate({ lastSend, chatId, text, now }, WINDOW_MS = 30000) {",
      replacement: "export function isRecentDuplicate({ lastSend, chatId, text, now }, WINDOW_MS = 30000) {\n  return false;" },
    { name: "цитата ответа не подставляется",
      pattern: "export function buildReplyPayload(text, { replyTo, replyPreview }) {",
      replacement: "export function buildReplyPayload(text, { replyTo, replyPreview }) {\n  return text;" },
    { name: "срок истечения не вычисляется",
      pattern: "    expiresAt: expiresAt || 0,",
      replacement: "    expiresAt: 0," },
  ],
};
