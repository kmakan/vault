// Feature module: channels (M2, t_m2_channels).
// Broadcast channels by the Delta Chat pattern — see
// docs/design/channels-protocol.md. A channel is a specialized group:
// chn_ id, one emitter (the owner), read-only subscribers that join via a
// QR link and never reveal their address. Delivery: relay fan-out (write
// token per channel) + email duplicate to KNOWN subscribers only (hello
// opt-in, cap 50). Post/meta payloads travel in the same E2E group
// envelope (XChaCha20-Poly1305, AAD="VAULT", empty stealth subject);
// the receiver's router branches on the `channel:1` payload marker.
//
// This module owns the pure logic (link build/parse, envelope payloads) and,
// since ADR-005 W3 (batch 2), the UI orchestration (select/send/create/join/
// rename/delete) — App.vue is left with calls only. Persistence goes through
// the channels_* tauri commands; the state lives in the owners (mailbox-store:
// the channel list, channels-store: posts/counters/avatars, uiStore: forms
// and modals, chatStore: the active chat).

import { invoke } from '@tauri-apps/api/core';
import { db } from '../api.js';
import crypto from '../crypto.js';
import { accountNamespace } from '../identity.js';
import * as MsgFormat from '../message-format.js';
import { uiStore, chatStore, sessionStore } from './session-store.js';
import { channelsStore } from './channels-store.js';
import { mailboxState } from './mailbox-store.js';

// Id helper: window.crypto — NOT the imported crypto module (App.vue pattern).
function newId(prefix) {
  try {
    if (window.crypto && window.crypto.randomUUID) return prefix + window.crypto.randomUUID();
  } catch (e) { /* fallback below */ }
  return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ── Persistence wrappers (tauri channels.rs) ──────────────────

export async function loadChannels() {
  try { return await invoke('channels_load') || []; } catch (e) { console.warn('[channels] load:', e); return []; }
}
export async function createChannel(name, about, ownerEmail, ownerFpr) {
  // owner_fpr — our fingerprint: identifies the emitter for subscribers.
  return await invoke('channels_create', {
    name, owner: ownerEmail || '', ownerFpr: ownerFpr || '', about: about || ''
  });
}
export async function importChannel(id, name, key, owner, ownerFpr) {
  return await invoke('channels_import', { channelId: id, name, key, owner, ownerFpr });
}
export async function updateChannel(id, patch) {
  // snake_case keys mirror the Rust ChannelPatch struct
  return await invoke('channels_update', { channelId: id, patch });
}
export async function addKnownSubscriber(id, email) {
  return await invoke('channels_add_known_subscriber', { channelId: id, email });
}
export async function deleteChannel(id) {
  return await invoke('channels_delete', { channelId: id });
}

// ── Join link (vault://join-channel) ──────────────────────────
// Build: owner side (share QR / text link).
// Parse: subscriber side (paste or QR scan) — returns null on bad input.

export function buildJoinLink(ch) {
  const n = encodeURIComponent(ch.name || '');
  return `vault://join-channel?c=${encodeURIComponent(ch.id)}&k=${encodeURIComponent(ch.key)}&n=${n}&o=${encodeURIComponent(ch.owner_fpr || '')}`;
}

export function parseJoinLink(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim();
  // Accept both the bare scheme and a fully wrapped QR JSON (future-proof:
  // camera scan may deliver either).
  let url = s;
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && j.type === 'vault-channel' && j.link) url = j.link;
      else return null;
    } catch { return null; }
  }
  if (!url.startsWith('vault://join-channel')) return null;
  try {
    const q = url.slice('vault://join-channel?'.length);
    const params = {};
    for (const pair of q.split('&')) {
      const [k, v] = pair.split('=');
      if (!k) continue;
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    const id = params.c || '';
    const key = params.k || '';
    if (!id.startsWith('chn_')) return null;
    if (!/^[0-9a-f]{64}$/i.test(key)) return null;
    return {
      id,
      key,
      name: params.n || '',
      ownerFpr: params.o || '',
      owner: '' // link carries no owner email by design (privacy)
    };
  } catch { return null; }
}

