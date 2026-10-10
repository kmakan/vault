// Feature module: durable-маркер прерванного восстановления аккаунта
// (fix/recovery-resilience). Изоляция фичи (канбан t_7c3929d2): новый модуль,
// App.vue — только делегаты/узкое wiring.
//
// Маркер 'vault-recovery-pending'='1' — НЕСЕКРЕТНЫЙ флаг «восстановление
// начато, но ещё не закоммичено». Он нужен, потому что восстановление идёт
// ЧЕРЕЗ обычный вход (api.login) — а тот писал бы durable token/email/
// credentials ДО того, как ключ реально загружен с диска. Если приложение
// закрылось/упало между логином и импортом ключа, durable-состояние
// утверждало бы «мы вошли», хотя ключей нет — и следующий старт либо
// создал бы НОВУЮ пару (потеря аккаунта), либо молча обошёл бы прерванное
// восстановление. Маркер блокирует оба пути.
//
// Требования к маркеру (жёстко):
//   • пишется ДО попытки recovery-логина, но ПОСЛЕ проверки мнемоники
//     (невалидные слова не должны запирать экран);
//   • НИКОГДА не содержит email/пароль/слова/тело письма/backup — только '1';
//   • снимается ПОСЛЕДНИМ, только после успешного import + перезагрузки
//     ключа + durable commit. Любая ошибка → маркер остаётся;
//   • живёт в localStorage (переживает перезапуск webview).
//
// Модуль намеренно НЕ импортирует api.js/crypto.js — только так избегается
// цикл (api.js тоже должен видеть маркер). Поэтому всё состояние — в
// localStorage, а storage инъектируется параметром для тестов.

export const RECOVERY_MARKER_KEY = 'vault-recovery-pending';

// localStorage может быть недоступен (приватный режим, файловая схема).
// Ни один вызов не должен бросать наружу — иначе сломается старт приложения.
function getStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (e) { /* localStorage бросил — маркер недоступен */ }
  return null;
}

// true, если прерванное восстановление ещё не завершено.
export function isRecoveryPending(storage) {
  const s = getStorage(storage);
  if (!s) return false;
  try { return s.getItem(RECOVERY_MARKER_KEY) === '1'; }
  catch (e) { return false; }
}

// Пометить восстановление как начатое-но-не-закоммиченное.
// Без durable-маркера recovery не может безопасно начаться: вызывающий
// поток проверяет false и отказывает ДО подключения/импорта.
export function markRecoveryPending(storage) {
  const s = getStorage(storage);
  if (!s) return false;
  try {
    s.setItem(RECOVERY_MARKER_KEY, '1');
    return s.getItem(RECOVERY_MARKER_KEY) === '1';
  }
  catch (e) { return false; }
}

// Снять маркер. Вызывается ТОЛЬКО после успешного durable commit.
export function clearRecoveryPending(storage) {
  const s = getStorage(storage);
  if (!s) return false;
  try {
    s.removeItem(RECOVERY_MARKER_KEY);
    return s.getItem(RECOVERY_MARKER_KEY) === null;
  }
  catch (e) { return false; }
}

// Модульный guard для обычных путей (логин/авто-вход): пока маркер стоит,
// обычный вход НЕ имеет права запускаться — иначе он создал бы новую пару
// ключей вместо восстановленной. Возвращает сообщение для UI (переведённое
// через инъектированный t) либо null, если проходить можно.
export function recoveryBlockMessage(t, storage) {
  if (!isRecoveryPending(storage)) return null;
  const msg = typeof t === 'function' ? t('recovery_interrupted') : '';
  return msg || 'recovery_interrupted';
}
