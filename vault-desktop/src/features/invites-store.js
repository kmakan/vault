// ADR-004/ADR-005: владелец состояния инвайтов (бывшие App.vue data
// this.pendingInvites/pendingContacts/handledInviteKeys/handledContactKeys).
//
// ПОЧЕМУ ВЛАДЕЛЕЦ, А НЕ КОМПОНЕНТ. Эти поля писали ДВА модуля:
// `invites.js` (наполняет очередь, показывает попап) и `contacts.js`
// (обрабатывает запрос контакта: splice/push очереди, метки «в обработке»).
// Пока состояние жило в data() компонента, связь между модулями была
// невидимой: один писал массив, другой его менял — и правило ADR-004
// «поле с несколькими писателями → у него есть владелец» не выполнялось.
// Теперь очередь и метки «в обработке» живут здесь, а модули получают
// узкий API (получить + операция), а не чужой массив.
//
// ЧТО ВЛАДЕЕЦЕМ НЕ ЯВЛЯЕТСЯ. Флаги попапа (открыт ли, какой индекс) —
// UI-состояние: по ADR-003 §2 оно остаётся в компоненте (uiStore.modalFlags
// и uiStore.formState). Здесь только ДАННЫЕ очереди и дедуп.
//
// ВЛАДЕЛЕЦ PER-APP. Экземпляр создаётся в setup() App.vue (`reactive(
// createInvitesStore())`) и передаётся модулям в deps — как `chat`/`sending`
// в messages.js. Модуль НЕ импортирует синглтон: у per-app состояния
// один экземпляр на окно, и второй импорт дал бы рассинхрон.
//
// API: только операции, а не массив наружу — иначе владелец превращается в
// обёртку и правило «один писатель» снова перестаёт работать.
export function createInvitesStore() {
  const state = {
    pendingInvites: [],    // инвайты в группы, ждут согласия (попап)
    pendingContacts: [],   // запросы контакта 1-на-1, ждут согласия (попап)
    // Метки «в обработке»: пока идёт медленный SMTP, поллинг не должен
    // показать их повторно (ключи «group_id|uid» / «sender|uid»).
    handledInviteKeys: [],
    handledContactKeys: [],
  };
  return {
    state,
    // ── очередь инвайтов в группы ────────────────────────────────────
    getPendingInvites() { return this.state.pendingInvites; },
    setPendingInvites(list) { this.state.pendingInvites = list || []; return this.state.pendingInvites; },
    pushPendingInvite(inv) { this.state.pendingInvites.push(inv); return this.state.pendingInvites; },
    splicePendingInvite(i) { this.state.pendingInvites.splice(i, 1); return this.state.pendingInvites; },
    // ── очередь запросов контакта ─────────────────────────────────────
    getPendingContacts() { return this.state.pendingContacts; },
    setPendingContacts(list) { this.state.pendingContacts = list || []; return this.state.pendingContacts; },
    pushPendingContact(c) { this.state.pendingContacts.push(c); return this.state.pendingContacts; },
    splicePendingContact(i) { this.state.pendingContacts.splice(i, 1); return this.state.pendingContacts; },
    // ── метки «в обработке» (дедуп поллинга) ──────────────────────────
    markInviteHandled(key) {
      if (!this.state.handledInviteKeys.includes(key)) this.state.handledInviteKeys.push(key);
      return key;
    },
    unmarkInviteHandled(key) {
      const i = this.state.handledInviteKeys.indexOf(key);
      if (i >= 0) this.state.handledInviteKeys.splice(i, 1);
      return key;
    },
    isInviteHandled(key) { return this.state.handledInviteKeys.includes(key); },
    markContactHandled(key) {
      if (!this.state.handledContactKeys.includes(key)) this.state.handledContactKeys.push(key);
      return key;
    },
    unmarkContactHandled(key) {
      const i = this.state.handledContactKeys.indexOf(key);
      if (i >= 0) this.state.handledContactKeys.splice(i, 1);
      return key;
    },
    isContactHandled(key) { return this.state.handledContactKeys.includes(key); },
    // Сброс на выходе из аккаунта: очередь пустая, попапы скрыты.
    // Метки «в обработке» НЕ трогаем — они про принятые/отклонённые, а не про
    // показ (иначе после логауна-логина старые инвайты всплыли бы снова).
    reset() {
      this.state.pendingInvites = [];
      this.state.pendingContacts = [];
    },
  };
}
