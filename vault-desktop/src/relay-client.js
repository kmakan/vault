// Relay-клиент (M2.1/M2.2): дублирование отправки на push-релей + приём.
// Дизайн: docs/design/relay-protocol.md. Релей НЕ заменяет почту —
// дублирует: email-письмо уходит всегда, relay-конверт ускоряет доставку.
// Любая ошибка релея тихо игнорируется (email-путь источник истины).
//
// МОДЕЛЬ РЕЛЕЕВ (M2.2):
//  - список релеев с фолбэком: пользователь добавляет свои/community-релеи
//    (для распределённой соцсети: релеи находит сам, любой может
//    перестать работать — клиент авто-переключается на следующий);
//  - наш релей — первый в списке по умолчанию (Premium-инфраструктура);
//  - токены выдаёт ВЛАДЕЛЕЦ релея; у каждого релея свой myToken и
//    peer-токены (смена релея = новые токены).

import { invoke } from '@tauri-apps/api/core';
import { accountNamespace } from './identity.js';
import { channelTokens } from './channels-tokens.js';

// Наш релей (прод). Первый в списке, но НЕ единственный.
//
// СБОРКА: адрес переопределяется переменной окружения VITE_RELAY_URL на этапе
// сборки фронтенда (vite сам подставляет import.meta.env.VITE_*). Нужно для
// стендов: локальный релей на http:// — plain-text, и чтобы не патчить
// исходник при каждом тесте. БЕЗ переменной значение = прод, поэтому
// production-сборка ведёт себя ровно как раньше.
//
//   VITE_RELAY_URL=http://192.168.1.4:36639/relay npm run build
//
// Пустое/пропущенное значение → прод (защита от «переменная set, но пустая»).
const BUILD_RELAY_URL = ((import.meta && import.meta.env && import.meta.env.VITE_RELAY_URL) || '').trim();
export const DEFAULT_RELAY_URL = BUILD_RELAY_URL || 'https://vault-msg.ru/relay';
const PUB_TIMEOUT_MS = 8000;
const POLL_TIMEOUT_MS = 10000;
// kv-ключи (per-account) для настроек relay.
const KV_MY_READ_TOKEN = 'relay-read-token';
const KV_PEERS = 'relay-peer-tokens'; // { relayUrl: { chatId(lower): token } }
const KV_ENABLED = 'relay-enabled';
const KV_RELAYS = 'relay-list'; // JSON: [{url, myToken, label}] — порядок = приоритет
const KV_ACTIVE = 'relay-active'; // индекс активного релея в списке (auto-managed)
// Состояние Pro на клиенте: { plan, paid_until, checkout_id } — последнее
// подтверждённое сервером состояние подписки (ADR: paid-tokens-spec §5.2).
const KV_PRO = 'relay-pro-state';
const KV_LIMIT_DAY = 'relay-limit-day'; // UTC-день исчерпания лимита (тихий фолбэк)

// S3: ntfy-пуш звонка = ЗВУК ИЗ НАСТРОЕК приложения. Сервер играл один
// жёстко прописанный mp3 для всех; теперь клиент отдаёт свой URL (тот же
// выбор, что и локальный рингтон: Настройки → Звонки → «входящий», kv
// 'anon'/'call-ringtone-incoming'), сервер хранит его per-topic и ставит
// в Audio-заголовок ntfy-пуша. Пути mp3 лежат на сервере в /sounds/.
const RING_URLS = {
  incoming: 'https://vault-msg.ru/sounds/ring_incoming.mp3',
  incoming_classic: 'https://vault-msg.ru/sounds/ring_incoming_classic.mp3',
  incoming_pulse: 'https://vault-msg.ru/sounds/ring_incoming_pulse.mp3',
};

// Рингтон входящего звонка из настроек (S3) — URL для релея. account в
// сигнатуре для единообразия с остальными kv-хелперами, но настройка
// глобальная (leaves in 'anon'). Ошибка чтения = дефолт: релей должен
// всегда получать валидный URL, иначе звонок вернётся к серверному дефолту.
export async function preferredRingtoneUrl(account) {
  account = await accountNamespace(account);
  const name = await invoke('db_kv_get', { account: 'anon', key: 'call-ringtone-incoming' })
    .catch(() => null);
  return RING_URLS[name] || RING_URLS.incoming;
}

// 0.1.186: in-memory mirror of peer tokens. handleCallSignal (calls.js)
// seeds it SYNCHRONOUSLY on call-signal receipt; relayPublish prefers it
// over the kv lookup. Removes the race: user rejects before the
// fire-and-forget kv write finishes → publish used to lose the peer token
// and the reject fell to email fallback (30-60s); now it goes via relay (~1s).
const memPeers = new Map(); // key: <normalizedUrl>::<chatId lowercase> → token
export function memLearn(relayUrl, chatId, token) {
  const base = normalizeRelayUrl(relayUrl);
  const key = (base || String(relayUrl)) + '::' + String(chatId).toLowerCase();
  if (token) memPeers.set(key, token);
  else memPeers.delete(key);
}

let http = null;
try {
  // Tauri http-плагин: обходит CORS WebView (запрос идёт из Rust).
  http = (await import('@tauri-apps/plugin-http')).fetch;
} catch (e) { /* фолбэк на window.fetch (desktop dev) */ }

async function rfetch(url, opts = {}) {
  if (http) return http(url, opts);
  return fetch(url, opts);
}

function authHeader(token) {
  return { 'Authorization': 'VaultRelay ' + token };
}

export function normalizeRelayUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(u)) return null; // только https
  return u;
}

// ───────────────────────── Список релеев ─────────────────────────

