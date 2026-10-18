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
      this.state.emails = list || [];
      return this.state.emails;
    },
    mergeEmails(list) {
      const m = new Map(this.state.emails.map((m) => [m.uid + '|' + (m.folder || 'INBOX'), m]));
      for (const e of (list || [])) {
        if (!e) continue;
        m.set(e.uid + '|' + (e.folder || 'INBOX'), e);
      }
      this.state.emails = [...m.values()].sort((a, b) =>
        new Date(b.date || 0) - new Date(a.date || 0));
      return this.state.emails;
    },
    mergeEmail(one) { return this.mergeEmails([one]); },
    clearEmails() {
      this.state.emails = [];
      return this.state.emails;
    },
    emailCount() {
      return (this.state.emails || []).length;
    },
    // ── body cache ──
    cacheBody(key, body) {
      this.state.emailBodyCache[key] = body;
    },
    getEmailBody(key) {
      return this.state.emailBodyCache[key] ?? null;
    },
    clearBodyCache() {
      this.state.emailBodyCache = {};
    },
    // ── channels (mailing-list writers; channel*Unread/Avatars отдельно в channels-store.js, J.5d) ──
    setChannels(list) {
      this.state.channels = list || [];
      return this.state.channels;
    },
    // ── loading/error (J.3c) ──
    setEmailsLoading(flag) {
      this.state.emailsLoading = !!flag;
      return this.state.emailsLoading;
    },
    setEmailError(err) {
      this.state.emailError = err || '';
      return this.state.emailError;
    },
    reset() {
      this.state.emailsLoading = false;
      this.state.emailError = '';
    },
    hardReset() {
      this.state.emails = [];
      this.state.channels = [];
      this.state.emailBodyCache = {};
      this.state.emailsLoading = false;
      this.state.emailError = '';
    },
  };
}
export const mailboxState = createMailboxStore();
