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
    // J.3a: профиль bio (быв. data this.myBio). SettingsPage :bio.
    myBio: '',
    // J.3a: auth state (быв. App.data restoringSession/loginLoading/loginError).
    restoringSession: false,
    loginLoading: false,
    loginError: '',
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
    // ── myBio ───────────────────────────────────────────────────────────
    setBio(bio) { state.myBio = bio || ''; return state.myBio; },
    getBio() { return state.myBio; },

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

// ADR-004 J.2b: owner для загруженных сообщений (быв. data this.emails).
export function createMailboxStore() {
  const state = {
    emails: [],
    channels: [],
    emailBodyCache: {},
  };
  return {
    state,
    setEmails(list) { state.emails = list || []; return state.emails; },
    mergeEmails(list) {
      const m = new Map(state.emails.map((m) => [m.uid + "|" + (m.folder || "INBOX"), m]));
      for (const e of (list || [])) m.set(e.uid + "|" + (e.folder || "INBOX"), e);
      state.emails = [...m.values()].sort((a, b) =>
        new Date(b.date || 0) - new Date(a.date || 0));
      return state.emails;
    },
    clearEmails() { state.emails = []; return state.emails; },
    cacheBody(key, body) { state.emailBodyCache[key] = body; },
    getEmailBody(key) { return state.emailBodyCache[key] ?? null; },
    clearBodyCache() { state.emailBodyCache = {}; },
  };
}
export const mailboxStore = createMailboxStore();

// ADR-004 J.3b: owner для UI-утилит (i18n t + showToast — часто-используемые
// delegates в relay.js/calls.js). Вынос из ctx.* в singleton, чтобы state-machine
// не зависел от App.vue data-methods (ctx-coupling: 3× t, 3× showToast в relay.js).
export function createUiStore() {
  let t = (k) => k;
  let showToast = () => {};
  let searchQuery = '';
  // J.5b: form-state (newChannel*/newGroup*) вынесен из App.data в uiStore.
  const formState = {
    newChannelName: '',
    newChannelAbout: '',
    joinChannelLink: '',
    newGroupName: '',
    newGroupAvatar: '',
    // J.7: recovery-form + add-member-form fields inj форм-владельцу uiStore.
    recoveryWordsInput: '',
    recoveryFileJson: '',
    recoveryFileName: '',
    addMemberQuery: '',
    addMemberSelected: [],
    invitePopupIndex: 0,
    contactPopupIndex: 0,
    // J.7: chat-search-form inj uiStore.formState.
    chatSearchQuery: '',
    // J.7: login/server-form fields inj форм-владельцу uiStore.formState.
    rememberMe: true,
    imapServer: '',
    imapPort: '',
    smtpServer: '',
    smtpPort: '',
    mailProvider: '',
  };
  // J.5b: UI toggle flags вынесены из App.data в uiStore.modalFlags.
  const modalFlags = {
    showChannelPanel: false,
    showCreateChannel: false,
    showJoinChannel: false,
    postingChannel: false,
    showKeyManager: false,
    showQRCode: false,
    showCipher: false,
    showEphemeralMenu: false,
    showArchived: false,
    showServerSettings: false,
    showRecovery: false,
    showGroupSettings: false,
    showInvitePopup: false,
    showContactPopup: false,
    showAddMemberPopup: false,
    showMembersList: false,
    showCreateGroup: false,
    showEmojiPicker: false,
    showSettings: false,
    showMembers: false,
    showChatSearch: false,
  };
  let toastMessage = '';
  let toastTimer = null;
  return {
    setT(fn) { t = fn; },
    getT() { return t; },
    setShowToast(fn) { showToast = fn; },
    getToast() { return showToast; },
    // J.5b: searchQuery-form state вынесен из App.data в uiStore.
    setSearchQuery(v) { searchQuery = v ?? ''; },
    getSearchQuery() { return searchQuery; },
    setFormField(k, v) { formState[k] = v ?? ''; return formState[k]; },
    getFormField(k) { return formState[k]; },
    resetForm() { for (const k of Object.keys(formState)) formState[k] = ''; },
    setModal(name, v) { modalFlags[name] = !!v; return modalFlags[name]; },
    getModal(name) { return !!modalFlags[name]; },
    resetModals() { for (const k of Object.keys(modalFlags)) modalFlags[k] = false; },
    setToastMessage(v) { toastMessage = v ?? ''; },
    getToastMessage() { return toastMessage; },
    setToastTimer(t) { toastTimer = t; },
    getToastTimer() { return toastTimer; },
    clearToast() { toastMessage = ''; if (toastTimer) clearTimeout(toastTimer); toastTimer = null; },
    // удобный прокси для шаблонов/модулей без App-ctx
    tr(key) { return t(key); },
    toast(msg, ms) { showToast(msg, ms); },
  };
}
export const uiStore = createUiStore();

// ADR-004 J.3a: owner для UI-чата (быв. data this.activeChat/currentGroup/
// activeChatType в App.vue). relay.js/calls.js читают через singleton.
export function createChatStore() {
  const state = {
    activeChat: null,
    currentGroup: null,
    activeChatType: 'chat',
  };
  return {
    state,
    setActiveChat(v) { state.activeChat = v ?? null; return state.activeChat; },
    setCurrentGroup(g) { state.currentGroup = g ?? null; return state.currentGroup; },
    setActiveChatType(t) { state.activeChatType = t; return state.activeChatType; },
  };
}
export const chatStore = createChatStore();
export const sessionStore = createSessionStore();
export function useSessionStore() { return sessionStore; }
