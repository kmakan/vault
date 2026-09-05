// Relay-клиент (M2.1): дублирование отправки на push-релей + приём.
// Дизайн: docs/design/relay-protocol.md. Релей НЕ заменяет почту —
// дублирует: email-письмо уходит всегда, relay-конверт ускоряет доставку.
// Любая ошибка релея тихо игнорируется (email-путь источник истины).
//
// МОДЕЛЬ РЕЛЕЕВ (M2.2, монетизация):
//  - «наш» релей (default) — для платных подписок (Premium), включён по умолчанию;
//  - свой/бесплатный релей — пользователь вводит base URL сам (самохостинг,
//    community-релеи, для стран где наш сервер недоступен);
//  - выбор активного релея — поле base URL в настройках; пустое = наш.
// Токены выдаёт ВЛАДЕЛЕЦ выбранного релея (наш CLI / панель Premium),
// клиент только хранит и использует их. У разных релеев ключи разные —
// токен от одного релея на другом невалиден (это норма: меняешь релей —
// получаешь токены заново и обновляешь их у собеседников).

import { invoke } from '@tauri-apps/api/core';

// Наш релей (M2.1, прод). Может быть перекрыт настройкой base URL.
export const DEFAULT_RELAY_URL = 'https://vault-msg.ru/relay';
const PUB_TIMEOUT_MS = 8000;
const POLL_TIMEOUT_MS = 10000;
// kv-ключи (per-account) для настроек relay.
const KV_MY_READ_TOKEN = 'relay-read-token';
const KV_PEERS = 'relay-peer-tokens'; // { chatId(lower): read-token собеседника }
const KV_ENABLED = 'relay-enabled';
const KV_BASE_URL = 'relay-base-url';

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

function normalizeBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return DEFAULT_RELAY_URL;
  if (!/^https:\/\//.test(u)) return DEFAULT_RELAY_URL; // только https
  return u;
}

// ───────────────────────── Настройки (kv) ─────────────────────────

export async function getSettings(account) {
  const [enabled, myToken, peersRaw, baseRaw] = await Promise.all([
    invoke('db_kv_get', { account, key: KV_ENABLED }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_MY_READ_TOKEN }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_BASE_URL }).catch(() => null),
  ]);
  let peers = {};
  try { peers = peersRaw ? JSON.parse(peersRaw) : {}; } catch (e) { peers = {}; }
  return {
    enabled: enabled === '1',
    myToken: myToken || '',
    peers,
    baseUrl: normalizeBase(baseRaw),
    isDefault: !String(baseRaw || '').trim(),
  };
}

export async function setEnabled(account, on) {
  await invoke('db_kv_set', { account, key: KV_ENABLED, value: on ? '1' : '0' });
}

export async function setMyToken(account, token) {
  await invoke('db_kv_set', { account, key: KV_MY_READ_TOKEN, value: (token || '').trim() });
}

export async function setBaseUrl(account, url) {
  await invoke('db_kv_set', { account, key: KV_BASE_URL, value: normalizeBase(url) });
}

export async function setPeerToken(account, chatId, token) {
  const { peers } = await getSettings(account);
  if (token) peers[String(chatId).toLowerCase()] = token;
  else delete peers[String(chatId).toLowerCase()];
  await invoke('db_kv_set', { account, key: KV_PEERS, value: JSON.stringify(peers) });
}

// ───────────────────────── Publish (отправка) ─────────────────────────

// Сериализация publish: не даём двум сообщениям одновременно
// создавать два параллельных запроса (порядок доставки важнее скорости).
let pubChain = Promise.resolve();

export function relayPublish(account, chatId, envelopeObj, encryptedBody) {
  const job = async () => {
    try {
      const { enabled, peers, baseUrl } = await getSettings(account);
      if (!enabled) return { ok: false, why: 'disabled' };
      const to = peers[String(chatId).toLowerCase()];
      if (!to) return { ok: false, why: 'no-peer-token' };
      const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
      const res = await rfetch(baseUrl + '/pub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          to,
          id: envelopeObj.id || ('rl-' + Date.now()),
          exp,
          body: btoa(unescape(encodeURIComponent(encryptedBody))),
          from: account,
        }),
        // Tauri fetch: connect timeout часть опций
        connectTimeout: PUB_TIMEOUT_MS,
      });
      if (!res.ok) return { ok: false, why: 'http-' + res.status };
      return { ok: true };
    } catch (e) {
      return { ok: false, why: (e && e.message) || 'error' };
    }
  };
  pubChain = pubChain.then(job, job);
  return pubChain;
}

// ───────────────────────── Poll (приём) ─────────────────────────

// Опрос собственной очереди: возвращает массив
// [{id, body(decrypted-bytes-b64→строка), from, ts}] или [].
export async function relayPoll(account) {
  try {
    const { enabled, myToken, baseUrl } = await getSettings(account);
    if (!enabled || !myToken) return [];
    const res = await rfetch(baseUrl + '/poll?wait=0', {
      method: 'GET',
      headers: authHeader(myToken),
      connectTimeout: POLL_TIMEOUT_MS,
    });
    if (res.status === 204) return [];
    if (res.status === 402) return []; // подписка истекла — тихо, email живёт
    if (!res.ok) return [];
    const list = await res.json();
    // body приходит base64(строка-конверт) — декодируем в исходную строку.
    for (const env of list) {
      try {
        env.body = decodeURIComponent(escape(atob(env.body)));
      } catch (e) { /* оставим как есть */ }
    }
    return list;
  } catch (e) {
    return [];
  }
}

// Живость релея (кнопка «проверить» в настройках).
export async function relayHealth(account) {
  try {
    const { baseUrl } = await getSettings(account);
    const res = await rfetch(baseUrl + '/health', { connectTimeout: 5000 });
    return res.ok;
  } catch (e) { return false; }
}

export function isRelayEnvelope(obj) {
  return obj && typeof obj === 'object' && obj.body && obj.id && obj.ts;
}
