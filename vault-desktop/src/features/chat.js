// Feature module: чат-область/чатKey (ADR-001).
// Чистые, не зависят от Vue-state: собираются из reactive-данных App.vue в proxy.
// Переиспользуется в send.js, attachments.js (fetchDod/sendAudio/handleFileSelect).

import { noteId } from '../note-id.js';
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

// buildNoteMessage: чистый optimistic-сообщение в «Заметки для себя»
// (локально, без шифрования и почты). now/timeStr инъецируются — чистота для smoke.
export function buildNoteMessage(payload, { now, timeStr }) {
  return {
    id: noteId(now),
    content: payload,
    from: 'me',
    time: timeStr,
    encrypted: false,
    vault: false,
    status: 'sent',
    _notes: true,
  };
}

// buildReplyPayload: чистая сборка тела сообщения с "> quote"-префиксом для reply.
// replyPreview — адаптер (App.vue передаёт стрелку через proxy).
export function buildReplyPayload(text, { replyTo, replyPreview }) {
  let payload = text;
  if (replyTo) {
    const quote = replyPreview(replyTo);
    if (quote) payload = `> ${quote}\n\n${text}`;
  }
  return payload;
}

// buildSendingMessage: чистый optimistic-сообщение при отправке (peer/group).
// envelopeId уже известен (envelopeId || pending). now/timeStr инъецируются.
// expiresAt — ГОТОВЫЙ момент истечения (правило в Rust, ADR-005 R1/W4):
// функция остаётся чистой и не решает «когда истечёт» сама.
export function buildSendingMessage({ envelopeId, payload, ttl, now, timeStr, pendingIdOf, expiresAt }) {
  return {
    id: envelopeId || (pendingIdOf ? pendingIdOf() : ''),
    content: payload,
    from: 'me',
    time: timeStr,
    ts: now,
    encrypted: true,
    vault: true,
    status: 'sending',
    _pendingAt: now,
    ttl: ttl || 0,
    expiresAt: expiresAt || 0,
  };
}
