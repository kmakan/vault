// Feature module: локальная история чатов + кэши тел писем + оптимистичные
// исходящие. ADR-001: зависимости в сигнатурах, а не ctx-экземпляр.
import { db } from '../api.js';
import { accountNamespace } from '../identity.js';
import { saveHistory, loadHistory } from '../history.js';
import * as EnvelopeId from './envelope-id.js';

export { msgTs as _msgTsInternal };

// ── Ключи ──
export function bodyCacheKey(email) {
  return 'vault-body-cache:' + (email || 'anon');
}
export function chatCacheKey(email, chat) {
  return 'vault-chat-cache:' + (email || 'anon') + ':' + chat;
}

// ── Body-cache (sqlite kv) ──
// Чистая загрузка: возвращает { bodies, order } — мутировать память
// решает вызывающий (App.vue), чтобы не держать setters в core-фиче.
export async function loadBodyCache(email) {
  try {
    const rows = await db.bodyCacheLoadAll(await accountNamespace(email));
    const bodies = {};
    const order = [];
    for (const [key, body] of rows || []) {
      bodies[key] = body;
      order.push(key);
    }
    return { bodies, order };
  } catch (e) {
    console.warn('loadBodyCache (sqlite) failed:', JSON.stringify(e), String(e));
    return { bodies: {}, order: [] };
  }
}

// Мутирует переданный кэш in-place (emailBodyCache — общий реактивный объект).
export function cacheBody({ emailBodyCache, bodyCacheOrder }, key, body) {
  emailBodyCache[key] = body;
  const i = bodyCacheOrder.indexOf(key);
  if (i >= 0) bodyCacheOrder.splice(i, 1);
  bodyCacheOrder.push(key);
  while (bodyCacheOrder.length > 400) {
    const old = bodyCacheOrder.shift();
    delete emailBodyCache[old];
  }
}

export async function persistBodyCache(email, emailBodyCache) {
  try {
    const acc = await accountNamespace(email);
    for (const k of Object.keys(emailBodyCache)) {
      db.bodyCacheSet(acc, k, emailBodyCache[k]).catch(() => {});
    }
  } catch (e) {
    // Кэш не критичен — молча пропускаем.
  }
}

