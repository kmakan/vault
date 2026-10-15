// Модуль-владелец сессионного состояния (ADR-004, Этап A12).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ, КОГДА isLoggedIn/emails УЖЕ ЕСТЬ В App.vue.
//
// isLoggedIn пишут 2 модуля (duress, recovery), emails — 1 (emails.js), но
// оба свойства читают ~6 модулей напрямую через ctx. Любая правка в data()
// App.vue (например, this.isLoggedIn = true в recovery) может породить race:
// duress сбрасывает флаг в logout, а recovery уже начал инициализировать
// крипто-материал — и оба пишут в одно поле, не зная друг о друге.
//
// До A12 isLoggedIn/emails жили в ctx как data() поля. ctx — транспорт для
// этого канала. Владелец централизует: все writes → ctx.login()/ctx.logout()/
// ctx.setEmails(), а читатели идут через proxy (this.isLoggedIn getter).
//
// ПОЧЕМУ ЗДЕСЬ НЕТ ИМПОРТА VUE — см. chat-store.js (ADR-004 A1), тот же
// принцип: framework-agnostic, reactive() наворачивает корень App.vue.
//
// Создаётся один раз на приложение (в композиционном корне App.vue).
export function createSessionStore() {
  const state = {
    isLoggedIn: false,
    currentEmail: '',    // J.2: account identity (бывш. data this.email)
    emails: [],
  };

  return {
    state,

    // ── isLoggedIn ────────────────────────────────────────────────────────
    login() {
      state.isLoggedIn = true;
      return state.isLoggedIn;
    },
    logout() {
      state.isLoggedIn = false;
      return state.isLoggedIn;
    },
    is() {
      return state.isLoggedIn;
    },

    // ── currentEmail ────────────────────────────────────────────────────
    setCurrentEmail(e) { state.currentEmail = e || ''; return state.currentEmail; },
    getCurrentEmail() { return state.currentEmail; },

    // ── emails ────────────────────────────────────────────────────────────
    setEmails(list) {
      state.emails = list || [];
      return state.emails;
    },
    clearEmails() {
      state.emails = [];
      return state.emails;
    },
    emailCount() {
      return (state.emails || []).length;
    },
  };
}

// ADR-004 J.2b: owner для загруженных сообщений (быв. data this.emails +
// emailBodyCache). relay.js пишет через singleton; App.vue читает через
// reactive proxy тот же объект.
export function createMailboxStore() {
  const state = {
    emails: [],
    emailBodyCache: {},
  };
  return {
    state,
    setEmails(list) { state.emails = list || []; return state.emails; },
    mergeEmails(list) {
      const m = new Map(state.emails.map((m) => [m.uid + '|' + (m.folder || 'INBOX'), m]));
      for (const e of (list || [])) m.set(e.uid + '|' + (e.folder || 'INBOX'), e);
      state.emails = [...m.values()].sort((a, b) =>
        new Date(b.date || 0) - new Date(a.date || 0));
      return state.emails;
    },
    clearEmails() { state.emails = []; return state.emails; },
    cacheBody(key, body) { state.emailBodyCache[key] = body; },
    getEmailBody(key) { return state.emailBodyCache[key] ?? null; },
  };
}
export const mailboxStore = createMailboxStore();
export const sessionStore = createSessionStore();
export function useSessionStore() { return sessionStore; }