// Список релеев: [{url, myToken, label}] — наш всегда первый (можно удалить).
export async function getRelays(account) {
  account = await accountNamespace(account);
  const raw = await invoke('db_kv_get', { account, key: KV_RELAYS }).catch(() => null);
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  // our relay by default
  let added = false;
  if (!list.some(r => r.url === DEFAULT_RELAY_URL)) {
    const legacyToken = await invoke('db_kv_get', { account, key: KV_MY_READ_TOKEN }).catch(() => null);
    list.unshift({ url: DEFAULT_RELAY_URL, myToken: legacyToken || '', label: 'Vault' });
    added = true;
  }
  // авто-миграция (один раз): legacy peer-токены {chatId: token} →
  // per-relay формат {relayUrl: {chatId: token}} на наш релей. Без этого
  // после апгрейда relayPublish не находил токены и дубль молча пропадал.
  try {
    const peersRaw = await invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null);
    if (peersRaw) {
      const peers = JSON.parse(peersRaw);
      if (peers && typeof peers === 'object') {
        const legacy = Object.entries(peers).filter(([, v]) => typeof v === 'string');
        if (legacy.length) {
          const next = {};
          for (const [k, v] of Object.entries(peers)) if (typeof v !== 'string') next[k] = v;
          next[DEFAULT_RELAY_URL] = {};
          for (const [chat, tok] of legacy) next[DEFAULT_RELAY_URL][chat.toLowerCase()] = tok;
          await invoke('db_kv_set', { account, key: KV_PEERS, value: JSON.stringify(next) });
        }
      }
    }
  } catch (e) { /* миграция опциональна */ }
  if (added) await saveRelays(account, list);
  return list.filter(r => r.url && normalizeRelayUrl(r.url));
}

export async function saveRelays(account, list) {
  account = await accountNamespace(account);
  await invoke('db_kv_set', { account, key: KV_RELAYS,
    value: JSON.stringify((list || []).filter(r => r.url && normalizeRelayUrl(r.url))) });
}

export async function addRelay(account, url, myToken, label) {
  account = await accountNamespace(account);
  const u = normalizeRelayUrl(url);
  if (!u) throw new Error('https:// URL required');
  const list = await getRelays(account);
  const ex = list.find(r => r.url === u);
  if (ex) { ex.myToken = myToken || ex.myToken || ''; ex.label = label || ex.label; }
  else list.push({ url: u, myToken: myToken || '', label: label || '' });
  await saveRelays(account, list);
  return list;
}

export async function removeRelay(account, url) {
  account = await accountNamespace(account);
  const list = (await getRelays(account)).filter(r => r.url !== url);
  await saveRelays(account, list);
  return list;
}

// ───────────────────────── Настройки (kv) ─────────────────────────

export async function getSettings(account) {
  account = await accountNamespace(account);
  const [kvEnabled, peersRaw, activeRaw] = await Promise.all([
    invoke('db_kv_get', { account, key: KV_ENABLED }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_ACTIVE }).catch(() => null),
  ]);
  let peers = {};
  try { peers = peersRaw ? JSON.parse(peersRaw) : {}; } catch (e) { peers = {}; }
  const relays = await getRelays(account);
  let active = parseInt(activeRaw || '0', 10) || 0;
  if (active < 0 || active >= relays.length) active = 0;
  // 0.1.180: ДЕФОЛТ — релей ВКЛЮЧЁН (лимитированный free-токен 100/день,
  // БЕЗ промо-ключа), чтобы свежая установка работала через релей + ntfy
  // (эко-режим, без foreground-службы) и не жгла батарею. Токен сам
  // регистрируется при первом health/poll/publish (ensureOurRelayToken).
  // Явный выбор юзера (KV '0') навсегда уважается → служба (классика).
  // KV null (никогда не задавался) → дефолт ВКЛ.
  const enabled = kvEnabled === null ? true : (kvEnabled === '1');
  return { enabled, relays, active, peers };
}

export async function setEnabled(account, on) {
  account = await accountNamespace(account);
  await invoke('db_kv_set', { account, key: KV_ENABLED, value: on ? '1' : '0' });
}

// ───────────────────────── Fingerprint (анти-шаринг токена) ─────────────────────────
// fp = отпечаток публичного ключа аккаунта (короткий, не секретен): один
// токен = один аккаунт. Сервер привязывает токен к первому fp, чужой → 403.

// Кэш: fp читается лениво, один раз на сессию (крипто-команда не дешёвая).
let cachedFp = null;
let cachedFpAccount = null;

// Fingerprint-кеш по public_key (пира) -> fp (аналог myFingerprint, но для чужих ключей)
const fpByPublicKey = new Map(); // module-level cache for fingerprintOf

export async function myFingerprint(account) {
  account = await accountNamespace(account);
  if (cachedFp && cachedFpAccount === account) return cachedFp;
  try {
    const crypto = await import('./crypto.js');
    const fp = await crypto.default.fingerprint();
    cachedFp = fp;
    cachedFpAccount = account;
    return fp;
  } catch (e) {
    console.log('[relay] fingerprint unavailable:', e && e.message || e);
    return null;
  }
}

// Отпечаток ПИРА по его public_key (не наш fp — свой уже есть в myFingerprint).
export async function fingerprintOf(publicKey) {
  if (!publicKey) return null;
  if (fpByPublicKey.has(publicKey)) return fpByPublicKey.get(publicKey);
  try {
    const fp = await invoke('get_fingerprint', { publicKey });
    if (fp) {
      fpByPublicKey.set(publicKey, fp);
    }
    return fp;
  } catch (e) {
    console.log('[relay] fingerprintOf error:', e && e.message || e);
    return null;
  }
}