// ── Chat-cache (sqlite kv) ──
export async function loadChatCache(email, chat) {
  try {
    const raw = await db.kvGet(await accountNamespace(email), 'chat-cache:' + chat);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function saveChatCache(email, chat, list, msgTs) {
  try {
    const slim = (list || []).map(m => ({
      id: m.id, content: m.content, from: m.from, time: m.time,
      encrypted: m.encrypted, vault: m.vault, status: m.status,
      ts: m.ts || msgTs(m) || undefined,
      reactions: m.reactions || undefined,
      deleted: m.deleted || undefined,
      edited: m.edited || undefined,
      sender_id: m.sender_id || undefined,
      attachment: m.attachment || undefined,
      callEvent: m.callEvent || undefined,
    }));
    db.kvSet(await accountNamespace(email), 'chat-cache:' + chat, JSON.stringify(slim)).catch(() => {});
  } catch (e) { /* quota — не критично */ }
}

// ── Оптимистичные исходящие (pendingOutgoing) ──
export function markPending({ setPendingOutgoing }, chatKey, msg) {
  if (typeof setPendingOutgoing === 'function') setPendingOutgoing(chatKey, msg);
}

export function mergePending({ pendingOutgoing, isTombstoned, msgTs, mergePendingOutgoing, dropBucket }, chatKey, list) {
  const bucket = (pendingOutgoing || {})[chatKey];
  if (!bucket || !Object.keys(bucket).length) return list;
  const now = Date.now();
  const out = [...list];
  const seen = new Set(list.map(m => m.id));
  const remaining = {};
  for (const [id, msg] of Object.entries(bucket)) {
    if (seen.has(id)) continue;
    if (EnvelopeId.isPendingId(id)) {
      const real = list.find((m) => EnvelopeId.matchesPending(msg, m, now));
      if (real) continue;
    }
    if (isTombstoned && isTombstoned(id)) continue;
    if (msg.status !== 'failed' && msg._pendingAt && now - msg._pendingAt > 10 * 60 * 1000) continue;
    remaining[id] = msg;
    out.push(msg);
  }
  if (Object.keys(remaining).length) {
    if (typeof mergePendingOutgoing === 'function') mergePendingOutgoing(chatKey, remaining);
  } else {
    if (typeof dropBucket === 'function') dropBucket(chatKey);
  }
  out.sort((a, b) => msgTs(a) - msgTs(b));
  return out;
}

// ── Локальная история (sqlite) ──
export function normalizeStaleSending(msgTs, hist) {
  if (!hist || !hist.length) return hist;
  const now = Date.now();
  for (const m of hist) {
    if (m && m.from === 'me' && m.status === 'sending') {
      const t = msgTs(m);
      if (t && now - t > 60 * 1000) m.status = 'sent';
    }
  }
  return hist;
}

// Чистая загрузка локальной истории: sqlite → normalize → filter call_*.
export async function loadLocalHistory(email, chatKey, msgTs) {
  let hist = null;
  try {
    hist = await loadHistory(email, chatKey);
  } catch (e) { /* sqlite недоступен — чат откроется из писем */ }
  hist = normalizeStaleSending(msgTs, hist);
  // Сигнальные call_*-конверты: старые сборки сохраняли их в историю
  // как сырой JSON — не рендерим нигде.
  if (hist && hist.length) {
    hist = hist.filter(m => {
      const c = (m && m.content) || '';
      return !(typeof c === 'string' && c.indexOf('"type":"call_') !== -1);
    });
  }
  return hist;
}

export async function mergeHistory({ email, msgTs, filterDeleted }, chatKey, list) {
  let hist = await loadLocalHistory(email, chatKey, msgTs);
  if (!hist || !hist.length) return list;
  hist = hist.filter(m => {
    const c = (m && m.content) || '';
    return !(typeof c === 'string' && (c.indexOf('"type":"call_') !== -1 || c.indexOf('"type": "call_') !== -1));
  });
  const ids = new Set();
  for (const m of hist) if (m && m.id) ids.add(m.id);
  const extra = list.filter(m => m && m.id && !ids.has(m.id));
  if (extra.length && String(chatKey).startsWith('group:')) {
    const pollQs = new Set(extra.filter(m => m && m.poll && m.poll.question).map(m => m.poll.question));
    if (pollQs.size) {
      hist = hist.filter(h => !(!h || h.poll || typeof h.content !== 'string' || !pollQs.has(h.content)));
    }
  }
  if (!extra.length) {
    hist.sort((a, b) => msgTs(a) - msgTs(b));
    return filterDeleted ? filterDeleted(hist) : hist;
  }
  const merged = [...hist, ...extra];
  merged.sort((a, b) => msgTs(a) - msgTs(b));
  return filterDeleted ? filterDeleted(merged) : merged;
}

// Машинная временная метка сообщения для сортировки чата.
export function msgTs(m) {
  if (!m) return 0;
  if (m.ts) return m.ts;
  if (m.email && m.email.date) return new Date(m.email.date).getTime();
  if (m.created_at) return new Date(m.created_at).getTime();
  if (m._pendingAt) return m._pendingAt;
  return 0;
}

export function showHistoryFirst({ loadHistory, chat, msgTs }, chatKey, isStale) {
  return loadHistory(chatKey).then(hist => {
    if (hist && hist.length && !isStale()) {
      hist.sort((a, b) => msgTs(a) - msgTs(b));
      chat.set(hist.filter(m => {
        const c = (m && m.content) || '';
        return !(typeof c === 'string' && (c.indexOf('"type":"call_') !== -1 || c.indexOf('"type":"profile"') !== -1));
      }));
    }
  });
}

// chatState: объект с .messages (реактивный стейт чата).
export function saveCurrentHistory(email, chatKey, chatState) {
  try {
    saveHistory(email, chatKey, (chatState && chatState.messages) || []);
  } catch (e) {
    console.warn('saveHistory (sqlite) failed:', e);
  }
}
