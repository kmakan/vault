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
// UI-состояние владельца: поля форм, флаги модалок, поиск.
//
// ВАЖНО (20.10.2026). Это состояние обязано быть РЕАКТИВНЫМ, иначе модалки
// не открываются. Computed в App.vue поверх ОБЫЧНОГО объекта не имеет
// реактивных зависимостей → Vue кэширует значение навсегда: `showSettings =
// true` не открывал настройки, и то же для формы создания группы и поиска
// чатов. Найдено пробой на живой сборке (headless Chrome, настоящий dist/).
//
// Тот же класс уже был починен для тоста (setToastSink — см. ниже), а для
// модалок и форм его забыли. Поэтому состояние ИНЪЕКТИРУЕТСЯ: App.vue
// создаёт reactive-объект и отдаёт его через setUiState. Сам модуль остаётся
// framework-agnostic (vue не импортируется) — принцип из шапки файла.
export function defaultUiState() {
  return {
    searchQuery: '',
    // J.5b: form-state (newChannel*/newGroup*) вынесен из App.data в uiStore.
    form: {
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
    // ADR-005 W2 (партия 14): меню чата и имя новой папки — форма. ДО этого
    // поля жили в data() компонента, а folderDialogOpen/chatFolderNewName вообще
    // НЕ были объявлены: присваивание из шаблона нереактивно, и диалог
    // «Новая папка» открывался только при СЛЕДУЮЩЕЙ перерисовке.
    chatMenu: { show: false, target: null },
    chatFolderNewName: '',
    // ADR-005 W3 (партия 3): UI-flow ответа на сообщение и пикера реакций
    // — у владельца форм (раньше это были поля data() компонента).
    replyTo: null,
    reactionPickerMsgId: null,
    // ADR-005 W3 (партия 4): правка сообщения — UI-flow, состояние у владельца форм.
    editingMessage: null,
    // ADR-005 W3 (партия 10): меню сообщения — UI-flow.
    messageMenu: null,
    // ADR-005 W3 (партия 6): перетаскивание заметок — UI-flow.
    draggedNoteId: null,
    dragOverNoteId: null,
    dragOverPos: null,
    // ADR-005 W3 (партия 7): «звёзды» сообщений — карта «чат → [id]».
    // Поле НЕ было объявлено: computed starredMap возвращал undefined, и
    // starredSet падал при первом рендере чата (живой лог 22.10.2026:
    // «render/error: starredSet» — список сообщений не отрисовывался).
    starredMap: {},
    },
    // J.5b: UI toggle flags вынесены из App.data в uiStore.modalFlags.
    modals: {
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
    // ADR-005 W2 (партия 14): диалог создания папки.
    folderDialogOpen: false,
    // ADR-005 W3 (партия 10): мобильный чат открыт/закрыт.
    mobileChatOpen: false,
    showCreateGroup: false,
    showEmojiPicker: false,
    showSettings: false,
    showMembers: false,
      showChatSearch: false,
      showJumpToBottom: false,
    },
  };
}

export function createUiStore() {
  let t = (k) => k;
  let showToast = () => {};
  // Состояние UI по умолчанию — обычный объект (node/смоуки). Реактивность
  // приходит инъекцией (setUiState) — см. defaultUiState.
  let uiState = defaultUiState();
  let toastState = { message: '' };
  // Реактивный «сток» тоста. Сам модуль framework-agnostic (см. шапку файла),
  // поэтому reactive({message}) создаёт App.vue и отдаёт сюда через
  // setToastSink. Без этого присвоение писалось в обычную переменную, и
  // computed `toastMessage` в App.vue не пересчитывался (тост не появлялся).
  let toastTimer = null;
  let scrollToBottom = () => {};
  let _onMessagesScroll = () => {};
  let _jumpToBottom = () => {};
  return {
    setT(fn) { t = fn; },
    getT() { return t; },
    setShowToast(fn) { showToast = fn; },
    getToast() { return showToast; },
    // ── Реактивное UI-состояние (инъекция от App.vue) ────────────────
    setUiState(state) { uiState = state || defaultUiState(); return uiState; },
    getUiState() { return uiState; },
    // J.5b: searchQuery-form state вынесен из App.data в uiStore.
    setSearchQuery(v) { uiState.searchQuery = v ?? ''; return uiState.searchQuery; },
    getSearchQuery() { return uiState.searchQuery; },
    setFormField(k, v) { uiState.form[k] = v ?? ''; return uiState.form[k]; },
    getFormField(k) { return uiState.form[k]; },
    resetForm() { for (const k of Object.keys(uiState.form)) uiState.form[k] = ''; },
    setModal(name, v) { uiState.modals[name] = !!v; return uiState.modals[name]; },
    getModal(name) { return !!uiState.modals[name]; },
    resetModals() { for (const k of Object.keys(uiState.modals)) uiState.modals[k] = false; },
    setToastSink(sink) { toastState = sink || { message: '' }; },
    setToastMessage(v) { toastState.message = v ?? ''; return toastState.message; },
    getToastMessage() { return toastState.message; },
    setToastTimer(t) { toastTimer = t; },
    getToastTimer() { return toastTimer; },
    clearToast() { toastState.message = ''; if (toastTimer) clearTimeout(toastTimer); toastTimer = null; },
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
    // tr(key, params): params прокидываются в t() — нужны ключам с
    // плейсхолдерами ({name} в download_complete). До 19.10.2026 params
    // отбрасывались, и подстановка была недоступна вызывающим из фич.
    tr(key, params) { return t(key, params); },
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
