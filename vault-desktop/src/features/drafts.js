// Feature module: drafts (черновики сообщений).
//
// ADR-005 W2 (`t_bcb8927a`), партия 13: модуль больше НЕ читает компонент.
// Черновик — у владельца чат-владельца (ADR-004 A14: newMessage/setDraft),
// активный чат и группа — у chatStore, email — у session-store.
//
// Текст недописанного сообщения сохраняется per-chat (sqlite kv 'drafts')
// и восстанавливается при возврате в чат. kv — read-modify-write: все
// операции идут через очередь на статике модуля, иначе параллельные
// saveDraft/restoreDraft затирают друг друга (гонка kv).

import { db } from '../api.js';
import { accountNamespace } from '../identity.js';
import { chatStore, sessionStore } from './session-store.js';

// Сериализует операции с kv-блобом черновиков (гонка save/restore).
let DRAFT_QUEUE = Promise.resolve();

export function draftRun(fn) {
  DRAFT_QUEUE = DRAFT_QUEUE.then(fn, fn);
  return DRAFT_QUEUE;
}

// Persist the current composer text as the draft of the active chat
// (empty text erases the chat's draft). Async — результат не ждётся.
export function saveDraft(deps) {
  const chatKey = chatStore.state.activeChatType === 'group' && chatStore.state.currentGroup
    ? 'group:' + chatStore.state.currentGroup.id
    : chatStore.state.activeChat;
  if (!chatKey) return;
  const text = deps.chat.state.newMessage || '';
  draftRun(async () => {
    try {
      const raw = await db.kvGet(await accountNamespace(sessionStore.getCurrentEmail()), 'drafts');
      const drafts = raw ? JSON.parse(raw) : {};
      if (text.trim()) drafts[chatKey] = text;
      else delete drafts[chatKey];
      await db.kvSet(await accountNamespace(sessionStore.getCurrentEmail()), 'drafts', JSON.stringify(drafts));
    } catch (e) { /* kv недоступен — черновик живёт до смены чата */ }
  });
}

// Restore the draft of the given chat into the composer (await-able: caller
// дожидается, чтобы restored-текст не перезаписался более поздним saveDraft).
export async function restoreDraft(deps, chatKey) {
  return draftRun(async () => {
    try {
      const raw = await db.kvGet(await accountNamespace(sessionStore.getCurrentEmail()), 'drafts');
      const drafts = raw ? JSON.parse(raw) : {};
      deps.chat.setDraft(drafts[chatKey] || '');
    } catch (e) { /* ignore */ }
  });
}
