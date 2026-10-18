// ADR-004 J.5a: owner для contacts state (быв. App.vue data this.contacts/contactAliases).
// relay.js/forward.js/calls.js читают через singleton, а не через App.ctx.
import { sessionStore } from './session-store.js';
import { loadContacts as _lc } from './contacts-load.js';

export function createContactsStore() {
  const state = {
    contacts: [],           // массив {email, public_key, ...}
    contactAliases: {},    // canonical email -> alias-список (istория чата не затирается)
    ignored: [],
    ignoredUsers: {},  // J.7: { email: ts } — быв. App.vue data this.ignoredUsers.
    // J.5a: green-dot presence (быв. App.vue data this.lastSeenMap).
    lastSeenMap: {},
  };
  return {
    state,
    async loadContacts(email) {
      const { contacts, contactAliases } = await _lc(email || sessionStore.getCurrentEmail());
      this.state.contacts = contacts || [];
      if (contactAliases) this.state.contactAliases = contactAliases;
      return { contacts: this.state.contacts, contactAliases: this.state.contactAliases };
    },
    reset() { this.state.contacts = []; this.state.contactAliases = {}; this.state.ignored = []; this.state.ignoredUsers = {}; this.state.lastSeenMap = {}; },
    // ── ignoredUsers ────────────────────────────────────────────────────
    setIgnored(map) { this.state.ignoredUsers = map || {}; return this.state.ignoredUsers; },
    clearIgnored() { this.state.ignoredUsers = {}; return this.state.ignoredUsers; },
    // ── lastSeenMap ────────────────────────────────────────────────────
    setLastSeen(email, ts) { this.state.lastSeenMap[email] = ts; return this.state.lastSeenMap; },
    getLastSeen(email) { return this.state.lastSeenMap[email] || 0; },
  };
}
export const contactsStore = createContactsStore();

