// ADR-004 J.3c: owner для emails-loading state (быв. App.vue data
// emailsLoading/emailError; emails.js читает/пишет через ctx.* —
// вынесено в singleton, чтобы ctx.route через computed proxy).
// zero-import: нет зависимостей.
export function createMailboxStore() {
  const state = {
    emailsLoading: false,
    emailError: '',
  };
  return {
    state,
    setEmailsLoading(flag) { state.emailsLoading = !!flag; return state.emailsLoading; },
    setEmailError(err) { state.emailError = err || ''; return state.emailError; },
    reset() {
      state.emailsLoading = false;
      state.emailError = '';
    },
  };
}
export const mailboxState = createMailboxStore();
