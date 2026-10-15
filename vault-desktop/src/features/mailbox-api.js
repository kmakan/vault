// ADR-004 J.4: owner для mailbox API-методов (быв. App.vue this.* delegates).
// relay.js импортирует singleton напрямую — state-machine не зависит от App.ctx.
// Feature-modules получают в makeCtx() минимум, а не whole this. Lazy import
// через функции разрывает циклы (mailbox-api -> feature -> relay -> mailbox-api).
import { sessionStore, chatStore, mailboxStore } from './session-store.js';
import api, { db } from '../api.js';

function IncomingFeature() { return import('./incoming.js'); }
function EmailsFeature() { return import('./emails.js'); }
function GroupsFeature() { return import('./groups.js'); }
function MessagesFeature() { return import('./messages.js'); }
function HistoryFeature() { return import('./history.js'); }

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
  async processIncoming(fetched, opts) {
    const mod = await IncomingFeature();
    return mod.processIncoming(makeCtx(), fetched, opts);
  },
  // ── loaders ──
  async loadMessages(email) { const mod = await MessagesFeature(); return mod.loadMessages(makeCtx(), email); },
  async loadGroups() { const mod = await GroupsFeature(); return mod.loadGroups(makeCtx()); },
  async loadEmails(silent = false) { const mod = await EmailsFeature(); return mod.loadEmails(makeCtx(), silent); },
  async loadGroupMessages(groupId, forceRescan = false) {
    const mod = await GroupsFeature();
    return mod.loadGroupMessages(makeCtx(), groupId, forceRescan);
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