// ── Envelope payloads (wire format §3.2/§3.3 of the design doc) ──

export function buildPostPayload(channelId, body, images) {
  return JSON.stringify({
    channel: 1,
    chan: channelId,
    id: newId('post_'),
    ts: Date.now(),
    post: { body: String(body || ''), images: Array.isArray(images) ? images.slice(0, 3) : [] },
    meta: false
  });
}

export function buildMetaPayload(channel, keyVersion) {
  return JSON.stringify({
    channel: 1,
    chan: channel.id,
    meta: 1,
    id: newId('meta_'),
    ts: Date.now(),
    name: channel.name || '',
    about: channel.about || '',
    avatar: (channel.avatar || ''),
    key_version: keyVersion || channel.key_version || 1
  });
}

export function buildHelloPayload(channelId) {
  // Opt-in "I subscribe" notice to the channel owner (encrypted 1:1 on the
  // owner's pubkey — the subscriber must have it, QR carries the fpr).
  return JSON.stringify({ channel: 1, chan: channelId, hello: 1, id: newId('hello_'), ts: Date.now() });
}

// Owner-side meta publish (t_09bf424a): name/about/avatar updates travel
// as a meta-конверт — same relay queue + email dup as posts.
export async function sendChannelMeta(ch, account) {
  const payload = buildMetaPayload(ch, ch.key_version || 1);
  const content = await (await import('../crypto.js')).default.encryptWithGroupKey(payload, ch.key);
  return sendChannelPost(ch, content, JSON.parse(payload), account);
}

// Owner-side post dispatch (t_4455b0dc): relay pub (write-scoped channel
// token, ONE store for all subscribers) + email duplicate to the opt-in
// known-subscriber list (cap 50, group mechanics). Throws only when every
// path failed — the caller (UI) shows the standard delivery badge.
export async function sendChannelPost(ch, content, envelopeObj, account) {
  const { relayChannelPublish } = await import('../relay-client.js');
  const api = (await import('../api.js')).default;
  let relayOk = false, mailSent = 0, mailFail = 0;
  try {
    relayOk = (await relayChannelPublish(ch, envelopeObj, content, account)).ok;
  } catch (e) { console.warn('[channels] relay pub:', e); }
  const targets = (ch.known_subscribers || []).slice(0, 50);
  for (const email of targets) {
    try {
      await api.sendEmail('local', { to: email, subject: '', body: content });
      mailSent++;
    } catch (e) {
      mailFail++;
      console.error(`[channels] email dup to ${email}:`, e);
    }
  }
  if (!relayOk && !mailSent && targets.length) throw new Error('post not delivered');
  return { relayOk, mailSent, mailFail };
}

// ── Router branch helper (called from features/incoming.js) ────
// Returns true when the decrypted group-envelope payload is a channel
// envelope, i.e. `channel:1` marker present. The router then treats it
// per type: post/meta/hello (see ingest below).

// Проверка «это канальное письмо» больше не нужна в JS: её делает ядро
// (vault::channels::parse_channel_envelope, ADR-005 R1 / W4). Разбор в двух
// местах — значит правило может разойтись; раньше так и вышло: роутер в
// incoming.js и проверка здесь.

