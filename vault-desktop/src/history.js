// Локальная история чатов (M1, 19.08 → 20.08): расшифрованные сообщения
// персистятся в ФАЙЛ на диске через Rust-бэкенд (history_save/history_load,
// JSON-файл на чат) — как Delta Chat хранит историю в SQLite-файле, а не в
// браузерных хранилищах. Причины (фикс 20.08):
//   - IndexedDB в WebKitGTK у части пользователей молча не работает
//     (0 записей, вечный onblocked) — чаты открывались пустыми;
//   - localStorage ограничен ~5 МБ — длинная переписка не поместится.
// Файл на диске: нет квот, нет зависимости от веб-хранилищ. localStorage
// остаётся только быстрым кэшем (см. loadLocalHistory в App.vue).
// Заметки для себя (__notes__) сюда НЕ пишутся — они живут в localStorage.

import { invoke } from '@tauri-apps/api/core';

export async function saveHistory(account, chatKey, messages) {
  if (!account || !chatKey || !Array.isArray(messages)) return;
  try {
    await invoke('history_save', {
      email: account,
      chatKey,
      messagesJson: JSON.stringify(messages),
    });
  } catch (e) {
    console.error('saveHistory (file) failed:', e);
  }
}

export async function loadHistory(account, chatKey) {
  if (!account || !chatKey) return null;
  try {
    const json = await invoke('history_load', { email: account, chatKey });
    if (!json) return null;
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    console.error('loadHistory (file) failed:', e);
    return null;
  }
}

export async function clearHistory(account) {
  try {
    await invoke('history_clear', { email: account });
  } catch (e) {
    console.error('clearHistory failed:', e);
  }
}
