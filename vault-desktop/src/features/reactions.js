// Feature module: реакции на сообщения. Этап 5 декомпозиции App.vue —
// инкапсуляция фич-доменов (ctx-паттерн Этапа 1/4: чистые функции,
// получают компонент как `ctx`, все зависимости явные).
//
// Хранилище: localStorage "vault-reactions-<email>" {chatKey:{msg_id:[{emoji,user}]}}
// — поллинг перерисовывает сообщения из почты, без хранилища реакции
// исчезали через 30 сек даже у отправителя.
// Wire: сигнал-письмо {react:1, msg_id, emoji, action} (как голоса poll).

import api from '../api.js';
import crypto from '../crypto.js';

export function reactionsStorageKey(ctx) {
  return 'vault-reactions-' + (ctx.email || 'anon');
}

export function loadStoredReactions(ctx) {
  try {
    return JSON.parse(localStorage.getItem(reactionsStorageKey(ctx)) || '{}');
  } catch (e) {
    return {};
  }
}

export function saveStoredReactions(ctx, data) {
  try {
    localStorage.setItem(reactionsStorageKey(ctx), JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save reactions:', e);
  }
}

// Мерж сохранённых реакций + реакций из писем (wireReactions: msg_id ->
// [{emoji, user, action}]). Результат пишется в хранилище и в msg.reactions.
export function applyReactions(ctx, list, chatKey, wireReactions) {
  const stored = loadStoredReactions(ctx);
  const chatReactions = stored[chatKey] || {};
  // Применяем реакции из писем (add/remove) к хранилищу.
  if (wireReactions && Object.keys(wireReactions).length) {
    for (const [msgId, reactions] of Object.entries(wireReactions)) {
      const cur = chatReactions[msgId] || [];
      for (const r of reactions) {
        const idx = cur.findIndex(x => x.emoji === r.emoji && x.user === r.user);
        if (r.action === 'remove') {
          if (idx >= 0) cur.splice(idx, 1);
        } else if (idx < 0) {
          cur.push({ emoji: r.emoji, user: r.user });
        }
      }
      if (cur.length) chatReactions[msgId] = cur;
      else delete chatReactions[msgId];
    }
    stored[chatKey] = chatReactions;
    saveStoredReactions(ctx, stored);
  }
  // Проставляем на сообщения (массив эмодзи для рендера).
  for (const msg of list) {
    const rs = chatReactions[msg.id];
    msg.reactions = rs ? [...new Set(rs.map(r => r.emoji))] : [];
  }
}

// Отправить реакцию письмом (транспорт E2E). Ошибки — не критичны.
export function sendReactionEmail(ctx, msgId, emoji, action) {
  const payload = JSON.stringify({ react: 1, msg_id: msgId, emoji, action });
  (async () => {
    try {
      if (ctx.activeChatType === 'group' && ctx.currentGroup) {
        const groupKey = ctx.groupKeys[ctx.currentGroup.id];
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupReact(ctx.currentGroup.id, content);
      } else if (ctx.activeChat && ctx.peerKeys[ctx.activeChat]) {
        crypto.setPeerPublicKey(ctx.peerKeys[ctx.activeChat], ctx.peerPqKeys && ctx.peerPqKeys[ctx.activeChat]);
        const content = await crypto.encryptVault(payload);
        await api.sendReaction(ctx.activeChat, content);
      }
    } catch (e) {
      console.error('Failed to send reaction email:', e);
    }
  })();
}

export function toggleReactionPicker(ctx, msgId) {
  // Пилюли звонков — не сообщения: реакции на них не нужны.
  const m = (ctx.messages || []).find(x => x && x.id === msgId);
  if (m && m.callEvent) return;
  // Если пользователь выделял текст (копирование) — клик не должен
  // открывать пикер реакций.
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length > 0) return;
  } catch (e) { /* ignore */ }
  ctx.reactionPickerMsgId = ctx.reactionPickerMsgId === msgId ? null : msgId;
}

export function addReaction(ctx, msgId, emoji) {
  const msg = ctx.messages.find(m => m.id === msgId);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = [];
  if (!msg.reactions.includes(emoji)) {
    msg.reactions.push(emoji);
  }
  // Персистентность: сохранить сразу (переживёт поллинг).
  const chatKey = ctx.activeChatType === 'group' ? ctx.activeChat : ctx.activeChat;
  const stored = loadStoredReactions(ctx);
  const chatReactions = stored[chatKey] || {};
  const cur = chatReactions[msgId] || [];
  if (!cur.some(r => r.emoji === emoji && r.user === ctx.email)) {
    cur.push({ emoji, user: ctx.email });
  }
  chatReactions[msgId] = cur;
  stored[chatKey] = chatReactions;
  saveStoredReactions(ctx, stored);
  // Транспорт: отправить реакцию собеседнику/группе.
  sendReactionEmail(ctx, msgId, emoji, 'add');
  ctx.reactionPickerMsgId = null;
}

export function toggleReaction(ctx, msgId, emoji) {
  const msg = ctx.messages.find(m => m.id === msgId);
  if (!msg || !msg.reactions) return;
  const idx = msg.reactions.indexOf(emoji);
  if (idx >= 0) {
    msg.reactions.splice(idx, 1);
  }
  // Убрать из хранилища и уведомить собеседника.
  const chatKey = ctx.activeChat;
  const stored = loadStoredReactions(ctx);
  const chatReactions = stored[chatKey] || {};
  const cur = chatReactions[msgId] || [];
  const ri = cur.findIndex(r => r.emoji === emoji && r.user === ctx.email);
  if (ri >= 0) {
    cur.splice(ri, 1);
    if (cur.length) chatReactions[msgId] = cur;
    else delete chatReactions[msgId];
    stored[chatKey] = chatReactions;
    saveStoredReactions(ctx, stored);
    sendReactionEmail(ctx, msgId, emoji, 'remove');
  }
}
