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
import { accountNamespace } from './identity.js';

// Идентичность записи истории: id конверта, иначе Message-ID письма, иначе
// пара «содержимое + время». Пустые объекты (`{}` из старых сборок) личности
// не имеют — они не сообщения и в архив не попадают.
function historyKey(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const id = m.id || m.mid || (m.email && m.email.message_id);
  if (id) return 'id:' + String(id);
  const c = typeof m.content === 'string' ? m.content : '';
  const t = m.ts || (m.email && new Date(m.email.date || 0).getTime()) || 0;
  if (!c && !t) return null;
  return 'c:' + c + '@' + t;
}

// Стабильный id для записей без id (старые сборки писали в архив сообщения
// без id/mid). Без id невозможно ни поставить реакцию, ни отредактировать:
// `chat.patch(id)` ищет по id, а пикер сравнивает `reactionPickerId ===
// msg.id`. Идентификатор выводится из того же ключа, что и слияние, поэтому
// он одинаков при каждом чтении архива.
function digest(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Нормализация списка из хранилища: мусор (`{}`) отбрасывается, записям без
// id присваивается стабильный id. Одна функция на архив и на chat-cache —
// иначе правила расходятся (архив чистится, кэш показывает пузыри).
export function normalizeHistoryList(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const m of arr) {
    const k = historyKey(m);
    if (!k) continue;
    out.push(m && m.id ? m : { ...m, id: 'h:' + digest(k) });
  }
  return out;
}

// Слияние архива: записи нового списка выигрывают (свежий статус/правка),
// записи, которых в новом нет, ОСТАЮТСЯ. История — архив, а не снимок
// экрана: пустой или неполный список (гонка открытия чата с поллингом,
// письма ещё не расшифрованы) не должен её укорачивать.
export function mergeHistoryLists(prev, next) {
  const out = [];
  const at = new Map();
  const put = (m) => {
    const k = historyKey(m);
    if (!k) return;
    if (at.has(k)) out[at.get(k)] = m;
    else { at.set(k, out.length); out.push(m); }
  };
  for (const m of prev || []) put(m);
  for (const m of next || []) put(m);
  return out;
}

// ВНИМАНИЕ: account — это уже namespace (fp:<fingerprint>), а не емейл.
// Резолвер идемпотентен и кэширован, поэтому повторный вызов на каждый
// save/load безопасен и почти бесплатен. Старые строки под емейлом уже
// перенесены на стороне Rust (db_account_migrate).

// Очередь на ключ «аккаунт+чат». Слияние — это read-modify-write: два
// поллинга одного чата могут прочесть один и тот же prev и записать два
// разных результата, и позже записанный сотрёт более свежий. Чтение тоже
// становитcя в очередь — иначе сразу после записи можно прочесть устаревший
// архив (именно так «исчезало» только что отправленное сообщение).
const archiveQueue = new Map();

function queued(key, task) {
  const prev = archiveQueue.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => {});
  archiveQueue.set(key, tail);
  tail.then(() => { if (archiveQueue.get(key) === tail) archiveQueue.delete(key); });
  return run;
}

export function saveHistory(account, chatKey, messages) {
  if (!account || !chatKey || !Array.isArray(messages)) return Promise.resolve();
  return queued(account + '|' + chatKey, async () => {
    try {
      const ns = await accountNamespace(account);
      // Читаем текущий архив и сливаем: запись никогда не укорачивается и не
      // обнуляется. До этого пустой merged в loadMessages затирал переписку
      // (чат «менялся», отправленное сообщение исчезало).
      let write = messages;
      try {
        const raw = await db.historyLoad(ns, chatKey);
        const prev = raw ? JSON.parse(raw) : null;
        if (Array.isArray(prev)) write = mergeHistoryLists(prev, messages);
      } catch (e) { /* прошлого архива нет — пишем как есть */ }
      await db.historySave(ns, chatKey, JSON.stringify(write));
    } catch (e) {
      console.error('saveHistory (sqlite) failed:', e);
    }
  });
}

export function loadHistory(account, chatKey) {
  if (!account || !chatKey) return Promise.resolve(null);
  return queued(account + '|' + chatKey, async () => {
    try {
      const json = await db.historyLoad(await accountNamespace(account), chatKey);
      if (!json) return null;
      const arr = JSON.parse(json);
      // Мусорные записи (`{}` из старых сборок) отбрасываем: иначе они
      // рендерятся пустыми пузырями и снова попадают в архив при сохранении.
      // Записям без id даём стабильный id — без него не работают реакции.
      return normalizeHistoryList(arr);
    } catch (e) {
      console.error('loadHistory (sqlite) failed:', e);
      return null;
    }
  });
}

export async function clearHistory(account) {
  try {
    await db.historyClear(await accountNamespace(account));
  } catch (e) {
    console.error('clearHistory failed:', e);
  }
}
