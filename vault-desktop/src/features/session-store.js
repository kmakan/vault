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
    password: '',        // J.7: account password (бывш. data this.password). recovery.js читает через proxy → sessionStore.
    // emails/channels/emailBodyCache/setEmails/mergeEmails/cacheBody — в mailbox-store.js (J.2b+J.3c).
    // J.3a: профиль bio (быв. data this.myBio). SettingsPage :bio.
    myBio: '',
    // J.3a: auth state (быв. App.data restoringSession/loginLoading/loginError).
    restoringSession: false,
    loginLoading: false,
    loginError: '',
    // J.7: UI constants (быв. App.data quickReactions).
    quickReactions: ['👍', '❤️', '😂', '😮', '😢', '🔥', '✅', '👀'],
  };

  return {
    state,

    // ── isLoggedIn ────────────────────────────────────────────────────────
    login() {
      this.state.isLoggedIn = true;
      return this.state.isLoggedIn;
    },
    logout() {
      this.state.isLoggedIn = false;
      return this.state.isLoggedIn;
    },
    is() {
      return this.state.isLoggedIn;
    },

    // ── currentEmail ────────────────────────────────────────────────────
    setCurrentEmail(e) { this.state.currentEmail = e || ''; return this.state.currentEmail; },
    getCurrentEmail() { return this.state.currentEmail; },
    // ── password ────────────────────────────────────────────────────────
    // J.7: быв. App.vue data this.password. recovery.js читает ctx.password —
    // owner-посредник делает это явным deps-параметром (не ctx-данный field).
    setPassword(p) { this.state.password = p || ''; return this.state.password; },
    getPassword() { return this.state.password; },
    clearPassword() { this.state.password = ''; return this.state.password; },
    // ── myBio ───────────────────────────────────────────────────────────
    setBio(bio) { this.state.myBio = bio || ''; return this.state.myBio; },
    getBio() { return this.state.myBio; },

  };
}

// ADR-004 J.2b+J.3c: mailbox owner (state.emails/channels/emailBodyCache
// + emailsLoading/emailError + setEmails/mergeEmails/cacheBody) живёт в
// mailbox-store.js (zero-import, как J.3c требовал). session-store.js
// ре-экспортирует singleton как mailboxStore — relay.js/mailbox-api.js
// (import { mailboxStore } from './features/session-store.js') читают и пишут
// в один и тот же объект, синхронно с reactive(mailboxState) в App.vue
// (App.vue:969 import { mailboxState } из mailbox-store.js).
export { createMailboxStore, mailboxState as mailboxStore } from './mailbox-store.js';

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
    showJumpToBottom: false,
  };
  let toastMessage = '';
  let toastTimer = null;
  let scrollToBottom = () => {};
  let _onMessagesScroll = () => {};
  let _jumpToBottom = () => {};
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
    // J.5b: скролл-callback'и — App.vue передаёт стрелки (refs/DOM неизвестны
    // модулю), фичи берут через uiStore.scrollToBottom/onMessagesScroll.
    setScrollToBottom(fn) { scrollToBottom = fn || (() => {}); },
    getScrollToBottom() { return scrollToBottom; },
    setScrollCallbacks({ scrollToBottom, onMessagesScroll, jumpToBottom } = {}) {
      if (scrollToBottom) this.setScrollToBottom(scrollToBottom);
      if (onMessagesScroll) this._onMessagesScroll = onMessagesScroll;
      if (jumpToBottom) this._jumpToBottom = jumpToBottom;
    },
    scrollToBottom(force = false) { (scrollToBottom || (() => {}))(force); },
    onMessagesScroll() { (this._onMessagesScroll || (() => {}))(); },
    jumpToBottom() { (this._jumpToBottom || (() => {}))(); },
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
    setActiveChat(v) { this.state.activeChat = v ?? null; return this.state.activeChat; },
    setCurrentGroup(g) { this.state.currentGroup = g ?? null; return this.state.currentGroup; },
    setActiveChatType(t) { this.state.activeChatType = t; return this.state.activeChatType; },
  };
}
export const chatStore = createChatStore();
export const sessionStore = createSessionStore();
export function useSessionStore() { return sessionStore; }
