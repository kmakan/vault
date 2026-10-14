// Состояние фичи «Пересылка» (ADR-001 Этап 1: composables).
//
//   forwardTo — пересылаемое сообщение (объект) либо null, если пересылка
//               не открыта. UI-флаг: `:show="!!forwardTo"` у ForwardDialog,
//               закрытие диалога сбрасывает в null.
//
// КОНТРАКТ ДЛЯ check-template.cjs (E1-spread): без импортов, экспорт
// фабрики, App.vue разворачивает спредом `...forwardState()`.
export function forwardState() {
  return {
    forwardTo: null,
  };
}
