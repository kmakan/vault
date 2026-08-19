// Локальная история чатов (M1, 19.08): декриптованные сообщения персистятся
// в IndexedDB (лимит localStorage ~5МБ для вложений не годится). При открытии
// чата история показывается мгновенно, затем живой фетч из IMAP дополняет её
// новыми письмами и история обновляется. Хранилище:
//   store 'chats', key = `${accountEmail}|${chatKey}`, value = массив
//   полноценных message-объектов (как в this.messages: id, content, from,
//   sender_id, time, created_at, attachment, status, reactions...).
// Заметки для себя (__notes__) сюда НЕ пишутся — они живут в localStorage.

const DB_NAME = 'vault-history';
const DB_VERSION = 1;
const STORE = 'chats';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'chatKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function storeKey(account, chatKey) {
  return `${account}|${chatKey}`;
}

export async function saveHistory(account, chatKey, messages) {
  if (!account || !chatKey || !Array.isArray(messages)) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ chatKey: storeKey(account, chatKey), messages, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('saveHistory failed:', e);
  }
}

export async function loadHistory(account, chatKey) {
  if (!account || !chatKey) return null;
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(storeKey(account, chatKey));
      req.onsuccess = () => resolve(req.result ? req.result.messages : null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    console.error('loadHistory failed:', e);
    return null;
  }
}

export async function clearHistory(account) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    // Чистим только записи текущего аккаунта (ключ начинается с `${account}|`).
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        if (String(cursor.key).startsWith(`${account}|`)) cursor.delete();
        cursor.continue();
      }
    };
  } catch (e) {
    console.error('clearHistory failed:', e);
  }
}