// Токены собеседников: { relayUrl: { chatId: token } } — на КАЖДЫЙ релей свой набор.
export async function setPeerToken(account, relayUrl, chatId, token, peerFp) {
  account = await accountNamespace(account);
  const raw = await invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null);
  let peers = {};
  try { peers = raw ? JSON.parse(raw) : {}; } catch (e) { peers = {}; }
  const key = normalizeRelayUrl(relayUrl);
  if (!key) return;
  if (!peers[key]) peers[key] = {};
  const lowerChatId = String(chatId).toLowerCase();
  
  // Always write email key (legacy compatibility)
  if (token) peers[key][lowerChatId] = token;
  else delete peers[key][lowerChatId];
  
  // Also write fp key if peerFp provided and token is not empty
  if (peerFp && token) {
    const fpKey = 'fp:' + peerFp;
    peers[key][fpKey] = token;
  } else if (peerFp && !token) {
    // If token is null (deletion), also remove fp key
    const fpKey = 'fp:' + peerFp;
    delete peers[key][fpKey];
  }
  
  try {
    await invoke('db_kv_set', { account, key: KV_PEERS, value: JSON.stringify(peers) });
  } catch (e) {
    // Раньше write падал молча (вызывающий код глотал catch) — на стенде
    // это выглядело как «токен так и не выучился». Логируем явно.
    console.log('[relay] peer token SAVE FAILED', chatId, ':', e && e.message || e);
    throw e;
  }
  memLearn(relayUrl, chatId, token || '');
}

// Диагностика отправки: известен ли адрес relay-очереди собеседника.
// Проверяем ВСЕ релеи списка + оперативный mirror (memPeers) — тем же
// источником, что и relayPublish, чтобы лог не врал.
export async function hasPeerToken(account, chatId, peerFp) {
  try {
    account = await accountNamespace(account);
    const { relays, peers } = await getSettings(account);
    const id = String(chatId || '').toLowerCase();
    for (const r of relays || []) {
      const mem = memPeers.get((normalizeRelayUrl(r.url) || r.url) + '::' + id);
      if (mem) return true;
      
      // Check fp key first if peerFp provided
      if (peerFp) {
        const fpKey = 'fp:' + peerFp;
        if (((peers || {})[r.url] || {})[fpKey]) return true;
      }
      
      // Then check legacy email key
      if (((peers || {})[r.url] || {})[id]) return true;
    }
    return false;
  } catch (e) { return false; }
}

// Миграция M2.1 → M2.2: плоские peer-токены переносятся на активный релей.
export async function migrateLegacyPeers(account, relayUrl) {
  account = await accountNamespace(account);
  const raw = await invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null);
  if (!raw) return;
  let peers;
  try { peers = JSON.parse(raw); } catch (e) { return; }
  // старый формат: { chatId: token } (значения — строки)
  const entries = Object.entries(peers);
  const legacy = entries.filter(([, v]) => typeof v === 'string');
  if (!legacy.length) return;
  const key = normalizeRelayUrl(relayUrl);
  if (!key) return;
  const next = {};
  for (const [k, v] of entries) if (typeof v !== 'string') next[k] = v;
  next[key] = {};
  for (const [chat, tok] of legacy) next[key][chat.toLowerCase()] = tok;
  await invoke('db_kv_set', { account, key: KV_PEERS, value: JSON.stringify(next) });
}

// ───────────────────────── Health / переключение ─────────────────────────

// Живость конкретного релея.
export async function relayHealthUrl(url) {
  try {
    const res = await rfetch(normalizeRelayUrl(url) + '/health', { connectTimeout: 5000 });
    return res.ok;
  } catch (e) { return false; }
}

// Активный релей с авто-фолбэком: если текущий мёртв — пробуем следующий
// по кругу, первый живой становится активным (и персистим его).
export async function pickLiveRelay(account) {
  account = await accountNamespace(account);
  const { enabled, relays, active } = await getSettings(account);
  if (!enabled || !relays.length) return null;
  if (await relayHealthUrl(relays[active].url)) return relays[active];
  for (let i = 0; i < relays.length; i++) {
    const r = relays[i];
    if (await relayHealthUrl(r.url)) {
      await invoke('db_kv_set', { account, key: KV_ACTIVE, value: String(i) });
      console.log('[relay] fallback →', r.url);
      return r;
    }
  }
  return null;
}

// ───────────────────────── Publish (отправка) ─────────────────────────

// Сериализация publish: не даём двум сообщениям одновременно
// создавать два параллельных запроса (порядок доставки важнее скорости).
let pubChain = Promise.resolve();

// Групповая отправка: дублируем конверт на релей КАЖДОМУ участнику,
// чей peer-токен известен (relayPublish внутри по одному на адрес).
// Пейсинг >0.11с между pub'ами: сервер релея ограничивает 10 rps
// по адресату (§5.4) и считает суточный лимит издателя на каждый pub —
// подряд идущие запросы отклонялись как rate limit.
// memberFps: { email(lower): fingerprint } — не обязателен. Приходит из
// GroupMember.fingerprint (Rust уже отдаёт 128-hex, стабильный при смене
// почты). Нужен, чтобы групповая отправка тоже шла по fp-ключу, а не по
// email: иначе переименование участника группы снова роняет relay-дубль
// в почту (30–60 с вместо ~1–2 с).
export async function relayGroupPublish(account, memberEmails, envelopeObj, encryptedBody, memberFps) {
  account = await accountNamespace(account);
  const { enabled } = await getSettings(account);
  if (!enabled) return;
  const fps = memberFps || {};
  for (const member of memberEmails) {
    try {
      await relayPublish(account, member, envelopeObj, encryptedBody,
        { peerFp: fps[String(member).toLowerCase()] || null });
    } catch (e) { /* релей опционален — почта доставит */ }
    await new Promise(r => setTimeout(r, 120));
  }
}

