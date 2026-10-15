// Идентичность аккаунта: fingerprint публичного ключа и namespace хранилища.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ (ADR-001 Этап 2). Резолвер namespace нужен почти
// всему: черновики, флаги чатов, body-cache, история, релей. Лежал он внутри
// api.js, и из-за этого транспорт (relay-client.js) импортировал api.js ради
// одного вызова — а api.js в свою очередь тянет relay-client для
// relayGroupPublish. Получался цикл: правка транспорта задевала api, правка
// api — транспорт, и нигде в стектрейсе не было видно, где именно.
//
// Идентичность — не транспорт и не бизнес-логика почты. Это нижний слой:
//   identity.js (здесь) → api.js / relay-client.js (транспорт)
//                       → features/* (фичи) → компоненты
//
// СВОЙСТВА, КОТОРЫЕ ЗДЕСЬ ЖИВУТ ПО СМЫСЛУ, И КОТОРЫЕ НЕЛЬЗЯ РАЗОРВАТЬ:
// · кэш привязан к ЗНАЧЕНИЮ public_key, а не к факту вызова — ключ может
//   появиться позже (вход по recovery-мнемонике грузит пару после первого
//   резолвера), и тогда кэш пересчитывается сам, без ручного сброса;
// · резолвер fail-open: если команда недоступна (нет команды, нет БД), берём
//   емейл и НЕ блокируем вход. Понятый как «пространство имён» — тоже
//   fail-open: ошибка не должна стоить пользователю входа.
import { invoke } from '@tauri-apps/api/core';
import cryptoClient from './crypto.js';

let _accountNs = null;      // последний вычисленный namespace
let _accountNsFor = null;   // email, для которого он вычислен
let _cachedFp = null;       // fingerprint публичного ключа (или '' если нет ключа)
let _cachedFpKey = null;    // public_key, для которого закэширован _cachedFp
let _nsMigrated = false;    // миграция namespace уже выполнялась в этой сессии

// Fingerprint нашего публичного ключа. Пустая строка = ключ ещё не загружен
// (или ошибка) → вызывающий код работает на legacy-емейле, вход не блокируем.
async function accountFingerprint() {
  const pk = (cryptoClient && cryptoClient.publicKey) || '';
  if (_cachedFp !== null && _cachedFpKey === pk) return _cachedFp;
  if (!pk) {
    _cachedFp = '';
    _cachedFpKey = '';
    return _cachedFp;
  }
  try {
    const fp = await cryptoClient.fingerprint();
    _cachedFp = String(fp || '').trim().toLowerCase();
  } catch (e) {
    // Сбой крипто-команды — не падаем: legacy-емейл, вход не блокируем.
    console.log('[identity] fingerprint unavailable:', e && e.message || e);
    _cachedFp = '';
  }
  _cachedFpKey = pk;
  return _cachedFp;
}

// Namespace аккаунта для вызова db.*/history.*.
// Кэш валиден для пары (public_key, email): смена почты даёт другой email,
// появление ключа — другой public_key → пересчёт.
export async function accountNamespace(email) {
  const em = String(email || '').trim().toLowerCase();
  const pk = (cryptoClient && cryptoClient.publicKey) || '';
  if (_accountNs !== null && _accountNsFor === em && _cachedFpKey === pk) return _accountNs;
  const fp = await accountFingerprint();
  let ns = em;
  try {
    const resolved = await invoke('db_account_namespace', { fp, email: em });
    if (resolved) ns = String(resolved);
  } catch (e) {
    // Резолвер недоступен (нет команды/БД) — емейл, вход не блокируем.
    console.log('[identity] account namespace resolve failed:', e && e.message || e);
    ns = em;
  }
  _accountNs = ns;
  _accountNsFor = em;
  return ns;
}

// Сброс кэшей резолвера (экспорт для точечных вызовов; сам факт смены
// ключа/почты и так инвалидирует кэш — см. accountFingerprint).
export function resetAccountNamespaceCache() {
  _accountNs = null;
  _accountNsFor = null;
  _cachedFp = null;
  _cachedFpKey = null;
  _nsMigrated = false;
}

// Резолв + одноразовый перенос legacy-строк (старый емейл → fp-namespace).
// Вызывается при входе/смене почты, когда ключ уже загружен. Команда
// db_account_migrate идемпотентна, но и вызываем её мы ровно ОДИН раз на пару.
export async function ensureAccountNamespace(email) {
  const ns = await accountNamespace(email);
  const em = String(email || '').trim().toLowerCase();
  if (_nsMigrated || !ns.startsWith('fp:') || !em || em === ns) return ns;
  // Ставим флаг ДО вызова: пара (старый адрес → fp) повторно не обрабатывается.
  _nsMigrated = true;
  try {
    const report = await invoke('db_account_migrate', { fromAccount: em, toAccount: ns });
    const moved = report && typeof report.total === 'number' ? report.total : 0;
    console.log(`[identity] namespace migrated: ${em} → ${ns} (moved ${moved})`);
  } catch (e) {
    console.warn('[identity] namespace migration failed:', e);
  }
  return ns;
}