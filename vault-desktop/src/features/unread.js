// Feature module: непрочитанные счётчики и флаги «без звука».
//
// ADR-005 W3 (`t_b1bdbb99`), партия 5: логика уехала из App.vue. Счётчики —
// у владельца чата (chat-store, ADR-004 A11), флаги mute — у владельца папок
// (folders-store, ADR-004 J.7), персист — в sqlite kv.
import { db } from '../api.js';
import { accountNamespace } from '../identity.js';
import { foldersStore } from './folders-store.js';

// Счётчики + отметки «уже обработано» из kv.
export async function loadUnreadCounts(deps) {
  try {
    const ns = await accountNamespace(deps.email());
    const raw = await db.kvGet(ns, 'unread-counts');
    deps.setUnreadCounts(raw ? JSON.parse(raw) : {});
    const seenRaw = await db.kvGet(ns, 'unread-seen');
    deps.setProcessedUnreadIds(new Set(seenRaw ? JSON.parse(seenRaw) : []));
  } catch (e) {
    deps.setUnreadCounts({});
    deps.setProcessedUnreadIds(new Set());
  }
}

// Отметки «уже обработано» → kv.
export async function saveUnreadSeen(deps) {
  try {
    const ns = await accountNamespace(deps.email());
    await db.kvSet(ns, 'unread-seen', JSON.stringify(Array.from(deps.processedUnreadIds())));
  } catch (e) { /* kv недоступен — дедуп живёт в памяти до перезапуска */ }
}

// Счётчики → kv.
export async function saveUnreadCounts(deps) {
  try {
    const ns = await accountNamespace(deps.email());
    await db.kvSet(ns, 'unread-counts', JSON.stringify(deps.unreadCounts()));
  } catch (e) { /* kv недоступен — счётчики живут в памяти до перезапуска */ }
}

// Сбросить счётчик чата (и сохранить).
export async function resetUnread(deps, chatKey) {
  if (deps.unreadOf(chatKey) > 0) {
    deps.clearUnread(chatKey);
    await saveUnreadCounts(deps);
  }
}

// Флаг «без звука» для чата.
// Ключи chatFlags — lowercased (flagKey); chatKey из processIncoming может
// прийти в каноническом регистре контакта — нормализуем.
export function isMuted(key) {
  return !!foldersStore.flagOf(String(key || '').toLowerCase()).muted;
}
