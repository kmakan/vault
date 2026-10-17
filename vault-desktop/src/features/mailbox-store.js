// ADR-004 J.2b+J.3c: canonical mailbox owner (singleton per app).
//
// Раньше было ДВА разных createMailboxStore(): J.2b в session-store.js
// (state.emails/channels/emailBodyCache + setEmails/mergeEmails/cacheBody)
// и J.3c здесь (state.emailsLoading/emailError). relay.js/mailbox-api.js
// писали в singleton из session-store.js, а App.vue читал через
// reactive(mailboxState) из mailbox-store.js (J.3c) — без state.emails/
// emailBodyCache/channels → this.emails.length === 0 падал с TypeError.
//
// Теперь — один owner: state.emails/channels/emailBodyCache (J.2b) +
// emailsLoading/emailError (J.3c); session-store.js ре-экспортирует
// этот singleton как mailboxStore, и все модули читают/пишут через него.
//
// zero-import: чистые методы, reactive() оборачивает корень в App.vue.
export function createMailboxStore() {
  const state = {
    emails: [],
    channels: [],
    emailBodyCache: {},
    emailsLoading: false,
    emailError: '',
  };
  return {
    state,
    // ── emails ──
    setEmails(list) {
      state.emails = list || [];
      return state.emails;
    },
    mergeEmails(list) {
      const m = new Map(state.emails.map((m) => [m.uid + '|' + (m.folder || 'INBOX'), m]));
      for (const e of (list || [])) {
        if (!e) continue;
        m.set(e.uid + '|' + (e.folder || 'INBOX'), e);
      }
      state.emails = [...m.values()].sort((a, b) =>
        new Date(b.date || 0) - new Date(a.date || 0));
      return state.emails;
    },
    mergeEmail(one) { return this.mergeEmails([one]); },
    clearEmails() {
      state.emails = [];
      return state.emails;
    },
    emailCount() {
      return (state.emails || []).length;
    },
    // ── body cache ──
    cacheBody(key, body) {
      state.emailBodyCache[key] = body;
    },
    getEmailBody(key) {
      return state.emailBodyCache[key] ?? null;
    },
    clearBodyCache() {
      state.emailBodyCache = {};
    },
    // ── channels (mailing-list writers; channel*Unread/Avatars отдельно в channels-store.js, J.5d) ──
    setChannels(list) {
      state.channels = list || [];
      return state.channels;
    },
    // ── loading/error (J.3c) ──
    setEmailsLoading(flag) {
      state.emailsLoading = !!flag;
      return state.emailsLoading;
    },
    setEmailError(err) {
      state.emailError = err || '';
      return state.emailError;
    },
    reset() {
      state.emailsLoading = false;
      state.emailError = '';
    },
    hardReset() {
      state.emails = [];
      state.channels = [];
      state.emailBodyCache = {};
      state.emailsLoading = false;
      state.emailError = '';
    },
  };
}
export const mailboxState = createMailboxStore();
