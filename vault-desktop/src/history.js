// Локальная история чатов: расшифрованные сообщения персистятся в SQLite
// через Rust-бэкенд (db_history_save/db_history_load — таблица chat_history
// в ~/.local/share/com.vault.vault/vault.db) — как почтовый мессенджер хранит историю
// в SQLite, а не в браузерных хранилищах.
// юзером): IndexedDB в WebKitGTK у части пользователей молча не работает
// (0 записей, вечный onblocked); localStorage ограничен ~5 МБ (body-cache
// уже 3–7 МБ, длинная переписка не поместится). SQLite — без квот и без
// зависимости от веб-хранилищ. localStorage НЕ используется как источник
// истины вообще.
// Заметки для себя (__notes__) сюда НЕ пишутся — они живут в localStorage.

import { db } from './api.js';

export async function saveHistory(account, chatKey, messages) {
  if (!account || !chatKey || !Array.isArray(messages)) return;
  try {
    await db.historySave(account, chatKey, JSON.stringify(messages));
  } catch (e) {
    console.error('saveHistory (sqlite) failed:', e);
  }
}

export async function loadHistory(account, chatKey) {
  if (!account || !chatKey) return null;
  try {
    const json = await db.historyLoad(account, chatKey);
    if (!json) return null;
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    console.error('loadHistory (sqlite) failed:', e);
    return null;
  }
}

export async function clearHistory(account) {
  try {
    await db.historyClear(account);
  } catch (e) {
    console.error('clearHistory failed:', e);
  }
}