// opts.wake (default true): нужно ли будить получателя ntfy-пушем.
// call-сигналы НЕ-request (accept/answer/end/reject) шлют wake=false —
// получатель уже в приложении на звонке, лишний ntfy-пуш приходил
// ПОСЛЕ принятия звонка и после завершения (жалоба «два уведомления»).
export function relayPublish(account, chatId, envelopeObj, encryptedBody, opts = {}) {
  const job = async () => {
    try {
      // `from` — WIRE-поле конверта: его читает ПИР (incoming.js:
      // senderEmail(m.from) → peerKeys[from]). Там нужен АДРЕС, а не
      // namespace аккаунта. Регресс 25dd18a: строка `account = await
      // accountNamespace(account)` стояла выше и переписывала `account`
      // на `fp:<…>` — и `from: account` уезжал в сеть отпечатком.
      // Пир такого адреса не знает → peerKeys[from] пуст → конверт
      // (в т.ч. call_request) МОЛЧА отбрасывался. Возвращаем `from`
      // в почту ДО нормализации; account-scoped операции ниже, как и было.
      const fromEmail = String(account || '').trim().toLowerCase();
      account = await accountNamespace(account);
      const { enabled, peers, active, relays } = await getSettings(account);
      if (!enabled) { console.log('[relay] publish skip: disabled'); return { ok: false, why: 'disabled' }; }
      // Бесконечная регистрация: при пустом myToken pickLiveRelay не найдёт
      // живого релея (health-чек идёт только по url, но publish без токена
      // всё равно не отправится). Регистрируем токен заранее.
      await ensureOurRelayToken(account);
      // Тихий фолбэк при исчерпании суточного лимита (§0): до конца
      // UTC-дня pub не дёргаем вовсе, письмо — единственный путь.
      const limitDay = await invoke('db_kv_get', { account, key: KV_LIMIT_DAY }).catch(() => null);
      const today = Math.floor(Date.now() / 86400000);
      if (limitDay && parseInt(limitDay, 10) === today) {
        return { ok: false, why: 'daily-limit' };
      }
      const relay = await pickLiveRelay(account);
      if (!relay) { console.log('[relay] publish skip: no-live-relay'); return { ok: false, why: 'no-live-relay' }; }
      const relayPeers = peers[relay.url] || {};
      const memKey = (normalizeRelayUrl(relay.url) || relay.url) + '::' + String(chatId).toLowerCase();
      
      // New lookup order with fingerprint support
      let to = null;
      const peerFp = opts.peerFp || null;
      
      // 1. Check fp key first if peerFp provided
      if (peerFp) {
        const fpKey = 'fp:' + peerFp;
        to = relayPeers[fpKey];
        if (to) {
          console.log('[relay] publish using fp-key:', peerFp, 'for', chatId);
        }
      }
      
      // 2. Check memPeers (in-memory cache)
      if (!to) {
        to = memPeers.get(memKey);
      }
      
      // 3. Check legacy email key
      let viaEmail = false;
      if (!to) {
        to = relayPeers[String(chatId).toLowerCase()];
        if (to) viaEmail = true;
      }
      
      // 4. Promotion: token найден по email, а fp-ключа нет → создаём его.
      // Именно этот путь чинит смену почты пира: первый же publish после
      // переименования «научит» слой его новому fp, и дальше lookup идёт по fp.
      // ВАЖНО: условие — «нашли по email И fp-ключа нет», а НЕ «to пусто»:
      // при `!to` этот блок недостижим (шаг 3 уже заполнил to или оставил пустым).
      if (viaEmail && peerFp) {
        const fpKey = 'fp:' + peerFp;
        if (!relayPeers[fpKey]) {
          // fire-and-forget: не блокируем отправку записью в kv
          setPeerToken(account, relay.url, chatId, to, peerFp).catch(() => {});
          console.log('[relay] promoting email token to fp-key:', peerFp, 'for', chatId);
        }
      }
      
      if (!to) { console.log('[relay] publish skip: no-peer-token for', chatId, 'keys:', Object.keys(relayPeers)); return { ok: false, why: 'no-peer-token' }; }
      const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
      const res = await rfetch(relay.url + '/pub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          to,
          id: envelopeObj.id || ('rl-' + Date.now()),
          exp,
          body: btoa(unescape(encodeURIComponent(encryptedBody))),
          from: fromEmail,
          // M2.4 автообмен: мой read-токен (адрес моей очереди) — получатель
          // запомнит и сможет слать мне пуши. Пользователь ничего не вводит.
          tok: relay.myToken || '',
          // §0/анти-шаринг: отпечаток моего ключа — сервер привязывает
          // токен к аккаунту, чужой fp с этим токеном → 403.
          fp: (await myFingerprint(account)) || undefined,
          // ntfy wake-up нужен не всегда (call-сигналы после request — нет).
          wake: opts.wake === false ? false : true,
          // Приоритет (звонок): сервер обходит last_seen-гейт —
          // «только что закрыл приложение» ≠ «жив» (гейт 90с гасил
          // вайк в первые 90с после закрытия → S3: звонок не доходит).
          urgent: opts.urgent === true,
        }),
        connectTimeout: PUB_TIMEOUT_MS,
      });
      if (res.status === 429) {
        // Лимит исчерпан: тихо уходим на почту до конца UTC-дня, баннер
        // покажет App.vue (relayOnLimitReply hook ниже), письмо уже ушло.
        await invoke('db_kv_set', { account, key: KV_LIMIT_DAY, value: String(today) }).catch(() => {});
        console.log('[relay] daily limit hit → email-only until next UTC day');
        return { ok: false, why: 'daily-limit' };
      }
      if (res.status === 403) {
        // Токен привязан к другому аккаунту (скопирован). На нашем релее —
        // тихая авто-перерегистрация: получим свежий токен, привязанный
        // к этому fp. Сторонний релей — уведомим пользователя.
        if (relay.url === DEFAULT_RELAY_URL) {
          const fresh = await reRegisterOurRelay(account);
          if (fresh) return relayPublish(account, chatId, envelopeObj, encryptedBody);
        }
        return { ok: false, why: 'token-bound-elsewhere' };
      }
      if (!res.ok) { console.log('[relay] publish http', res.status); return { ok: false, why: 'http-' + res.status }; }
      console.log('[relay] published to', chatId);
      return { ok: true };
    } catch (e) {
      console.log('[relay] publish error:', e && e.message || e);
      return { ok: false, why: (e && e.message) || 'error' };
    }
  };
  pubChain = pubChain.then(job, job);
  return pubChain;
}

