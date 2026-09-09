// Feature module: drafts (черновики сообщений). Stage 1 of the App.vue
// decomposition — pure functions receive the component instance as `ctx`
// instead of `this`, so every dependency is explicit and testable in
// isolation.
//
// Текст недописанного сообщения сохраняется per-chat (sqlite kv 'drafts')
// и восстанавливается при возврате в чат. kv — read-modify-write: все
// операции идут через очередь на статике модуля, иначе параллельные
// saveDraft/restoreDraft затирают друг друга (гонка kv).

import { db } from '../api.js';

// Сериализует операции с kv-блобом черновиков (гонка save/restore).
let DRAFT_QUEUE = Promise.resolve();

export function draftRun(fn) {
  DRAFT_QUEUE = DRAFT_QUEUE.then(fn, fn);
  return DRAFT_QUEUE;
}

// Persist the current composer text as the draft of the active chat
// (empty text erases the chat's draft). Async — результат не ждётся.
export function saveDraft(ctx) {
  const chatKey = ctx.activeChatType === 'group' && ctx.currentGroup
    ? 'group:' + ctx.currentGroup.id
    : ctx.activeChat;
  if (!chatKey) return;
  const text = ctx.newMessage || '';
  draftRun(async () => {
    try {
      const raw = await db.kvGet(ctx.email || 'anon', 'drafts');
      const drafts = raw ? JSON.parse(raw) : {};
      if (text.trim()) drafts[chatKey] = text;
      else delete drafts[chatKey];
      await db.kvSet(ctx.email || 'anon', 'drafts', JSON.stringify(drafts));
    } catch (e) { /* kv недоступен — черновик живёт до смены чата */ }
  });
}

// Restore the draft of the given chat into the composer (await-able: caller
// дожидается, чтобы restored-текст не перезаписался более поздним saveDraft).
export async function restoreDraft(ctx, chatKey) {
  return draftRun(async () => {
    try {
      const raw = await db.kvGet(ctx.email || 'anon', 'drafts');
      const drafts = raw ? JSON.parse(raw) : {};
      ctx.newMessage = drafts[chatKey] || '';
    } catch (e) { /* ignore */ }
  });
}
