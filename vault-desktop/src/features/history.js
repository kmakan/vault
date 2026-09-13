// Feature module: локальная история чатов + кэши тел писем + оптимистичные
// исходящие. Этап 5 декомпозиции App.vue — изоляция фич-доменов
// (ctx-паттерн Этапа 1/4: чистые функции, компонент как `ctx`).
//
// Четыре среза домена:
//  - body-cache: тела писем в sqlite (db.bodyCache*), FIFO ~400, debounce;
//  - chat-cache: слайм-кэш отрисованных сообщений чата (kv_store);
//  - pendingOutgoing: оптимистичные исходящие (markPending/mergePending);
//  - история: loadLocalHistory/mergeHistory/showHistoryFirst/
//    saveCurrentHistory/normalizeStaleSending (sqlite db.history_*).
//
// Инвариант mergeHistory: история — источник правды, письма только
// ДОБАВЛЯЮТ новое; уже показанное не затирается и не «мерцает».

import { db } from '../api.js';
import { saveHistory, loadHistory } from '../history.js';

// ── Ключи ──────────────────────────────────────────────────────
export function bodyCacheKey(ctx) {
  return 'vault-body-cache:' + (ctx.email || 'anon');
}

export function chatCacheKey(ctx, chat) {
  return 'vault-chat-cache:' + (ctx.email || 'anon') + ':' + chat;
}

// ── Body-cache (тела писем, sqlite) ────────────────────────────
// Загрузка кэша тел писем из SQLite — вызывается после логина/
// восстановления сессии.
export async function loadBodyCache(ctx) {
  try {
    const rows = await db.bodyCacheLoadAll(ctx.email || 'anon');
    const bodies = {};
    const order = [];
    for (const [key, body] of rows || []) {
      bodies[key] = body;
      order.push(key);
    }
    ctx.emailBodyCache = bodies;
    ctx.bodyCacheOrder = order;
  } catch (e) {
    console.warn('loadBodyCache (sqlite) failed:', JSON.stringify(e), String(e));
    ctx.emailBodyCache = {};
    ctx.bodyCacheOrder = [];
  }
}

// Запись тела в кэш: SQLite (db_body_cache_set) + память. Лимит ~400 тел:
// старые вытесняются (FIFO по bodyCacheOrder).
export function cacheBody(ctx, key, body) {
  ctx.emailBodyCache[key] = body;
  const i = ctx.bodyCacheOrder.indexOf(key);
  if (i >= 0) ctx.bodyCacheOrder.splice(i, 1);
  ctx.bodyCacheOrder.push(key);
  while (ctx.bodyCacheOrder.length > 400) {
    const old = ctx.bodyCacheOrder.shift();
    delete ctx.emailBodyCache[old];
  }
  if (ctx.bodyCacheSaveTimer) clearTimeout(ctx.bodyCacheSaveTimer);
  ctx.bodyCacheSaveTimer = setTimeout(() => persistBodyCache(ctx), 2000);
}

export function persistBodyCache(ctx) {
  // SQLite-персистенция (debounce сохранён в cacheBody): каждое тело — своя
  // строка body_cache(account, cache_key, body). localStorage не используется.
  const acc = ctx.email || 'anon';
  try {
    for (const k of Object.keys(ctx.emailBodyCache)) {
      db.bodyCacheSet(acc, k, ctx.emailBodyCache[k]).catch(() => {});
    }
  } catch (e) {
    // Кэш не критичен — молча пропускаем.
  }
}

