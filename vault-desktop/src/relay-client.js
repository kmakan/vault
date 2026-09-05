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

// Наш релей (прод). Первый в списке, но НЕ единственный.
export const DEFAULT_RELAY_URL = 'https://vault-msg.ru/relay';
const PUB_TIMEOUT_MS = 8000;
const POLL_TIMEOUT_MS = 10000;
// kv-ключи (per-account) для настроек relay.
const KV_MY_READ_TOKEN = 'relay-read-token';
const KV_PEERS = 'relay-peer-tokens'; // { relayUrl: { chatId(lower): token } }
const KV_ENABLED = 'relay-enabled';
const KV_RELAYS = 'relay-list'; // JSON: [{url, myToken, label}] — порядок = приоритет
const KV_ACTIVE = 'relay-active'; // индекс активного релея в списке (auto-managed)

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
  await invoke('db_kv_set', { account, key: KV_RELAYS,
    value: JSON.stringify((list || []).filter(r => r.url && normalizeRelayUrl(r.url))) });
}

export async function addRelay(account, url, myToken, label) {
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
  const list = (await getRelays(account)).filter(r => r.url !== url);
  await saveRelays(account, list);
  return list;
}

// ───────────────────────── Настройки (kv) ─────────────────────────

export async function getSettings(account) {
  const [enabled, peersRaw, activeRaw] = await Promise.all([
    invoke('db_kv_get', { account, key: KV_ENABLED }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null),
    invoke('db_kv_get', { account, key: KV_ACTIVE }).catch(() => null),
  ]);
  let peers = {};
  try { peers = peersRaw ? JSON.parse(peersRaw) : {}; } catch (e) { peers = {}; }
  const relays = await getRelays(account);
  let active = parseInt(activeRaw || '0', 10) || 0;
  if (active < 0 || active >= relays.length) active = 0;
  return { enabled: enabled === '1', relays, active, peers };
}

export async function setEnabled(account, on) {
  await invoke('db_kv_set', { account, key: KV_ENABLED, value: on ? '1' : '0' });
}

// Токены собеседников: { relayUrl: { chatId: token } } — на КАЖДЫЙ релей свой набор.
export async function setPeerToken(account, relayUrl, chatId, token) {
  const raw = await invoke('db_kv_get', { account, key: KV_PEERS }).catch(() => null);
  let peers = {};
  try { peers = raw ? JSON.parse(raw) : {}; } catch (e) { peers = {}; }
  const key = normalizeRelayUrl(relayUrl);
  if (!key) return;
  if (!peers[key]) peers[key] = {};
  if (token) peers[key][String(chatId).toLowerCase()] = token;
  else delete peers[key][String(chatId).toLowerCase()];
  await invoke('db_kv_set', { account, key: KV_PEERS, value: JSON.stringify(peers) });
}

// Миграция M2.1 → M2.2: плоские peer-токены переносятся на активный релей.
export async function migrateLegacyPeers(account, relayUrl) {
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

export function relayPublish(account, chatId, envelopeObj, encryptedBody) {
  const job = async () => {
    try {
      const { enabled } = await getSettings(account);
      if (!enabled) return { ok: false, why: 'disabled' };
      const relay = await pickLiveRelay(account);
      if (!relay) return { ok: false, why: 'no-live-relay' };
      const { peers } = await getSettings(account);
      const relayPeers = peers[relay.url] || {};
      const to = relayPeers[String(chatId).toLowerCase()];
      if (!to) return { ok: false, why: 'no-peer-token' };
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
          from: account,
        }),
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

// Опрос ВСЕХ живых релеев (каждый держит свою очередь): объединяем конверты.
// Дедуп по id в relayConsume (App.vue).
export async function relayPoll(account) {
  try {
    const { enabled, relays } = await getSettings(account);
    if (!enabled || !relays.length) return [];
    const results = await Promise.all(relays.filter(r => r.myToken).map(async (r) => {
      try {
        const res = await rfetch(r.url + '/poll?wait=0', {
          method: 'GET',
          headers: authHeader(r.myToken),
          connectTimeout: POLL_TIMEOUT_MS,
        });
        if (res.status === 204 || res.status === 402) return [];
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

// Живость активного релея (кнопка «проверить» в настройках).
export async function relayHealth(account) {
  const { relays, active } = await getSettings(account);
  if (!relays.length) return false;
  return relayHealthUrl(relays[active].url);
}

export function isRelayEnvelope(obj) {
  return obj && typeof obj === 'object' && obj.body && obj.id && obj.ts;
}