// Apply a channel envelope to app state. Returns a short kind string or
// null when nothing applied (bad envelope / unknown channel).
// ADR-005 W2 (`t_bcb8927a`), партия 13: вместо ctx — узкий контракт deps
// (channelById/noteChannelPost/noteChannelHello).
export function ingestChannelEnvelope(deps, payload, senderEmail) {
  // ФОРМАТ — В RUST (ADR-005 R1 / W4): payload приходит уже разобранным
  // (vault::channels::parse_channel_envelope). null = это не канал.
  if (!payload) return null;
  const chId = payload.chan || '';
  const ch = deps.channelById && deps.channelById(chId);
  if (!ch) return null; // not subscribed to this channel — ignore
  if (payload.is_meta) {
    // meta update from the owner (name/about/avatar)
    if (ch.is_owner) return 'meta-own'; // our own echo — nothing to apply
    if (payload.avatar) db.kvSet('anon', 'channel-avatar:' + chId, payload.avatar).catch(() => {});
    // мгновенный UI: тот же объект ch живёт в ctx.channels (Vue реактивен)
    if (payload.name) ch.name = payload.name;
    if (payload.about !== undefined) ch.about = payload.about;
    if (payload.owner_fpr) ch.owner_fpr = payload.owner_fpr;
    updateChannel(chId, { name: payload.name, about: payload.about, owner_fpr: payload.owner_fpr })
      .catch(e => console.warn('[channels] meta apply:', e));
    return 'meta';
  }
  if (payload.has_post) {
    if (Date.now() - (Number(payload.ts) || 0) < 0) return null; // future-dated
    const ts = Math.min(Number(payload.ts) || Date.now(), Date.now());
    updateChannel(chId, { last_ts: ts }).catch(() => {});
    deps.noteChannelPost && deps.noteChannelPost(chId, ts, payload, senderEmail);
    return 'post';
  }
  if (payload.is_hello) {
    // owner side: a subscriber said hello -> remember as known (email dup)
    if (ch.is_owner && senderEmail) {
      addKnownSubscriber(chId, senderEmail).catch(() => {});
      deps.noteChannelHello && deps.noteChannelHello(chId, senderEmail);
      return 'hello';
    }
    return null;
  }
  return null;
}

// ── UI-оркестрация каналов (ADR-005 W3, партия 2) ────────────────────────
// Логика ушла из App.vue (было 13 методов с логикой). Состояние — у
// владельцев: список каналов — mailbox-store, посты/счётчики/аватары/активный
// канал — channels-store, формы и модалки — uiStore, активный чат — chatStore.
// Эффекты, которых не знает модуль, — в deps: per-app владелец чата, DOM,
// ввод (confirm/prompt/clipboard) и счётчик загрузки.
//
// deps: { chat, saveDraft, cancelReply, openMobileChat, setShowStarredOnly,
//         bumpLoadSeq, fingerprint, confirm, prompt, writeClipboard, closeChatMenu }

export function channelPostsToMessages(ch) {
  // kv-лог постов → формат MessageItem (own = наш пост/эхо).
  const posts = channelsStore.state.channelPosts[ch.id] || [];
  const myEmail = sessionStore.getCurrentEmail();
  return posts.map(p => ({
    id: p.id || ('post-' + p.ts),
    content: p.body || '',
    from: (p.sender && p.sender === (ch.owner || myEmail)) || (!p.sender && ch.is_owner) ? 'me' : p.sender,
    sender_id: p.sender || ch.owner || '',
    time: MsgFormat.formatTimeLabel(p.ts),
    ts: p.ts,
    encrypted: true,
    vault: true,
  }));
}

export async function selectChannel(ch, deps) {
  deps.saveDraft();
  deps.chat.set([]);
  deps.chat.setDraft('');
  deps.cancelReply();
  chatStore.setActiveChat('channel:' + ch.id);
  chatStore.setActiveChatType('channel');
  channelsStore.setCurrentChannel(ch);
  chatStore.setCurrentGroup(null);
  deps.setShowStarredOnly(false);
  deps.bumpLoadSeq();
  deps.chat.set(channelPostsToMessages(ch));
  channelsStore.setUnread(ch.id, 0); // канал открыт — сбрасываем счётчик
  // last_ts монотонный (Rust-гейт): пишем максимум visible-постов,
  // иначе последующие непрочитанные перестанут считаться.
  const maxTs = (channelsStore.state.channelPosts[ch.id] || []).reduce((m, p) => Math.max(m, p.ts || 0), 0);
  if (maxTs) updateChannel(ch.id, { last_ts: maxTs }).catch(() => {});
  deps.openMobileChat();
  await deps.nextTick();
  uiStore.scrollToBottom(true);
}

