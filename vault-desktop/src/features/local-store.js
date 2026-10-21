// Локальное хранилище состояния — ADR-005 W3 (App.vue → только вызовы).
//
// Три маленьких вещи, которые App.vue держал у себя:
//   * cursors — курсоры синхронизации (кэш в памяти + sqlite kv);
//   * sent reads — «прочитано»-отметки, которые мы ОТПРАВИЛИ (localStorage,
//     отдельный ключ на аккаунт).
//
// Почему модуль, а не методы компонента: это хранилище и его формат, а не
// поведение интерфейса. Правило: значение, которое переживает перезапуск, не
// живёт в компоненте.
//
// СМЫСЛ РАЗДЕЛЕНИЯ КУРСОРОВ И ОТМЕТОК «ПРОЧИТАНО»: разные хранилища и разные
// сроки жизни. Курсоры — sqlite kv (переживают переустановку профиля), отметки
// «прочитано» — localStorage (живут только в этом профиле браузера, и это
// осознанно: отметка «я это прочитал» не должна переезжать на другое
// устройство).
//
// deps (ADR-001 R3): явный контракт вместо доступа к this.
//   email       — наш адрес (ключ localStorage и пространство kv)
//   getCursors / setCursors — владелец кэша курсоров (в App.vue — data-поле)
//   db          — sqlite-обёртка (cursorsSave)
//   storage     — localStorage (в тестах — подделка; в Node — null)
const CURSORS_KEY = 'cursors';

export function loadCursors(deps, accountId) {
  return deps.getCursors() || {};
}

export function saveCursors(deps, accountId, cursors) {
  try {
    if (cursors && Object.keys(cursors).length) {
      deps.setCursors(cursors);
      deps.db.cursorsSave(accountId, JSON.stringify(cursors));
    }
  } catch (e) {
    console.error('saveCursors failed:', e);
  }
}

// Ключ хранения отметок «прочитано», которые мы отправили. На аккаунт:
// у разных адресов свой набор.
export function readsSentStorageKey(deps) {
  return 'vault-reads-sent-' + (deps.email || 'anon');
}

export function loadSentReads(deps) {
  const storage = deps.storage;
  if (!storage) return {};
  try {
    return JSON.parse(storage.getItem(readsSentStorageKey(deps)) || '{}');
  } catch (e) {
    return {};
  }
}

export function saveSentReads(deps, data) {
  const storage = deps.storage;
  if (!storage) return;
  try {
    storage.setItem(readsSentStorageKey(deps), JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save read receipts:', e);
  }
}
