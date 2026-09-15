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
// This module owns the pure logic (link build/parse, envelope payloads);
// persistence goes through the channels_* tauri commands, UI wiring lives
// in App.vue / a dedicated panel.

import { invoke } from '@tauri-apps/api/core';
import { db } from '../api.js';

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

// ── Router branch helper (called from features/incoming.js) ────
// Returns true when the decrypted group-envelope payload is a channel
// envelope, i.e. `channel:1` marker present. The router then treats it
// per type: post/meta/hello (see ingest below).

export function isChannelEnvelope(obj) {
  return !!(obj && typeof obj === 'object' && obj.channel === 1);
}

// Apply a channel envelope to app state. Returns a short kind string or
// null when nothing applied (bad envelope / unknown channel).
// ctx: { channels, channelById(id), noteChannelPost(id, ts), notifyChannel(...) }
export function ingestChannelEnvelope(ctx, payload, senderEmail) {
  if (!isChannelEnvelope(payload)) return null;
  const chId = payload.chan || '';
  const ch = ctx.channelById && ctx.channelById(chId);
  if (!ch) return null; // not subscribed to this channel — ignore
  if (payload.meta === 1) {
    // meta update from the owner (name/about/avatar)
    if (ch.is_owner) return 'meta-own'; // our own echo — nothing to apply
    updateChannel(chId, { name: payload.name, about: payload.about, owner_fpr: payload.owner_fpr })
      .catch(e => console.warn('[channels] meta apply:', e));
    return 'meta';
  }
  if (payload.post) {
    if (Date.now() - (Number(payload.ts) || 0) < 0) return null; // future-dated
    const ts = Math.min(Number(payload.ts) || Date.now(), Date.now());
    updateChannel(chId, { last_ts: ts }).catch(() => {});
    ctx.noteChannelPost && ctx.noteChannelPost(chId, ts, payload, senderEmail);
    return 'post';
  }
  if (payload.hello === 1) {
    // owner side: a subscriber said hello -> remember as known (email dup)
    if (ch.is_owner && senderEmail) {
      addKnownSubscriber(chId, senderEmail).catch(() => {});
      ctx.noteChannelHello && ctx.noteChannelHello(chId, senderEmail);
      return 'hello';
    }
    return null;
  }
  return null;
}
