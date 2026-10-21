// Feature module: forward (пересылка сообщений). Stage 1 → explicit-deps.
// Чистые функции получают зависимости в сигнатуре, а не this/ctx целиком.
// ADR-001: business-logic в Rust core, JS = только state/ui-flow.
import api from '../api.js';
import crypto from '../crypto.js';
import * as EnvelopeId from './envelope-id.js';
import * as WireSignalRule from '../wire-signal-rule.js';

export { forwardState } from './forward/state.js';

// Targets for forwarding: contacts + groups, excluding the current chat.
// Чистая: читает contacts/groups + resolver-функции.
export function forwardTargets({ contacts, groups, activeChat, activeChatType, currentGroup, nameOf, t }) {
  const list = [];
  for (const c of contacts || []) {
    if (c.email && c.email !== '__notes__' && c.email !== activeChat) {
      list.push({ key: c.email, label: (nameOf ? nameOf(c.email) : null) || c.email });
    }
  }
  for (const g of groups || []) {
    if (!(activeChatType === 'group' && currentGroup && g.id === currentGroup.id)) {
      list.push({ key: 'group:' + g.id, label: (g.name || '') + ' · ' + (t ? t('group') : '') });
    }
  }
  return list;
}

// Open the forward dialog: запоминает источник через setter (реактивность держится в App.vue).
export function startForward({ setForwardTo }, msg) {
  if (!msg) return;
  setForwardTo(msg);
}

// Forward: re-encrypt the text for the chosen chat with a "forwarded from" prefix.
export async function doForward({
  forwardTo, displayName, email, nameOf, activeChat, activeChatType,
  currentGroup, groupKeys, peerKeys, peerPqKeys, ephemeralTtlOf,
  buildEnvelope, setSending, setForwardTo, markPending, showToast, t,
}, key) {
  if (!forwardTo || !key) return;
  const msg = forwardTo;
  if (typeof setForwardTo === 'function') setForwardTo(null);
  const fromName = msg.from === 'me'
    ? (displayName || email)
    : (nameOf ? nameOf(activeChat) : null) || activeChat;
  const fwdText = (t ? (t('forwarded_from') || 'Переслано от') : 'Переслано от') + ' ' + fromName + '\n' + (msg.content || '');
  try {
    if (typeof setSending === 'function') setSending(true);
    const ttl = await ephemeralTtlOf(key);
    const envelope = await buildEnvelope(fwdText, ttl);
    const envelopeId = EnvelopeId.envelopeIdOf(envelope);
    const pendingMsg = {
      id: envelopeId || EnvelopeId.pendingIdOf(),
      content: fwdText,
      from: 'me',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ts: Date.now(), encrypted: true, vault: true, status: 'sending',
    };
    if (key.startsWith('group:')) {
      const gid = key.slice(6);
      const groupKey = (groupKeys || {})[gid];
      if (!groupKey) { if (t) alert(t('err_group_key')); return; }
      const content = await crypto.encryptWithGroupKey(envelope, groupKey);
      // envelopeObj: релей-дубль участникам (api.sendGroupMessage).
      // Объект конверта для релей-дубля — разбор в Rust (ADR-005 R1 / W4).
      const envObj = await WireSignalRule.envelopeObject(envelope);
      await api.sendGroupMessage(gid, content, envObj);
      pendingMsg.status = 'sent';
      if (typeof markPending === 'function') markPending(key, pendingMsg);
    } else {
      if (!(peerKeys || {})[key]) { if (t) alert(t('poll_err')); return; }
      crypto.setPeerPublicKey((peerKeys || {})[key], peerPqKeys && (peerPqKeys || {})[key]);
      const content = await crypto.encryptVault(envelope);
      await api.sendMessage(key, content);
      pendingMsg.status = 'sent';
      if (typeof markPending === 'function') markPending(key, pendingMsg);
    }
    if (typeof showToast === 'function') showToast(t ? (t('forward_done') || 'Переслано') : 'Переслано', 2500);
  } catch (e) {
    console.error('[forward] failed:', e);
    if (t) alert(t('forward_err') || 'Forward failed');
  } finally {
    if (typeof setSending === 'function') setSending(false);
  }
}
