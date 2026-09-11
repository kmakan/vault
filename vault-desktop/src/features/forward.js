// Feature module: forward (пересылка сообщений). Stage 1 of the App.vue
// decomposition — pure functions receive the component instance as `ctx`
// instead of `this`, so every dependency is explicit and testable in
// isolation. Stage 2 will move the template + dialog into ForwardDialog.vue.

import api from '../api.js';
import crypto from '../crypto.js';

// Targets for forwarding: contacts + groups, excluding the current chat.
export function forwardTargets(ctx) {
  const list = [];
  for (const c of ctx.contacts || []) {
    if (c.email && c.email !== '__notes__' && c.email !== ctx.activeChat) {
      list.push({ key: c.email, label: ctx.nameOf(c.email) || c.email });
    }
  }
  for (const g of ctx.groups || []) {
    if (!(ctx.activeChatType === 'group' && ctx.currentGroup && g.id === ctx.currentGroup.id)) {
      list.push({ key: 'group:' + g.id, label: (g.name || '') + ' · ' + ctx.t('group') });
    }
  }
  return list;
}

// Open the forward dialog: remember the source message.
export function startForward(ctx, msg) {
  if (!msg) return;
  ctx.forwardTo = msg;
}

// Forward: re-encrypt the text for the chosen chat with a "forwarded from"
// prefix (FWD marks survive as plain text in the new envelope).
export async function doForward(ctx, key) {
  const msg = ctx.forwardTo;
  ctx.forwardTo = null;
  if (!msg || !key) return;
  const fromName = msg.from === 'me'
    ? (ctx.displayName || ctx.email)
    : (ctx.nameOf(ctx.activeChat) || ctx.activeChat);
  const fwdText = (ctx.t('forwarded_from') || 'Переслано от') + ' ' + fromName + '\n' + (msg.content || '');
  try {
    ctx.sending = true;
    const ttl = await ctx.ephemeralTtlOf(key);
    const envelope = await ctx.buildEnvelope(fwdText, ttl);
    const envelopeId = (() => { try { return JSON.parse(envelope).id; } catch (e) { return ''; } })();
    const pendingMsg = {
      id: envelopeId || ('local-' + Date.now()),
      content: fwdText,
      from: 'me',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ts: Date.now(), encrypted: true, vault: true, status: 'sending',
    };
    if (key.startsWith('group:')) {
      const gid = key.slice(6);
      const groupKey = ctx.groupKeys[gid];
      if (!groupKey) { alert(ctx.t('err_group_key')); return; }
      const content = await crypto.encryptWithGroupKey(envelope, groupKey);
      await api.sendGroupMessage(gid, content);
      pendingMsg.status = 'sent';
      ctx.markPending(key, pendingMsg);
    } else {
      if (!ctx.peerKeys[key]) { alert(ctx.t('poll_err')); return; }
      crypto.setPeerPublicKey(ctx.peerKeys[key], ctx.peerPqKeys && ctx.peerPqKeys[key]);
      const content = await crypto.encryptVault(envelope);
      await api.sendMessage(key, content);
      pendingMsg.status = 'sent';
      ctx.markPending(key, pendingMsg);
    }
    ctx.showToast(ctx.t('forward_done') || 'Переслано', 2500);
  } catch (e) {
    console.error('[forward] failed:', e);
    alert(ctx.t('forward_err') || 'Forward failed');
  } finally {
    ctx.sending = false;
  }
}
