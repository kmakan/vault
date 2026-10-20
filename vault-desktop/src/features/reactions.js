// Feature module: реакции на сообщения. Этап 5 декомпозиции App.vue —
// инкапсуляция фич-доменов (ctx-паттерн Этапа 1/4: чистые функции,
// получают компонент как `ctx`, все зависимости явные).
//
// Хранилище: localStorage "vault-reactions-<email>" {chatKey:{msg_id:[{emoji,user}]}}
// — поллинг перерисовывает сообщения из почты, без хранилища реакции
// исчезали через 30 сек даже у отправителя.
// Wire: сигнал-письмо {react:1, msg_id, emoji, action} (как голоса poll).
//
// ADR-001: зависимости в сигнатуре — email/чат/релей/api/crypto явно,
// а не `ctx` целиком. Функции мутируют переданный chat/msg-объекты
// и localStorage; setReactionPickerMsgId — setter для UI-состояния.

import api from '../api.js';
import crypto from '../crypto.js';

export function reactionsStorageKey(email) {
  return 'vault-reactions-' + (email || 'anon');
}

export function loadStoredReactions(email) {
  try {
    return JSON.parse(localStorage.getItem(reactionsStorageKey(email)) || '{}');
  } catch (e) {
    return {};
  }
}

export function saveStoredReactions(email, data) {
  try {
    localStorage.setItem(reactionsStorageKey(email), JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save reactions:', e);
  }
}

// Мерж сохранённых реакций + реакций из писем (wireReactions: msg_id ->
// [{emoji, user, action}]). Результат пишется в хранилище и в msg.reactions.
export function applyReactions({ email }, list, chatKey, wireReactions) {
  const stored = loadStoredReactions(email);
  const chatReactions = stored[chatKey] || {};
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
    saveStoredReactions(email, stored);
  }
  for (const msg of list) {
    const rs = chatReactions[msg.id];
    msg.reactions = rs ? [...new Set(rs.map(r => r.emoji))] : [];
  }
}

// Отправить реакцию письмом (транспорт E2E). Ошибки — не критичны.
export function sendReactionEmail({ activeChatType, currentGroup, groupKeys, peerKeys, peerPqKeys, activeChat }, msgId, emoji, action) {
  const payload = JSON.stringify({ react: 1, msg_id: msgId, emoji, action });
  (async () => {
    try {
      if (activeChatType === 'group' && currentGroup) {
        const groupKey = (groupKeys || {})[currentGroup.id];
        if (!groupKey) return;
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupReact(currentGroup.id, content);
      } else if (activeChat && (peerKeys || {})[activeChat]) {
        crypto.setPeerPublicKey(peerKeys[activeChat], peerPqKeys && peerPqKeys[activeChat]);
        const content = await crypto.encryptVault(payload);
        await api.sendReaction(activeChat, content);
      }
    } catch (e) {
      console.error('Failed to send reaction email:', e);
    }
  })();
}

// deps: { chat, reactionPickerMsgId(), setReactionPickerMsgId(v) }
// Состояние пикера — у владельца форм (uiStore), ADR-005 W3 п.3.
export function toggleReactionPicker(deps, msgId) {
  const chat = deps.chat;
  const current = deps.reactionPickerMsgId();
  // Пилюли звонков — не сообщения: реакции на них не нужны.
  // chat.byId возвращает null/undefined вне активного чата — optional access.
  const m = chat && typeof chat.byId === 'function' ? chat.byId(msgId) : null;
  if (m && m.callEvent) return current;
  // Если пользователь выделял текст (копирование) — клик не открывает пикер.
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length > 0) return current;
  } catch (e) { /* ignore */ }
  return current === msgId ? null : msgId;
}

// deps: { email(), chat, activeChat(), sendReactionEmail, setReactionPickerMsgId(v) }
export function addReaction(deps, msgId, emoji) {
  const email = deps.email();
  const chat = deps.chat;
  const activeChat = deps.activeChat();
  const { sendReactionEmail, setReactionPickerMsgId } = deps;
  if (chat && typeof chat.patch === 'function') {
    chat.patch(msgId, (msg) => {
      if (!msg.reactions) msg.reactions = [];
      if (!msg.reactions.includes(emoji)) msg.reactions.push(emoji);
    });
  }
  const chatKey = activeChat;
  const stored = loadStoredReactions(email);
  const chatReactions = stored[chatKey] || {};
  const cur = chatReactions[msgId] || [];
  if (!cur.some(r => r.emoji === emoji && r.user === email)) {
    cur.push({ emoji, user: email });
  }
  chatReactions[msgId] = cur;
  stored[chatKey] = chatReactions;
  saveStoredReactions(email, stored);
  sendReactionEmail(msgId, emoji, 'add');
  if (typeof setReactionPickerMsgId === 'function') setReactionPickerMsgId(null);
}

export function toggleReaction({ email, chat, activeChat, sendReactionEmail }, msgId, emoji) {
  if (chat && typeof chat.patch === 'function') {
    chat.patch(msgId, (msg) => {
      if (!msg.reactions) return;
      const idx = msg.reactions.indexOf(emoji);
      if (idx >= 0) msg.reactions.splice(idx, 1);
    });
  }
  const chatKey = activeChat;
  const stored = loadStoredReactions(email);
  const chatReactions = stored[chatKey] || {};
  const cur = chatReactions[msgId] || [];
  const ri = cur.findIndex(r => r.emoji === emoji && r.user === email);
  if (ri >= 0) {
    cur.splice(ri, 1);
    if (cur.length) chatReactions[msgId] = cur;
    else delete chatReactions[msgId];
    stored[chatKey] = chatReactions;
    saveStoredReactions(email, stored);
    sendReactionEmail(msgId, emoji, 'remove');
  }
}
