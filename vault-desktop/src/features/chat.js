// Feature module: чат-область/чатKey (ADR-001).
// Чистые, не зависят от Vue-state: собираются из reactive-данных App.vue в proxy.
// Переиспользуется в send.js, attachments.js (fetchDod/sendAudio/handleFileSelect).
export const CHAT_SCOPE = { group: 'group', peer: 'peer', channel: 'channel', notes: 'notes', self: 'self' };

// Группа → 'group:<id>'; иначе activeChat (peer / '__notes__' / канал).
export function resolveChatKey({ activeChat, activeChatType, currentGroup }) {
  if (activeChatType === 'group' && currentGroup) return 'group:' + currentGroup.id;
  return activeChat;
}

// Дедуп за 30 с: один и тот же текст в один чат за 30 с не шлёт дважды.
export function isRecentDuplicate({ lastSend, chatId, text, now }, WINDOW_MS = 30000) {
  return !!lastSend
    && lastSend.chat === chatId
    && lastSend.text === text
    && (now - lastSend.ts) < WINDOW_MS;
}