// Список каналов + локальные посты/счётчики/аватары (бывший App.vue loadChannels).
export async function syncChannels(deps) {
  try {
    const list = await loadChannels();
    mailboxState.state.channels = list;
    // last_ts > 0 у подписчика = есть непрочитанное (считаем по post-логу kv)
    const ns = await accountNamespace(sessionStore.getCurrentEmail());
    for (const ch of list) {
      const posts = JSON.parse((await db.kvGet(ns, 'channel-posts:' + ch.id)) || '[]');
      channelsStore.setChannelPosts(ch.id, posts);
      channelsStore.setUnread(ch.id, posts.filter(p => p.ts > (ch.last_ts || 0)).length);
      channelsStore.setChannelAvatar(ch.id, (await db.kvGet('anon', 'channel-avatar:' + ch.id)) || '');
    }
  } catch (e) { console.error('Failed to load channels:', e); }
}

export async function createChannelAndClose(deps) {
  const name = String(uiStore.getFormField('newChannelName') || '').trim();
  const about = String(uiStore.getFormField('newChannelAbout') || '').trim();
  if (!name || uiStore.getModal('postingChannel')) return;
  uiStore.setModal('postingChannel', true);
  try {
    const ch = await createChannel(name, about, sessionStore.getCurrentEmail() || '', deps.fingerprint() || '');
    await syncChannels(deps);
    uiStore.setModal('showCreateChannel', false);
    uiStore.setFormField('newChannelName', '');
    uiStore.setFormField('newChannelAbout', '');
    const fresh = (mailboxState.state.channels || []).find(c => c.id === ch.id) || ch;
    await selectChannel(fresh, deps);
    uiStore.toast(uiStore.tr('channel_created') || 'Канал создан — поделитесь ссылкой', 4000);
  } catch (e) {
    console.error('[channels] create:', e);
    uiStore.toast(uiStore.tr('channel_create_failed') || 'Не удалось создать канал', 3000);
  } finally { uiStore.setModal('postingChannel', false); }
}

export async function joinChannelAndClose(deps) {
  const parsed = parseJoinLink(String(uiStore.getFormField('joinChannelLink') || '').trim());
  if (!parsed) {
    uiStore.toast(uiStore.tr('channel_join_bad_link') || 'Ссылка канала не распознана', 3000);
    return;
  }
  try {
    await importChannel(parsed.id, parsed.name, parsed.key, parsed.owner, parsed.ownerFpr);
    await syncChannels(deps);
    uiStore.setModal('showJoinChannel', false);
    uiStore.setFormField('joinChannelLink', '');
    const ch = (mailboxState.state.channels || []).find(c => c.id === parsed.id);
    if (ch) await selectChannel(ch, deps);
  } catch (e) {
    console.error('[channels] join:', e);
    uiStore.toast(uiStore.tr('channel_join_failed') || 'Не удалось подписаться', 3000);
  }
}

export function copyChannelLink(deps) {
  const ch = channelsStore.state.currentChannel;
  if (!ch) return;
  const link = buildJoinLink(ch);
  try {
    deps.writeClipboard(link);
    uiStore.toast(uiStore.tr('channel_link_copied') || 'Ссылка на канал скопирована', 2500);
  } catch (e) { console.warn('[channels] clipboard:', e); }
}

export function copyChannelLinkById(deps, id) {
  const ch = channelById(id);
  deps.closeChatMenu();
  if (!ch) return;
  try {
    deps.writeClipboard(buildJoinLink(ch));
    uiStore.toast(uiStore.tr('channel_link_copied') || 'Ссылка на канал скопирована', 2500);
  } catch (e) { console.warn('[channels] clipboard:', e); }
}