// Тихая перерегистрация на нашем релее (после 403 или для продления):
// выдаёт свежий read-токен, привязанный к текущему fp, и обновляет
// kv-список. Возвращает true при успехе.
//
// t_b8f44bdf: вместе с fp отправляем УЖЕ имеющийся токен как `keep`. Сервер
// записывает связку fp → токен и возвращает ТОТ ЖЕ токен (адрес очереди не
// меняется). Нужно устройствам, получившим токен до появления карты fp:
// без заявки при протухании/перерегистрации адрес сменился бы ЕЩЁ РАЗ.
// Токена нет (чистая установка) → сервер выдаёт новый, как раньше.
export async function reRegisterOurRelay(account) {
  try {
    account = await accountNamespace(account);
    const fp = await myFingerprint(account);
    const before = await getSettings(account);
    const ours = before.relays.find(x => x.url === DEFAULT_RELAY_URL);
    const keep = (ours && ours.myToken) || '';
    const r = await rfetch(DEFAULT_RELAY_URL + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // S3: заодно отдаём серверу рингтон входящего звонка из настроек —
      // ntfy-пуш звонка играет именно его (per-topic на нашем токене).
      body: JSON.stringify({
        fp: fp || '',
        ...(keep ? { keep } : {}),
        ringtone: await preferredRingtoneUrl(account),
      }),
      connectTimeout: PUB_TIMEOUT_MS,
    });
    if (!r.ok) { console.log('[relay] re-register http', r.status); return false; }
    const d = await r.json();
    const rs = await getSettings(account);
    const list = rs.relays.filter(x => x.url !== DEFAULT_RELAY_URL);
    list.unshift({ url: DEFAULT_RELAY_URL, myToken: d.token, label: 'Vault' });
    await saveRelays(account, list);
    if (keep && d.token === keep) {
      console.log('[relay] token kept (queue address stable)');
    } else {
      console.log('[relay] token re-registered (bound to this account)');
    }
    return true;
  } catch (e) {
    console.log('[relay] re-register error:', e && e.message || e);
    return false;
  }
}

// ───────────────────────── Poll (приём) ─────────────────────────

// Опрос ВСЕХ живых релеев (каждый держит свою очередь): объединяем конверты.
// Дедуп по id в relayConsume (App.vue).
export async function relayPoll(account) {
  try {
    account = await accountNamespace(account);
    const { enabled, relays } = await getSettings(account);
    if (!enabled || !relays.length) return [];
    // Бесконечная регистрация: при пустом myToken наш релей не дойдёт до
    // HTTP (фильтр ниже его отбросит) — зарегистрируем токен заранее.
    if (enabled) await ensureOurRelayToken(account);
    const fp = await myFingerprint(account);
    const results = await Promise.all(relays.filter(r => r.myToken).map(async (r) => {
      try {
        const res = await rfetch(r.url + '/poll?wait=0', {
          method: 'GET',
          headers: { ...authHeader(r.myToken), 'X-Vault-Fp': fp || '' },
          connectTimeout: POLL_TIMEOUT_MS,
        });
        if (res.status === 204 || res.status === 402) {
          // 402 = подписка истекла: на нашем релее тихо перерегистрируемся
          // (выдача бесплатна) — иначе эко-режим теряет канал приёма.
          if (res.status === 402 && r.url === DEFAULT_RELAY_URL) {
            await reRegisterOurRelay(account).catch(() => {});
          }
          return [];
        }
        if (res.status === 403) {
          // Токен привязан к чужому аккаунту: на нашем релее тихо
          // перерегистрируемся (свежий токен = свежая привязка к этому fp).
          if (r.url === DEFAULT_RELAY_URL && await reRegisterOurRelay(account)) return [];
          console.log('[relay] poll 403: token bound to another account');
          return [];
        }
        if (!res.ok) return [];
        const list = await res.json();
        for (const env of list) {
          env._relay = r.url; // источник (не обязателен, полезен для отладки)
          try {
            env.body = decodeURIComponent(escape(atob(env.body)));
          } catch (e) { /* оставим как есть */ }
        }
        return list;
      } catch (e) { return []; }
    }));
    return results.flat();
  } catch (e) {
    return [];
  }
}

// FCM (Part B, Android): нативный мост window.VaultFcm (MainActivity.kt) сам
// шлёт POST <relay>/fcm/register со своим FCM reg_token. Креды релея лежат в
// kv, нативному слою недоступны — отдаём их один раз за загрузку WebView.
// В desktop/браузере моста нет → тихий false; FCM — дополнение, основной путь
// доставки (релей+ntfy) от него не зависит.
export async function registerNativeFcm(relayUrl, readToken, fp) {
  try {
    const bridge = window.VaultFcm;
    if (!bridge || !bridge.register) return false;
    bridge.register(String(relayUrl || ''), String(readToken || ''), String(fp || ''));
    return true;
  } catch (e) { return false; }
}

// Аккаунт, для которого мост уже получил креды (одна регистрация на WebView:
// нативный слой сам кэширует reg_token+url в prefs и перерегистрируется при
// следующем создании WebView). Смена аккаунта в той же сессии → регистрация
// заново, иначе пуши ушли бы в очередь прежнего владельца токена.
let nativeFcmAccount = null;

// Бесконечная регистрация: на нашем релее токен выдаётся бесплатно и
// автоматически. Если myToken пуст (чистая установка / миграция kv),
// опрос и publish вообще не доходят до HTTP — фильтр relays.filter(r =>
// r.myToken) отбрасывает релей ДО запроса, поэтому 403-авторегистрация
// никогда не сработает. Регистрируем заранее, молча.
//
// t_b8f44bdf: если токен УЖЕ есть — один раз за запуск «заявляем» его
// (`keep`): сервер запишет связку fp → токен ДО протухания, и адрес очереди
// не сменится. Идемпотентно, IP-квоту не тратит.
const claimedAccounts = new Set();
export async function claimOurRelayToken(account) {
  account = await accountNamespace(account);
  if (claimedAccounts.has(account)) return false;
  claimedAccounts.add(account);
  const { relays } = await getSettings(account);
  const ours = relays.find(r => r.url === DEFAULT_RELAY_URL);
  if (!ours || !ours.myToken) return false; // заявлять нечего
  return reRegisterOurRelay(account);
}

