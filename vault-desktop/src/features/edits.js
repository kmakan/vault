// Feature module: правка/удаление сообщений + tombstones. Этап 5
// декомпозиции App.vue — изоляция фич-доменов (ctx-паттерн Этапа 1/4).
//
// Три среза домена:
//  - wire-правки (edit/delete письма) → localStorage-хранилище + applyEdits;
//  - tombstones (msg_id и Message-ID) — «удалено навсегда», sqlite;
//  - edit-flow UI (startEditMessage/cancelEdit/deleteMessage*).
//
// Инвариант applyEdits: правка применяется только от АВТОРА оригинала
// («Bad sender»); delete ставит tombstone навсегда (воскресление
// из письма/истории/All Mail невозможно).

import api, { db } from '../api.js';
import crypto from '../crypto.js';

// ── Хранилище wire-правок ─────────────────────────────────────────────────
export function editsStorageKey(ctx) {
  return 'vault-edits-' + (ctx.email || 'anon');
}

export function loadStoredEdits(ctx) {
  try {
    return JSON.parse(localStorage.getItem(editsStorageKey(ctx)) || '{}');
  } catch (e) {
    return {};
  }
}

export function saveStoredEdits(ctx, data) {
  try {
    localStorage.setItem(editsStorageKey(ctx), JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save edits:', e);
  }
}

// Локальная (оптимистичная) запись правки — до доставки письма.
export function recordLocalEdit(ctx, chatKey, msgId, text, action) {
  const stored = loadStoredEdits(ctx);
  const chatEdits = stored[chatKey] || {};
  const cur = chatEdits[msgId] || [];
  cur.push({ text: text || '', action, date: Date.now(), sender: ctx.email });
  chatEdits[msgId] = cur;
  stored[chatKey] = chatEdits;
  saveStoredEdits(ctx, stored);
}

// ── Tombstones (msg_id + Message-ID) ──────────────────────────────────────
export function tombstonesKey(ctx) {
  return 'vault-tombstones-' + (ctx.email || 'anon');
}

export function loadTombstones(ctx) {
  return ctx.tombstonesCache || [];
}

export function addTombstone(ctx, msgId) {
  if (!msgId) return;
  const list = ctx.tombstonesCache;
  if (!list.includes(msgId)) {
    list.push(msgId);
    // sqlite persist (async, fire-and-forget)
    db.tombstoneAdd(ctx.email || 'anon', msgId, '');
  }
}

export function isTombstoned(ctx, msgId) {
  if (!msgId) return false;
  return (ctx.tombstonesCache || []).includes(msgId);
}

// Message-ID tombstones (DC-аналог rfc724_mid): письмо, чей Message-ID
// когда-либо был удалён, НЕ ВОСКРЕШАЕТ даже при переезде между папками
// или повторной доставке с новым UID — работает ГЛОБАЛЬНО (All Mail и
// вернувшиеся письма отфильтруются).
export function midTombstonesKey(ctx) {
  return 'vault-mid-tombstones-' + (ctx.email || 'anon');
}

export function loadMidTombstones(ctx) {
  return ctx.midTombstonesCache || [];
}

export function addMidTombstone(ctx, mid) {
  if (!mid) return;
  const list = ctx.midTombstonesCache;
  if (!list.includes(mid)) {
    list.push(mid);
    db.tombstoneAdd(ctx.email || 'anon', '', mid);
  }
}

export function isMidTombstoned(ctx, mid) {
  if (!mid) return false;
  return (ctx.midTombstonesCache || []).includes(mid);
}

// Удалённые сообщения не возвращаются в чат никогда: tombstone (msg_id
// удалён навсегда) или deleted-метка из истории — фильтруются при
// каждом построении чата (история + письма + pending).
export function filterDeleted(ctx, list) {
  const tombs = loadTombstones(ctx);
  const mids = loadMidTombstones(ctx);
  return (list || []).filter(m => m && !m.deleted && !(m.id && tombs.includes(m.id)) && !(m.mid && mids.includes(m.mid)));
}

// ── Мерж wire-правок на сообщения ─────────────────────────────────────────
// Последняя по дате правка авторитетна: delete → msg.deleted,
// edit → msg.content = новый текст + msg.edited.
export function applyEdits(ctx, list, chatKey, wireEdits) {
  const stored = loadStoredEdits(ctx);
  const chatEdits = stored[chatKey] || {};
  // Мерж правок из писем в хранилище. Дедупликация по
  // дате+тексту+действию+отправителю (один и тот же edit-конверт
  // доходит в нескольких копиях — Sent отправителя + INBOX получателя).
  if (wireEdits && Object.keys(wireEdits).length) {
    for (const [msgId, edits] of Object.entries(wireEdits)) {
      const cur = chatEdits[msgId] || [];
      for (const e of edits) {
        const dup = cur.some(x => x.text === e.text && x.action === e.action
          && String(x.date || 0) === String(e.date || 0) && (x.sender || '') === (e.sender || ''));
        if (!dup) cur.push(e);
      }
      chatEdits[msgId] = cur;
    }
    stored[chatKey] = chatEdits;
    saveStoredEdits(ctx, stored);
  }
  // Проставляем на сообщения. Проверка отправителя (аналог «Bad sender»):
  // edit/delete применяются только от АВТОРА оригинала; чужие правки
  // игнорируются. Старые правки без sender — применяем (обратная
  // совместимость).
  for (const msg of list) {
    const edits = chatEdits[msg.id];
    if (!edits || !edits.length) continue;
    const mine = edits.filter(e => {
      if (!e.sender) return true;
      if (msg.sender_id) return e.sender === msg.sender_id;
      // 1:1 без sender_id: моё сообщение правит только мой email,
      // чужое — только не мой (в 1:1 другой участник один).
      if (msg.from === 'me') return e.sender === ctx.email;
      return e.sender !== ctx.email;
    });
    if (!mine.length) continue;
    const latest = mine.reduce((a, b) => (new Date(b.date || 0) >= new Date(a.date || 0) ? b : a));
    if (latest.action === 'delete') {
      // Навсегда: tombstone + скрытие (фильтр в mergeHistory/mergePending).
      addTombstone(ctx, msg.id);
      addMidTombstone(ctx, msg.mid);
      msg.deleted = true;
      msg.content = '';
    } else if (latest.text) {
      msg.content = latest.text;
      msg.edited = true;
    }
  }
}

// ── Транспорт правок ──────────────────────────────────────────────────────
// 1-на-1 — encryptVault(JSON {edit:1,msg_id,text?,action}) с пустой темой;
// группа — encryptWithGroupKey, письма VaultGroupEdit: <id>.
export function sendEditEmail(ctx, msgId, text, action) {
  // Метки письма (аналог DC Chat-Edit/Chat-Delete + rfc724_mid, но в
  // зашифрованном теле — стелс): msg_id (сопоставление с оригиналом),
  // sender (проверка «автор оригинала» на стороне получателя), ts
  // (последняя по времени правка авторитетна).
  const payload = JSON.stringify({ edit: 1, msg_id: msgId, text: text || '', action, sender: ctx.email, ts: Date.now() });
  (async () => {
    try {
      if (ctx.activeChatType === 'group' && ctx.currentGroup) {
        const groupKey = ctx.groupKeys[ctx.currentGroup.id];
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupEdit(ctx.currentGroup.id, content);
      } else if (ctx.activeChat && ctx.peerKeys[ctx.activeChat]) {
        crypto.setPeerPublicKey(ctx.peerKeys[ctx.activeChat], ctx.peerPqKeys && ctx.peerPqKeys[ctx.activeChat]);
        const content = await crypto.encryptVault(payload);
        await api.sendEdit(ctx.activeChat, content);
      }
    } catch (e) {
      console.error('Failed to send edit email:', e);
    }
  })();
}
