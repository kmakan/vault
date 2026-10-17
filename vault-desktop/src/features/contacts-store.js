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
      state.contacts = contacts || [];
      if (contactAliases) state.contactAliases = contactAliases;
      return { contacts: state.contacts, contactAliases: state.contactAliases };
    },
    reset() { state.contacts = []; state.contactAliases = {}; state.ignored = []; state.ignoredUsers = {}; state.lastSeenMap = {}; },
    // ── ignoredUsers ────────────────────────────────────────────────────
    setIgnored(map) { state.ignoredUsers = map || {}; return state.ignoredUsers; },
    clearIgnored() { state.ignoredUsers = {}; return state.ignoredUsers; },
    // ── lastSeenMap ────────────────────────────────────────────────────
    setLastSeen(email, ts) { state.lastSeenMap[email] = ts; return state.lastSeenMap; },
    getLastSeen(email) { return state.lastSeenMap[email] || 0; },
  };
}
export const contactsStore = createContactsStore();