// Публикация поста в канал (UI-часть; протокол — sendChannelPost ниже).
export async function publishChannelPost(deps) {
  const ch = channelsStore.state.currentChannel;
  const text = String(deps.chat.state.newMessage || '').trim();
  if (!ch || !ch.is_owner || !text || uiStore.getModal('postingChannel')) return;
  uiStore.setModal('postingChannel', true);
  try {
    const payload = buildPostPayload(ch.id, text, []);
    const content = await crypto.encryptWithGroupKey(payload, ch.key);
    const env = JSON.parse(payload);
    // optimistic local (владельческое эхо-письмо может и не вернуться)
    noteChannelPost(ch.id, env.ts, env, sessionStore.getCurrentEmail());
    channelsStore.setUnread(ch.id, 0); // собственный пост — не «непрочитанное»
    deps.chat.set(channelPostsToMessages(ch));
    deps.chat.setDraft('');
    await deps.nextTick();
    uiStore.scrollToBottom(true);
    const res = await sendChannelPost(ch, content, env, sessionStore.getCurrentEmail());
    updateChannel(ch.id, { last_ts: env.ts }).catch(() => {});
    if (!res.relayOk && res.mailSent === 0 && (ch.known_subscribers || []).length) {
      uiStore.toast(uiStore.tr('channel_post_email_only') || 'Релей недоступен — пост ушёл только известным подписчикам', 4000);
    }
  } catch (e) {
    console.error('[channels] post:', e);
    uiStore.toast(uiStore.tr('channel_post_failed') || 'Пост не отправлен', 3000);
  } finally { uiStore.setModal('postingChannel', false); }
}

export async function deleteChannelConfirmed(deps) {
  const menu = uiStore.getFormField('chatMenu');
  const t2 = menu && menu.target;
  if (!t2 || t2.type !== 'channel') return;
  if (!deps.confirm(uiStore.tr('channel_delete_confirm') || 'Удалить канал и всю его локальную историю?')) return;
  deps.closeChatMenu();
  try {
    await deleteChannel(t2.id);
    if (chatStore.state.activeChat === 'channel:' + t2.id) {
      chatStore.setActiveChat('');
      chatStore.setActiveChatType('chat');
      channelsStore.setCurrentChannel(null);
      deps.chat.set([]);
    }
    await syncChannels(deps);
  } catch (e) { console.error('[channels] delete:', e); }
}

export async function renameChannel(deps, id) {
  const ch = channelById(id);
  deps.closeChatMenu();
  if (!ch || !ch.is_owner) return;
  const name = deps.prompt(uiStore.tr('channel_rename_prompt') || 'Новое название канала', ch.name || '');
  if (!name || !name.trim() || name.trim() === ch.name) return;
  ch.name = name.trim();
  try {
    await updateChannel(id, { name: ch.name });
    const res = await sendChannelMeta(ch, sessionStore.getCurrentEmail());
    if (!res.relayOk && res.mailSent === 0 && (ch.known_subscribers || []).length) {
      uiStore.toast(uiStore.tr('channel_post_email_only') || 'Релей недоступен — пост ушёл только известным подписчикам', 4000);
    }
  } catch (e) { console.error('[channels] rename:', e); }
}

export function channelById(id) {
  return (mailboxState.state.channels || []).find(c => c.id === id) || null;
}

export function noteChannelPost(chId, ts, payload, senderEmail) {
  const ch = channelById(chId);
  if (!ch) return;
  const posts = channelsStore.state.channelPosts[chId] || [];
  const body = (payload && payload.post_body) || '';
  const images = (payload && payload.post_images) || [];
  if (posts.some(p => p.id === payload.id)) return; // дедуп post.id
  posts.push({ id: payload.id, ts, body, images, sender: senderEmail || '' });
  posts.sort((a, b) => a.ts - b.ts);
  channelsStore.setChannelPosts(chId, posts.slice(-200)); // локальный лог компактный
  channelsStore.setUnread(chId, (channelsStore.state.channelUnread[chId] || 0) + 1);
  accountNamespace(sessionStore.getCurrentEmail()).then(ns =>
    db.kvSet(ns, 'channel-posts:' + chId, JSON.stringify(channelsStore.state.channelPosts[chId])).catch(() => {})
  );
}

export function noteChannelHello(chId, senderEmail) {
  console.log('[channel] hello from', senderEmail, '→ chan', chId);
}
