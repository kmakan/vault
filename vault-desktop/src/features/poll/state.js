// Состояние фичи «Опросы» (ADR-001 Этап 1: composables).
//
//   pollDialog — флаг открытия формы создания опроса (сама форма —
//                PollDialog.vue, отдаётся ему через :show);
//   pollTimer  — handle таймера закрытия/обновления голосов. Объявлен в
//                data() (как и раньше), хотя по сути это не реактивное
//                состояние, а служебный хендл: менять поведение здесь
//                нельзя без разбора — см. poll.js.
//
// КОНТРАКТ ДЛЯ check-template.cjs (E1-spread): без импортов, экспорт
// фабрики, App.vue разворачивает спредом `...pollState()`.
export function pollState() {
  return {
    pollDialog: false,
    pollTimer: null,
  };
}
