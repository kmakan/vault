// Состояние фичи «Папки чатов» (ADR-001 Этап 1: composables).
//
// КОНТРАКТ ДЛЯ check-template.cjs (E1-spread):
//   1) этот файл НЕ импортирует ничего — гейт поднимает его живым импортом
//      в Node, где нет ни localStorage, ни Tauri;
//   2) экспортирует функцию-фабрику, возвращающую объект с полями состояния;
//   3) App.vue разворачивает спредом: `...foldersState()`.
//
// Нарушение (1) — например импорт ../api.js — валит гейт с «localStorage is
// not defined», и он перестаёт проверять биндинги этой фичи. Держим файл
// чистым: только данные состояния, никакой логики.
//
// chatFlags здесь НЕ включён: им владеет не «папки», а чат-меню
// (archived/muted) и его же читают фильтры списка в App.vue. Вынесено
// отдельным шагом вместе с архивом.

export function foldersState() {
  return {
    activeFolder: '',
    folderDialogOpen: false,
    chatFolderNewName: '',
    chatFoldersNames: [],
  };
}
