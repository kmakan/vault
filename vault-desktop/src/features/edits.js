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
import { accountNamespace } from '../identity.js';
import crypto from '../crypto.js';
import * as MsgFormat from '../message-format.js';
import { uiStore } from './session-store.js';

// ── Хранилище wire-правок ─────────────────────────────────────────────────
// ADR-001: зависимости в сигнатуре — email вместо ctx целиком.
export function editsStorageKey(email) {
  return 'vault-edits-' + (email || 'anon');
}

export function loadStoredEdits(email) {
  try {
    return JSON.parse(localStorage.getItem(editsStorageKey(email)) || '{}');
  } catch (e) {
    return {};
  }
}

export function saveStoredEdits(email, data) {
  try {
    localStorage.setItem(editsStorageKey(email), JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save edits:', e);
  }
}

// Локальная (оптимистичная) запись правки — до доставки письма.
export function recordLocalEdit(email, chatKey, msgId, text, action) {
  const stored = loadStoredEdits(email);
  const chatEdits = stored[chatKey] || {};
  const cur = chatEdits[msgId] || [];
  cur.push({ text: text || '', action, date: Date.now(), sender: email });
  chatEdits[msgId] = cur;
  stored[chatKey] = chatEdits;
  saveStoredEdits(email, stored);
}

// ── Tombstones (msg_id + Message-ID) ──────────────────────────────────────
export function tombstonesKey(email) {
  return 'vault-tombstones-' + (email || 'anon');
}

export function loadTombstones(tombstonesCache) {
  return tombstonesCache || [];
}

// Асинхронные: tombstone пишется в namespace идентичности (fp:<fingerprint>),
// а не под емейл — иначе после смены почты удалённые сообщения воскресают.
// Вызывающие не ждут результат (fire-and-forget), как и раньше.
export async function addTombstone({ email, tombstonesCache }, msgId) {
  if (!msgId) return;
  const list = tombstonesCache || [];
  if (!list.includes(msgId)) {
    list.push(msgId);
    // sqlite persist (async, fire-and-forget)
    db.tombstoneAdd(await accountNamespace(email), msgId, '').catch(() => {});
  }
}

export function isTombstoned(tombstonesCache, msgId) {
  if (!msgId) return false;
  return (tombstonesCache || []).includes(msgId);
}

// Message-ID tombstones (DC-аналог rfc724_mid): письмо, чей Message-ID
// когда-либо был удалён, НЕ ВОСКРЕШАЕТ даже при переезде между папками
// или повторной доставке с новым UID — работает ГЛОБАЛЬНО (All Mail и
// вернувшиеся письма отфильтруются).
export function midTombstonesKey(email) {
  return 'vault-mid-tombstones-' + (email || 'anon');
}

export function loadMidTombstones(midTombstonesCache) {
  return midTombstonesCache || [];
}

export async function addMidTombstone({ email, midTombstonesCache }, mid) {
  if (!mid) return;
  const list = midTombstonesCache || [];
  if (!list.includes(mid)) {
    list.push(mid);
    db.tombstoneAdd(await accountNamespace(email), '', mid).catch(() => {});
  }
}

export function isMidTombstoned(midTombstonesCache, mid) {
  if (!mid) return false;
  return (midTombstonesCache || []).includes(mid);
}

// Удалённые сообщения не возвращаются в чат никогда: tombstone (msg_id
// удалён навсегда) или deleted-метка из истории — фильтруются при
// каждом построении чата (история + письма + pending).
export function filterDeleted({ tombstonesCache, midTombstonesCache }, list) {
  const tombs = loadTombstones(tombstonesCache);
  const mids = loadMidTombstones(midTombstonesCache);
  return (list || []).filter(m => m && !m.deleted && !(m.id && tombs.includes(m.id)) && !(m.mid && mids.includes(m.mid)));
}

// ── Мерж wire-правок на сообщения ─────────────────────────────────────────
// Последняя по дате правка авторитетна: delete → msg.deleted,
// edit → msg.content = новый текст + msg.edited.
export function applyEdits({ email, tombstonesCache, midTombstonesCache }, list, chatKey, wireEdits) {
  const stored = loadStoredEdits(email);
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
    saveStoredEdits(email, stored);
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
      if (msg.from === 'me') return e.sender === email;
      return e.sender !== email;
    });
    if (!mine.length) continue;
    const latest = mine.reduce((a, b) => (new Date(b.date || 0) >= new Date(a.date || 0) ? b : a));
    if (latest.action === 'delete') {
      // Навсегда: tombstone + скрытие (фильтр в mergeHistory/mergePending).
      addTombstone({ email, tombstonesCache }, msg.id);
      addMidTombstone({ email, midTombstonesCache }, msg.mid);
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
export function sendEditEmail({ activeChat, activeChatType, currentGroup, groupKeys, peerKeys, peerPqKeys, email }, msgId, text, action) {
  // Метки письма (аналог DC Chat-Edit/Chat-Delete + rfc724_mid, но в
  // зашифрованном теле — стелс): msg_id (сопоставление с оригиналом),
  // sender (проверка «автор оригинала» на стороне получателя), ts
  // (последняя по времени правка авторитетна).
  const payload = JSON.stringify({ edit: 1, msg_id: msgId, text: text || '', action, sender: email, ts: Date.now() });
  (async () => {
    try {
      if (activeChatType === 'group' && currentGroup) {
        const groupKey = (groupKeys || {})[currentGroup.id];
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupEdit(currentGroup.id, content);
      } else if (activeChat && (peerKeys || {})[activeChat]) {
        crypto.setPeerPublicKey(peerKeys[activeChat], peerPqKeys && peerPqKeys[activeChat]);
        const content = await crypto.encryptVault(payload);
        await api.sendEdit(activeChat, content);
      }
    } catch (e) {
      console.error('Failed to send edit email:', e);
    }
  })();
}

// ── Правка и удаление сообщений (ADR-005 W3, партия 4) ───────────────────
// Логика ушла из App.vue. Состояние правки — у владельца форм (uiStore),
// сообщения — у чат-владельца (per-app), tombstone-кеш — у компонента
// (через deps).
//
// deps: { email(), activeChat(), activeChatType(), currentGroup(), chat, notes,
//         addTombstone(id), addMidTombstone(mid), recordLocalEdit(k,id,t,a),
//         sendEditEmail(id,t,a), saveCurrentHistory(k), saveChatCache(k,list),
//         editingMessage(), setEditingMessage(v), setReplyTo(v),
//         setNewMessage(v), focusInput(), nextTick(cb), confirm(msg) }

export function startEditMessage(deps, msg) {
  if (!msg || msg.from !== 'me' || msg.deleted) return;
  // Вложения редактировать нельзя — только текст.
  if (msg.attachment) return;
  deps.setEditingMessage(msg);
  deps.setReplyTo(null);
  // Редактируем только тело ответа; цитата "> ..." остаётся нетронутой
  deps.setNewMessage(MsgFormat.replyBody(msg.content || ''));
  deps.nextTick(() => { deps.focusInput(); });
}

export function cancelEdit(deps) {
  deps.setEditingMessage(null);
  deps.setNewMessage('');
}

export async function deleteMessage(deps, msg) {
  if (!msg || msg.from !== 'me' || msg.deleted) return;
  const email = deps.email();
  // Заметки для себя: удаляем заметку ПОЛНОСТЬЮ (никаких писем по почте
  // и «воскрешения» поллингом — заметки не читаются из IMAP).
  if (deps.activeChat() === '__notes__') {
    const ok = await deps.confirm(uiStore.tr('delete_message_confirm') || 'Удалить заметку?');
    if (!ok) return;
    deps.notes.removeById(email, msg.id);
    deps.chat.set(deps.notes.load(email));
    return;
  }
  const ok = await deps.confirm(uiStore.tr('delete_message_confirm') || 'Удалить сообщение у всех?');
  if (!ok) return;
  // Оптимистично помечаем удалённым локально + tombstone (поллинг
  // не «воскресит» сообщение: письмо-оригинал и история фильтруются).
  deps.addTombstone(msg.id);
  deps.addMidTombstone(msg.mid);
  msg.deleted = true;
  msg.content = '';
  // (у получателей — после доставки delete-письма).
  const list = deps.chat.state.messages;
  const idx = list.indexOf(msg);
  if (idx !== -1) deps.chat.removeById(list[idx].id);
  const chatKey = deps.activeChatType() === 'group' && deps.currentGroup()
    ? 'group:' + deps.currentGroup().id
    : deps.activeChat();
  deps.recordLocalEdit(chatKey, msg.id, null, 'delete');
  await deps.sendEditEmail(msg.id, null, 'delete');
}

export async function deleteMessageForMe(deps, msg) {
  if (!msg || !msg.id) return;
  const chatKey = deps.activeChatType() === 'group' && deps.currentGroup()
    ? 'group:' + deps.currentGroup().id
    : deps.activeChat();
  if (!chatKey || chatKey === '__notes__') return;
  deps.addTombstone(msg.id);
  deps.addMidTombstone(msg.mid);
  const list = deps.chat.state.messages;
  const idx = list.indexOf(msg);
  if (idx !== -1) deps.chat.removeById(list[idx].id);
  deps.saveCurrentHistory(chatKey);
  // chat-cache тоже обновляем: loadChatCache не фильтрует tombstones,
  deps.saveChatCache(chatKey, list);
}
