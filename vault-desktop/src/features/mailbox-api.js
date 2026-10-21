// ADR-004 J.4: owner для mailbox API-методов (быв. App.vue this.* delegates).
// relay.js импортирует singleton напрямую — state-machine не зависит от App.ctx.
// Feature-modules получают в makeCtx() минимум, а не whole this. Lazy import
// через функции разрывает циклы (mailbox-api -> feature -> relay -> mailbox-api).
import { sessionStore, chatStore, mailboxStore, uiStore } from './session-store.js';
import api, { db } from '../api.js';

function IncomingFeature() { return import('./incoming.js'); }
function EmailsFeature() { return import('./emails.js'); }
function GroupsFeature() { return import('./groups.js'); }
function MessagesFeature() { return import('./messages.js'); }
function HistoryFeature() { return import('./history.js'); }
// ADR-004 Этап D: feature-модули получают зависимости от других feature через
// deps-инъекцию. Мост — единственное место, где их законно собрать (он и так
// lazy-импортит фичи, чтобы не создавать цикл mailbox-api → feature → relay →
// mailbox-api). Без deps incoming.js/messages.js падают на деструктуризации.
function BounceFeature() { return import('./bounce.js'); }
function ChannelsFeature() { return import('./channels.js'); }
function ContactsFeature() { return import('./contacts.js'); }

// Минимальный ctx-прокси: feature-модулю нужны только используемые поля.
function makeCtx() {
  return {
    email: sessionStore.getCurrentEmail(),
    isLoggedIn: sessionStore.state.isLoggedIn,
    emails: mailboxStore.state.emails,
    channels: mailboxStore.state.channels,
    activeChat: chatStore.state.activeChat,
    currentGroup: chatStore.state.currentGroup,
    activeChatType: chatStore.state.activeChatType,
    emailBodyCache: mailboxStore.state.emailBodyCache,
    cacheBody(key, body) { mailboxStore.cacheBody(key, body); },
    scrollToBottom(force = false) { return null; },
    // J.5b: inj через uiStore singleton (как relay.js делает напрямую).
    // Feature-модули читают uiStore.toast/uiStore.tr, а не App.ctx.this.*.
    showToast(message, ms) { uiStore.toast(message, ms); },
    t(key) { return uiStore.tr(key); },
    loadCursors: (id) => mailboxApi.loadCursors(id),
    saveCursors: (id, c) => mailboxApi.saveCursors(id, c),
  };
}

export const mailboxApi = {
  // ── cursors (kv db через api) ──
  async loadCursors(accountId) {
    if (api && typeof api.loadCursors === 'function') return api.loadCursors(accountId);
    return {};
  },
  async saveCursors(accountId, cursors) {
    if (api && typeof api.saveCursors === 'function') return api.saveCursors(accountId, cursors);
  },
  // ── incoming ──
  // ctx вызывающего ПРИОРИТЕТНЕЕ минимальной проекции: relay.js зовёт мост из
  // фоновых циклов (эко/релей/поллинг/IDLE-резерв) и уже держит живой ctx в
  // сигнатуре. Проекция makeCtx() неполна (62 из 72 ctx-полей, которые дёргают
  // фичи под мостом, в неё не входят) — с ней путь не падал, а МОЛЧА ничего не
  // делал (incoming.js:39 early-return по !ctx.cryptoReady). makeCtx() остаётся
  // fallback для вызова вовсе без ctx.
  // dep-сборка та же, что в App.vue (единственный владелец knows-how фич).
  async processIncoming(fetched, opts, ctx) {
    const [mod, bounce, channels] = await Promise.all([IncomingFeature(), BounceFeature(), ChannelsFeature()]);
    return mod.processIncoming(ctx || makeCtx(), fetched, opts, {
      isBounceMessage: bounce.isBounceMessage,
      bounceRecipients: bounce.bounceRecipients,
      bounceReason: bounce.bounceReason,
      ingestChannelEnvelope: channels.ingestChannelEnvelope,
    });
  },
  // ── loaders ──
  async loadMessages(email, ctx) {
    const [mod, contacts] = await Promise.all([MessagesFeature(), ContactsFeature()]);
    return mod.loadMessages(ctx || makeCtx(), email, {
      isOutboundLetter: contacts.isOutboundLetter,
      resolvePeerSender: contacts.resolvePeerSender,
      resolveEventSender: contacts.resolveEventSender,
      findKnownPeerByKey: contacts.findKnownPeerByKey,
    });
  },
  async loadGroups(ctx) { const mod = await GroupsFeature(); return mod.loadGroups(ctx || makeCtx()); },
  async loadEmails(silent = false, ctx) { const mod = await EmailsFeature(); return mod.loadEmails(ctx || makeCtx(), silent); },
  async loadGroupMessages(groupId, forceRescan = false, ctx) {
    const mod = await GroupsFeature();
    return mod.loadGroupMessages(ctx || makeCtx(), groupId, forceRescan);
  },
  // ── body cache (lazy HistoryFeature persist in SQLite) ──
  cacheBody(key, body) {
    HistoryFeature().then((h) => h.cacheBody({ state: { emailBodyCache: mailboxStore.state.emailBodyCache } }, key, body));
    mailboxStore.cacheBody(key, body);
  },
  // скролл (App.vue подменит через setScroller)
  scrollToBottom(force) { return null; },
  setScroller(fn) { mailboxApi.scrollToBottom = fn; },
};