// ── Chat-cache (слайм-сообщения чата, sqlite kv) ───────────────
// Кэш отрисованных сообщений чата (без тяжёлых полей email-объектов).
// Хранится в SQLite kv_store.
export async function loadChatCache(ctx, chat) {
  try {
    const raw = await db.kvGet(ctx.email || 'anon', 'chat-cache:' + chat);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function saveChatCache(ctx, chat, list) {
  try {
    // email-объект письма не персистим (тяжёлый и не нужен для рендера).
    // attachment персистим: без него из кэша пропадают плеер аудио,
    // кнопка «скачать» и текст вложения.
    const slim = (list || []).map(m => ({
      id: m.id, content: m.content, from: m.from, time: m.time,
      encrypted: m.encrypted, vault: m.vault, status: m.status,
      ts: m.ts || ctx.msgTs(m) || undefined,
      reactions: m.reactions || undefined,
      deleted: m.deleted || undefined,
      edited: m.edited || undefined,
      // sender_id нужен групповому рендеру (аватар/имя отправителя над
      // чужим сообщением) — без него из кэша блок отправителя исчезал,
      // хотя при свежем фетче появлялся («аватарки то есть, то нет»).
      sender_id: m.sender_id || undefined,
      attachment: m.attachment || undefined,
      // Пилюли звонков: без этого поля из кэша пропадают
      // «Пропущенный звонок» и т.п.
      callEvent: m.callEvent || undefined,
    }));
    db.kvSet(ctx.email || 'anon', 'chat-cache:' + chat, JSON.stringify(slim)).catch(() => {});
  } catch (e) { /* quota — не критично */ }
}

// ── Оптимистичные исходящие (pendingOutgoing) ──────────────────
// Отправка SMTP медленная (до минуты), а поллинг каждые 30 с перестраивает
// messages из IMAP. Без этого сообщение «появлялось и исчезало» у
// отправителя: оптимистичная запись стиралась, пока письмо не сделает
// круг SMTP → ящик → INBOX/Sent. Здесь:
//  - markPending: регистрируем оптимистичное сообщение;
//  - mergePending: при перестроении списка подмешиваем ещё не
//    подтверждённые записи (их нет в IMAP-списке), а подтверждённые
//    (id уже отрисован из письма) — удаляем из реестра.
export function markPending(ctx, chatKey, msg) {
  if (!msg || !msg.id) return;
  const bucket = ctx.pendingOutgoing[chatKey] || {};
  bucket[msg.id] = msg;
  ctx.pendingOutgoing = { ...ctx.pendingOutgoing, [chatKey]: bucket };
}

export function mergePending(ctx, chatKey, list) {
  const bucket = ctx.pendingOutgoing[chatKey];
  if (!bucket || !Object.keys(bucket).length) return list;
  const now = Date.now();
  const out = [...list];
  const seen = new Set(list.map(m => m.id));
  const remaining = {};
  for (const [id, msg] of Object.entries(bucket)) {
    if (seen.has(id)) continue; // письмо уже в списке — реальное заменило оптимистичное
    // Удалённое сообщение не возвращается из pending (tombstone).
    if (ctx.isTombstoned(id)) continue;
    // Страховка: не держим запись дольше 10 минут (если SMTP молча не
    // отправил письмо, сообщение не должно висеть «отправленным» вечно).
    // failed-записи (частичный фейл отправки) НЕ выкидываем — пользователь
    // должен видеть, что сообщение не дошло.
    if (msg.status !== 'failed' && msg._pendingAt && now - msg._pendingAt > 10 * 60 * 1000) continue;
    remaining[id] = msg;
    out.push(msg);
  }
  if (Object.keys(remaining).length) {
    ctx.pendingOutgoing = { ...ctx.pendingOutgoing, [chatKey]: remaining };
  } else {
    const copy = { ...ctx.pendingOutgoing };
    delete copy[chatKey];
    ctx.pendingOutgoing = copy;
  }
  // msgTs учитывает ts / email.date / created_at / _pendingAt — у групповых
  // сообщений и вложений нет email-объекта, сортировка по email.date давала
  // 0 и рвала хронологию.
  out.sort((a, b) => ctx.msgTs(a) - ctx.msgTs(b));
  return out;
}

// ── Локальная история (sqlite) ─────────────────────────────────
// mergeHistory: чат = письма из IMAP (свежие) + ПОЛНАЯ локальная история.
// Сообщения (с датами) остаются в чате навсегда, даже если письма ушли
// за лимиты фетча, легли в спам или исчезли из ящика. Почта — только
// транспорт: приносит НОВЫЕ письма, уже показанное не затирает.
// Локальная история чата: SQLite (db.history_load) — единственный
// источник. localStorage-копии НЕТ: WebKitGTK-localStorage ограничен
// ~5 МБ (body-cache уже 3–7 МБ), история живёт в sqlite vault.db
export async function loadLocalHistory(ctx, chatKey) {
  let hist = null;
  try {
    hist = await loadHistory(ctx.email, chatKey);
  } catch (e) { /* sqlite недоступен — чат откроется из писем */ }
  hist = normalizeStaleSending(ctx, hist);
  // Сигнальные call_*-конверты: старые сборки сохраняли их в
  // историю как сырой JSON — не рендерим нигде.
  if (hist && hist.length) {
    hist = hist.filter(m => {
      const c = (m && m.content) || '';
      return !(typeof c === 'string' && c.indexOf('"type":"call_') !== -1);
    });
  }
  return hist;
}

// 'sending' — переходный статус, он не должен долго жить в истории: его
// персистят оптимистично ДО отправки, а финальный пишут после. После
// вечно горела красным. Повышаем до 'sent' (письмо либо принято SMTP, либо
// умерло вместе с процессом — квитанции получателей уточнят статус позже).
export function normalizeStaleSending(ctx, hist) {
  if (!hist || !hist.length) return hist;
  const now = Date.now();
  for (const m of hist) {
    if (m && m.from === 'me' && m.status === 'sending') {
      const t = ctx.msgTs(m);
      if (t && now - t > 60 * 1000) m.status = 'sent';
    }
  }
  return hist;
}

// История — основа чата, письма добавляют новое. Полная локальная история
// (полученные когда-либо, остаются в чате навсегда, с датами), а письма
// из IMAP только ДОБАВЛЯЮТ новое. Без этого поллинг перестраивался из
// писем: старые письма (за курсорами/лимитами) выпадали, чат «мерцал»
// и рассинхронизировался между аккаунтами.
export async function mergeHistory(ctx, chatKey, list) {
  let hist = await loadLocalHistory(ctx, chatKey); // let: фильтр call_* ниже
  if (!hist || !hist.length) return list;
  // Звонки: сигнальные call_*-конверты, попавшие в историю
  // старыми сборками (до фильтра в loadMessages), не рендерим — они
  // «застревали» в чате как сырой JSON и не удалялись.
  hist = hist.filter(m => {
    const c = (m && m.content) || '';
    return !(typeof c === 'string' && (c.indexOf('"type":"call_') !== -1 || c.indexOf('"type": "call_') !== -1));
  });
  const ids = new Set();
  for (const m of hist) if (m && m.id) ids.add(m.id);
  // Исчезающие: старые записи истории могли быть сохранены БЕЗ
  // ttl/expireAt. Письмо то же — обновляем таймер из свежераспарсенного env.
  for (const h of hist) {
    if (!h || !h.id) continue;
    const fresh = list.find((x) => x && x.id === h.id && x.expireAt);
    if (fresh && !h.expireAt) {
      h.ttl = fresh.ttl;
      h.expireAt = fresh.expireAt;
    }
  }
  // Из писем добавляем только то, чего ещё нет в истории (новое).
  const extra = list.filter(m => m && m.id && !ids.has(m.id));
  // МИГРАЦИЯ 0.1.151 (только группы): старые сборки теряли env.poll и
  // писали в историю текст вопроса (id конверта). Свежая карточка из
  // писем (id poll-а, есть .poll) заменяет такую запись, иначе после
  // фикса в чате дубль: старый текст + новая карточка.
  if (extra.length && String(chatKey).startsWith('group:')) {
    const pollQs = new Set(extra.filter(m => m && m.poll && m.poll.question).map(m => m.poll.question));
    if (pollQs.size) {
      hist = hist.filter(h => !(!h || h.poll || typeof h.content !== 'string' || !pollQs.has(h.content)));
    }
  }
  // Сортировка ОБЯЗАТЕЛЬНА всегда: история в sqlite хранится в порядке
  // вставки, и без сортировки хронология рвалась
  // («16:37 20:31 18:06 18:07 20:38»).
  if (!extra.length) {
    hist.sort((a, b) => ctx.msgTs(a) - ctx.msgTs(b));
    return ctx.filterDeleted(hist);
  }
  const merged = [...hist, ...extra];
  merged.sort((a, b) => ctx.msgTs(a) - ctx.msgTs(b));
  return ctx.filterDeleted(merged);
}

// Машинная временная метка сообщения для сортировки чата.
export function msgTs(m) {
  if (!m) return 0;
  if (m.ts) return m.ts;
  if (m.email && m.email.date) return new Date(m.email.date).getTime();
  if (m.created_at) return new Date(m.created_at).getTime();
  // Оптимистичные исходящие (вложения/голос) персистились без ts —
  // только _pendingAt; без этого фолбэка они сортировались в начало.
  if (m._pendingAt) return m._pendingAt;
  return 0;
}

// Показ истории до фетча писем: чат открывается мгновенно, без ожидания
// IMAP, история переживает перезапуск (sqlite, см. loadLocalHistory).
export function showHistoryFirst(ctx, chatKey, isStale) {
  return loadLocalHistory(ctx, chatKey).then(hist => {
    if (hist && hist.length && !isStale()) {
      // История в sqlite — в порядке вставки; показываем сразу по времени.
      hist.sort((a, b) => msgTs(a) - msgTs(b));
      // Звонки (M3): вычищаем call_* конверты, попавшие в историю как
      // сырые сообщения — сигналы не рендерятся ни в истории, ни в чате.
      ctx.messages = hist.filter(m => {
        const c = (m && m.content) || '';
        return !(typeof c === 'string' && (c.indexOf('"type":"call_') !== -1 || c.indexOf('"type":"profile"') !== -1));
      });
    }
  });
}

export function saveCurrentHistory(ctx, chatKey) {
  // SQLite (db.history_save) — единственный источник истории. Сбои
  // sqlite не критичны: чат пересоберётся из писем IMAP при поллинге.
  try {
    saveHistory(ctx.email, chatKey, ctx.messages);
  } catch (e) {
    console.warn('saveHistory (sqlite) failed:', e);
  }
}
