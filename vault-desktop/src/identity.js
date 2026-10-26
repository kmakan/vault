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
let _aliasLookup = null;    // словарь смен почты, уже разрешённый ядром
let _aliasLookupNs = null;  // namespace, для которого он вычислен

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
  _aliasLookup = null;
  _aliasLookupNs = null;
}

// ── «Это я?» и «какими формами адреса это один и тот же пир» ──────────
// ОБА вопроса решает ядро (`vault_core::identity`), здесь только транспорт и
// форма ответа. Раньше «свой или нет» сравнивало строки в трёх местах фронта
// (список контактов, обход peer_keys при broadcast профиля), а гейт «есть ли
// ключ собеседника» не знал словаря `email-aliases`: после смены почты у пира
// тап по известному адресу открывал попап «Добавить контакт» вместо чата, а
// письмо-профиль уходило самому себе (живые данные телефона, 24.10).

// Записи WITHOUT нашего аккаунта: адрес (email ∪ алиасы) или наш публичный
// ключ — мера в `contacts_drop_own`. Fail-open: мост молчит → прежнее
// сравнение строк, список не теряется.
export async function dropOwnEntries(entries, email) {
  const list = entries || [];
  try {
    const ourKey = String((cryptoClient && cryptoClient.publicKey) || '');
    const aliases = list
      .filter(e => e.public_key && ourKey
        && String(e.public_key).toLowerCase() === ourKey.toLowerCase())
      .map(e => e.email);
    const fingerprint = ourKey ? String((await cryptoClient.fingerprint()) || '') : '';
    const kept = await invoke('contacts_drop_own', {
      email: email || '',
      fingerprint,
      aliases,
      contacts: list.map(e => [e.email || '', e.public_key || '']),
    });
    if (!Array.isArray(kept)) throw new Error('contacts_drop_own: не список');
    const keep = new Set(kept.map(([e]) => String(e).toLowerCase()));
    return list.filter(e => keep.has(String(e.email || '').toLowerCase()));
  } catch (e) {
    return list.filter(e => e.email !== email);
  }
}

// Формы адреса, под которыми может лежать ключ собеседника (сам адрес, конец
// цепочки old→new, старые адреса, резолвящиеся в этот). Пустой ответ моста —
// не «нет форм»: остаётся голый адрес, как до переноса правила в Rust.
export async function addressVariants(address, email) {
  const bare = String(address || '').trim().toLowerCase();
  if (!bare) return [];
  try {
    const v = await invoke('identity_address_variants', {
      account: await accountNamespace(email),
      address: bare,
    });
    if (Array.isArray(v) && v.length) return v.map(x => String(x));
  } catch (e) { /* словарь недоступен — резолв по голому адресу */ }
  return [bare];
}

// Ключ пира и адрес, под которым он найден (формы адреса решает ядро, см.
// `addressVariants`; здесь перебор и возврат первого найденного). Пустой ключ
// = «ключа нет ни под одной формой» — вызывающий показывает обмен ключами.
export async function peerContactFor(address, peerKeys, email) {
  const variants = await addressVariants(address, email);
  // Ключи `peer_keys.json` — Сырые адреса, как их записали (регистр и
  // обрамление сохранены), поэтому карта приводится к нормальной форме
  // ядровского `normalize` = trim + lower. Это механика доступа к памяти, а
  // не решение: КАКИМИ формами адреса это один пир — решает ядро.
  const keys = {};
  for (const [a, k] of Object.entries(peerKeys || {})) {
    const norm = String(a).trim().toLowerCase();
    if (k && !keys[norm]) keys[norm] = k;
  }
  const bare = String(address || '').trim().toLowerCase();
  for (const v of variants) {
    const k = keys[v];
    if (k) return { address: v, key: k };
  }
  return { address: bare, key: '' };
}

// ── Смена почты собеседника: какой адрес у пира сейчас ──────────────────
// Письма в ящике навсегда остаются со старым sender. КАКОЙ адрес свежий —
// решает ядро (`vault_core::identity`: цепочка old→new, цикл A→B→A
// обрывается): сюда приходит уже разрешённый словарь «строка → свежий адрес»,
// а не пары, которые надо обходить в JS. Кэш — на namespace аккаунта;
// fail-open: мост молчит → адрес отдаём как есть, переписка не теряется.
function aliasLookupFrom(pairs) {
  const map = new Map();
  if (!Array.isArray(pairs)) return map;
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const k = String(p[0] || '');
    if (k) map.set(k, String(p[1] || ''));
  }
  return map;
}

async function cachedAliasLookup(email) {
  const ns = await accountNamespace(email);
  if (_aliasLookup && _aliasLookupNs === ns) return _aliasLookup;
  try {
    const pairs = await invoke('identity_alias_resolutions', { account: ns });
    _aliasLookup = aliasLookupFrom(pairs);
  } catch (e) {
    // Сбой моста кэшируем пустым словарём: резолв идёт по голому адресу, как
    // до переноса правила, и не дёргает мост на каждое письмо.
    _aliasLookup = new Map();
  }
  _aliasLookupNs = ns;
  return _aliasLookup;
}

// Свежий адрес для строки из письма/списка. Без смены — исходный адрес как
// есть (вызывающий сравнивает его с тем, что показывал).
export async function resolveAlias(address, email) {
  const key = String(address || '').trim().toLowerCase();
  if (!key) return address;
  const map = await cachedAliasLookup(email);
  return map.get(key) || address;
}

// Запомнить смену: правило записи (замена старой пары и анти-цикл A→B→A) —
// в ядре, ответ — новый разрешённый словарь, им же обновляем кэш. Ошибка
// чтения/записи не стирает кэш: показывать «смен не было» из-за сбоя хуже,
// чем продолжить с прежним словарём.
export async function rememberAlias(oldEmail, newEmail, email) {
  const o = String(oldEmail || '').trim().toLowerCase();
  const n = String(newEmail || '').trim().toLowerCase();
  if (!o || !n || o === n) return;
  try {
    const ns = await accountNamespace(email);
    const pairs = await invoke('identity_alias_remember', {
      account: ns,
      oldEmail: o,
      newEmail: n,
    });
    _aliasLookup = aliasLookupFrom(pairs);
    _aliasLookupNs = ns;
    console.log('[identity] alias remembered:', o, '→', n);
  } catch (e) { /* словарь недоступен — ренейм основными путями работает */ }
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