export async function ensureOurRelayToken(account) {
  try {
    account = await accountNamespace(account);
    let { relays } = await getSettings(account);
    let ours = relays.find(r => r.url === DEFAULT_RELAY_URL);
    if (!ours || !ours.myToken) {
      if (!await reRegisterOurRelay(account)) return false;
      // Свежий токен уже в kv — перечитываем, чтобы отдать мосту актуальный.
      ({ relays } = await getSettings(account));
      ours = relays.find(r => r.url === DEFAULT_RELAY_URL);
    } else if (!claimedAccounts.has(account)) {
      // Токен есть → заявляем его фоном (не задерживаем poll/publish).
      claimOurRelayToken(account).catch(() => {});
    }
    if (ours && ours.myToken && nativeFcmAccount !== account) {
      nativeFcmAccount = account; // до await: publish+poll идут параллельно
      registerNativeFcm(ours.url, ours.myToken, await myFingerprint(account)).catch(() => {});
    }
    return !!(ours && ours.myToken);
  } catch (e) { return false; }
}

// Живость активного релея (кнопка «проверить» в настройках).
export async function relayHealth(account) {
  account = await accountNamespace(account);
  await ensureOurRelayToken(account);
  const { relays, active } = await getSettings(account);
  if (!relays.length) return false;
  return relayHealthUrl(relays[active].url);
}

export function isRelayEnvelope(obj) {
  return obj && typeof obj === 'object' && obj.body && obj.id && obj.ts;
}

// ───────────────────────── Каналы (M2 channels-3) ─────────────────────────
// Channel delivery is fan-out: ONE pub into the channel queue, every
// subscriber reads the same queue (peek with a `since` cursor on the server,
// design channels §4.1). Tokens are derived from the broadcast key client-side
// (channels-tokens.js::channelTokens — примитив, не фича: транспорт не должен
// зависеть от features/*) — the server never sees the key, possession of the
// token IS the authorization.
const KV_CHAN_CURSOR = 'relay-channel-cursor'; // {relayUrl: {chId: ts}}

// ADR-002: key_id канала = первые 8 байт канального read-токена, читаем
// BE. Возвращаем HEX-СТРОКУ: key_id — это u64, а JSON-число после 2^53
// теряет точность, и молча подменённый kid означал бы подпись не того канала.
// В релее kid выводится сервером из самого токена, поэтому расхождение
// исключено по построению (ADR-002 §4).
function kidHexOfToken(tok) {
  const b64 = String(tok || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  let hex = '';
  for (let i = 0; i < 8; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}

// ADR-002: регистрация публичного ключа подписи канала на релее. Вызывается
// один раз на (релей, kid) за сессию; релей идемпотентен при повторе с тем же
// ключом. Регистрация ПРИНИМАЕТСЯ ТОЛЬКО с личным токеном владельца (read или
// write): иначе сервер не отличит владельца от подписчика (broadcast-ключ
// у них общий). Шлём канальный read-токен ЦЕЛИКОМ: kid сервер выводит сам из
// токена — key_id это u64, а JSON-число после 2^53 теряет точность, так что
// отдельным полем kid слать нельзя (молча подменённый kid привязал бы ключ
// не к тому каналу).
const _chanKeyRegistered = new Set();
async function ensureChannelKeyRegistered(relay, token) {
  const kidHex = kidHexOfToken(token);
  const mark = relay.url + '::' + kidHex;
  if (_chanKeyRegistered.has(mark)) return;
  if (!relay.myToken) {
    console.warn('[channels] нет личного токена — ключ подписи не зарегистрирован');
    return;
  }
  const pubkey = await invoke('channel_signing_key');
  const res = await rfetch(relay.url + '/channel-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(relay.myToken) },
    body: JSON.stringify({ token, pubkey }),
  });
  // rfetch возвращает fetch-Response (ok/status/json), а не {ok, why}:
  // успех = HTTP 2xx, иначе читаем тело для диагностики.
  if (!res || res.ok !== true) {
    let detail = '';
    try {
      const st = res ? res.status : 'no-response';
      let bodyTxt = '';
      try { bodyTxt = res ? await res.text() : ''; } catch (e) { /* пусто */ }
      detail = 'http ' + st + (bodyTxt ? ' ' + bodyTxt.slice(0, 200) : '');
    } catch (e) { detail = (e && e.message) || 'error'; }
    // Канал остаётся в v1: публикация уйдёт без подписи, релей её примет.
    console.warn('[channels] регистрация ключа подписи не удалась:', detail);
    return;
  }
  _chanKeyRegistered.add(mark);
}

export async function relayChannelPublish(ch, envelopeObj, encryptedBody, account) {
  const job = async () => {
    try {
      account = await accountNamespace(account);
      if (!ch || !ch.key) return { ok: false, why: 'no-key' };
      const { enabled, relays, active } = await getSettings(account);
      if (!enabled) return { ok: false, why: 'disabled' };
      const relay = await pickLiveRelay(account);
      if (!relay) return { ok: false, why: 'no-live-relay' };
      const { read, write } = await channelTokens(ch.key);
      const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
      const id = envelopeObj.id || ('ch-' + Date.now());
      const body = btoa(unescape(encodeURIComponent(encryptedBody)));
      // ADR-002: подпись конверта. Подписывается РОВНО та строка body, что
      // уйдёт в JSON — иначе релей посчитает другую подпись и отклонит пост.
      let sig = null;
      try {
        await ensureChannelKeyRegistered(relay, read);
        sig = await invoke('channel_sign_post', { kidHex: kidHexOfToken(read), envId: id, body });
      } catch (e) {
        // Не подписываем — публикация уйдёт в v1 и релей её примет. Лучше
        // пост без подписи, чем потерянный пост: включать REQUIRE_SIG можно
        // только когда подпись реально есть.
        console.warn('[channels] подпись не получена, публикация без неё:', e && e.message || e);
      }
      const res = await rfetch(relay.url + '/pub', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(write), // write-токен канала = право publish
        },
        body: JSON.stringify({
          v: 1,
          to: read, // адрес общей очереди канала
          id,
          exp,
          body,
          sig, // ADR-002: null для личных/старых сборок, base64url для канала
          wake: false, // пушей на канал нет (общая очередь)
        }),
        connectTimeout: PUB_TIMEOUT_MS,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch (e) { /* тело недоступно — не критично */ }
        console.log('[relay-chan] publish http', res.status, detail);
        if (res.status === 403) {
          // Отказ именно по подписи — наш ключ на релее больше не тот
          // (состояние релея сбросили, канал вернулся в v1) либо канал занял
          // другой claimant (§7 ADR-002). В обоих случаях наша пометка
          // «зарегистрирован» протухла. Сбрасываем её: иначе клиент больше
          // никогда не попробует зарегистрироваться и канал навсегда остался
          // бы в v1 — дыра открылась бы молча, без единого признака.
          _chanKeyRegistered.delete(relay.url + '::' + kidHexOfToken(read));
          return { ok: false, why: 'signature-rejected' };
        }
        return { ok: false, why: 'http-' + res.status };
      }
      console.log('[relay-chan] published to', ch.id);
      return { ok: true };
    } catch (e) {
      console.log('[relay-chan] publish error:', e && e.message || e);
      return { ok: false, why: (e && e.message) || 'error' };
    }
  };
  pubChain = pubChain.then(job, job);
  return pubChain;
}

// Подписка на посты канала: пуллим ОДИН канал его read-токеном с курсором
// `since` (последний виденный ts). Возвращает конверты; дедуп по id на
// клиенте в relayConsume (uid 'rl-<id>') делает повторную отдачу безвредной,
// курсор лишь экономит трафик. Вызывается из relayConsume для каждого канала.
export async function relayChannelPoll(ch, account) {
  try {
    account = await accountNamespace(account);
    if (!ch || !ch.key) return [];
    const { enabled } = await getSettings(account);
    if (!enabled) return [];
    const relay = await pickLiveRelay(account);
    if (!relay) return [];
    const { read } = await channelTokens(ch.key);
    let cursors = {};
    try { cursors = JSON.parse((await invoke('db_kv_get', { account, key: KV_CHAN_CURSOR }).catch(() => null)) || '{}'); } catch (e) { cursors = {}; }
    const since = (cursors[relay.url] && cursors[relay.url][ch.id]) || 0;
    const res = await rfetch(relay.url + `/poll?wait=0&since=${since}`, {
      method: 'GET',
      headers: authHeader(read),
      connectTimeout: POLL_TIMEOUT_MS,
    });
    if (res.status === 204 || !res.ok) return [];
    const list = await res.json();
    if (list.length) {
      const maxTs = list.reduce((m, e) => Math.max(m, e.ts || 0), since);
      cursors[relay.url] = Object.assign({}, cursors[relay.url], { [ch.id]: maxTs });
      await invoke('db_kv_set', { account, key: KV_CHAN_CURSOR, value: JSON.stringify(cursors) }).catch(() => {});
    }
    for (const env of list) {
      env._relay = relay.url;
      try { env.body = decodeURIComponent(escape(atob(env.body))); } catch (e) { /* как есть */ }
    }
    return list;
  } catch (e) {
    return [];
  }
}

// Записать НАШ токен релея (первым в списке — он приоритетный).
// Единственный путь записи платного токена: после успешной оплаты и
// активации. Старый токен (если был) заменяем, а не добавляем вторым:
// два наших токена на одном аккаунте = путаница в привязке и лимитах.
export async function setOurToken(account, url, token) {
  account = await accountNamespace(account);
  const u = normalizeRelayUrl(url) || DEFAULT_RELAY_URL;
  const list = (await getRelays(account)).filter(x => x.url !== u);
  list.unshift({ url: u, myToken: token || '', label: 'Vault' });
  await saveRelays(account, list);
  return list;
}

// ───────────────────────── Платные токены (Pro) ─────────────────────────
//
// Покупка идёт через релей: сервер сам спрашивает платёжного провайдера и
// выпускает v2-токен с планом. Клиент в провайдера не лезет и «оплачено» от
// себя не объявляет.
//
// ОФЛАЙН-ГРЕЙС (§5.3). Релей может быть недоступен (обрыв, сон, туннель), и
// тогда сообщения не ходят вообще — это хуже, чем «Pro по счёту не проверить».
// Поэтому клиент помнит последнее подтверждённое paid_until и доверяет ему
// ещё 7 дней. СЧЁТ ВРЕМЕНИ — не по Date.now() пользователя: часы можно
// перевести назад и продлить себе подписку. Отсчёт — от performance.timeOrigin
// (монотонный счётчик браузера), а серверное время — единственный
// авторитетный источник paid_until.

// Грейс — в СЕКУНДАХ: сервер отдаёт paid_until в unix-секундах, и прибавлять
// миллисекунды к секундам нельзя (7 дней превратились бы в 7 000 дней, и Pro
// считался бы активным годами после оплаты).
const PRO_GRACE_SEC = 7 * 24 * 60 * 60; // 7 дней офлайн-грейса

// Монотонные «часы» клиента — в unix-СЕКУНДАХ.
//
// performance.timeOrigin фиксируется ОДИН РАЗ при загрузке страницы, а
// performance.now() идёт монотонно и не поддаётся переводу системных часов.
// Их сумма — «клиентское время», которое пользователь не может откатить
// назад, переведя часы. Поэтому офлайн-грейс нельзя считать по Date.now():
// перевод часов назад продлил бы грейс до бесконечности.
//
// ЕДИНИЦЫ. Сервер отдаёт paid_until в unix-СЕКУНДАХ, поэтому и здесь
// секунды: timeOrigin и performance.now() — миллисекунды, их сумма делится
// на 1000. Смешение единиц здесь означало бы, что грейс не наступает никогда
// (миллисекунды всегда больше секунд) — то есть Pro считался бы вечным.
function monoNow() {
  try {
    if (typeof performance !== 'undefined' && performance.timeOrigin
        && typeof performance.now === 'function') {
      return Math.floor((performance.timeOrigin + performance.now()) / 1000);
    }
  } catch (e) { /* нет performance — падаем на Date.now() */ }
  return Math.floor(Date.now() / 1000);
}

// Состояние Pro, известное клиенту (без сети): что лежит в KV.
export async function proState(account) {
  account = await accountNamespace(account);
  const raw = await invoke('db_kv_get', { account, key: KV_PRO }).catch(() => null);
  let st = null;
  try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
  if (!st || !st.plan) return { plan: 'free', paid_until: 0, offline: false };
  // Грейс: локально верим до paid_until + 7 дней, но НЕ дольше серверной
  // границы (если сервер её сообщил).
  const now = monoNow();
  const graceEnd = Math.min(
    (st.paid_until || 0) + PRO_GRACE_SEC,
    st.grace_until || Number.MAX_SAFE_INTEGER,
  );
  const offline = now <= graceEnd;
  return {
    plan: offline ? (st.plan || 'pro') : 'free',
    paid_until: st.paid_until || 0,
    checkout_id: st.checkout_id || '',
    offline,
  };
}

// Запомнить подтверждённое сервером состояние (после успешного /tokens/info
// или /purchase/verify).
export async function saveProState(account, state) {
  account = await accountNamespace(account);
  const st = {
    plan: state.plan || 'free',
    paid_until: state.paid_until || 0,
    checkout_id: state.checkout_id || '',
    grace_until: state.grace_until || 0,
    updated_at: Date.now(),
  };
  await invoke('db_kv_set', { account, key: KV_PRO, value: JSON.stringify(st) });
  return st;
}

// GET /relay/tokens/info — состояние подписки и остаток лимитов.
export async function fetchTokenInfo(account, relayUrl) {
  try {
    account = await accountNamespace(account);
    const url = normalizeRelayUrl(relayUrl || DEFAULT_RELAY_URL);
    if (!url) return null;
    const { relays, active } = await getSettings(account);
    const token = (relays[active] && relays[active].myToken) || '';
    if (!token) return null;
    const res = await rfetch(url + '/tokens/info', {
      method: 'GET',
      headers: authHeader(token),
      connectTimeout: 10000,
    });
    if (res.status === 402) {
      // Подписка истекла — это НЕ «релей недоступен»: клиент должен узнать.
      await saveProState(account, { plan: 'free', paid_until: 0 });
      return { expired: true, plan: 'free', paid_until: 0 };
    }
    if (!res.ok) return null;
    const info = await res.json();
    await saveProState(account, {
      plan: info.plan,
      paid_until: info.paid_until,
      grace_until: info.grace_until,
    });
    return info;
  } catch (e) {
    console.log('[relay] tokens/info failed:', e && e.message || e);
    return null;
  }
}

// POST /relay/purchase/checkout — создать платёжную сессию.
export async function purchaseCheckout(account, plan, months) {
  try {
    account = await accountNamespace(account);
    const url = normalizeRelayUrl(DEFAULT_RELAY_URL);
    const fp = await myFingerprint(account);
    if (!url || !fp) return { error: 'no_fp' };
    const res = await rfetch(url + '/purchase/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, months, fp, lang: 'ru' }),
      connectTimeout: 10000,
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      return { error: (body && body.error) || ('http_' + res.status), status: res.status, body };
    }
    return body;
  } catch (e) {
    console.log('[relay] purchase/checkout failed:', e && e.message || e);
    return { error: 'network' };
  }
}

// POST /relay/purchase/verify — подтвердить оплату и получить платный токен.
export async function purchaseVerify(account, checkoutId) {
  try {
    account = await accountNamespace(account);
    const url = normalizeRelayUrl(DEFAULT_RELAY_URL);
    const fp = await myFingerprint(account);
    if (!url || !fp) return { error: 'no_fp' };
    const res = await rfetch(url + '/purchase/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkout_id: checkoutId, fp }),
      connectTimeout: 10000,
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      return { error: (body && body.error) || ('http_' + res.status), status: res.status, body };
    }
    // Токен активируем на этом устройстве и кладём в relay-list — других
    // путей записи токена нет.
    if (body && body.token) {
      const act = await activateToken(account, body.token);
      if (act && act.error) {
        return { error: act.error, status: act.status, body };
      }
      await setOurToken(account, url, body.token);
    }
    await saveProState(account, {
      plan: (body && body.plan) || 'pro',
      paid_until: (body && body.paid_until) || 0,
      checkout_id: checkoutId || '',
    });
    return body || { error: 'empty_body' };
  } catch (e) {
    console.log('[relay] purchase/verify failed:', e && e.message || e);
    return { error: 'network' };
  }
}

// POST /relay/tokens/activate — привязать платный токен к этому устройству.
export async function activateToken(account, token) {
  try {
    account = await accountNamespace(account);
    const url = normalizeRelayUrl(DEFAULT_RELAY_URL);
    const fp = await myFingerprint(account);
    if (!url || !fp) return { error: 'no_fp' };
    const res = await rfetch(url + '/tokens/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, fp }),
      connectTimeout: 10000,
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) return { error: (body && body.error) || ('http_' + res.status), status: res.status, body };
    return body || { bound: true };
  } catch (e) {
    console.log('[relay] tokens/activate failed:', e && e.message || e);
    return { error: 'network' };
  }
}
