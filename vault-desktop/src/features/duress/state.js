// Состояние фичи «Duress» (ADR-001 Этап 1: composables).
//
// Duress-пароль открывает ДЕКОЙ-режим вместо настоящих чатов. Поля
// описывают, в каком мы режиме и не разблокировался ли он в этой сессии.
//
// КОНТРАКТ ДЛЯ check-template.cjs (E1-spread) — тот же, что у folders:
//   1) файл НЕ импортирует ничего (гейт поднимает его живым импортом в
//      Node, где нет localStorage/Tauri);
//   2) экспортирует фабрику, возвращающую объект с полями состояния;
//   3) App.vue разворачивает спредом `...duressState()`.
//
// ВНИМАНИЕ: фича security-critical (декой вместо реальных данных). Значения
// по умолчанию менять нельзя без разбора: duressLocked=false — обычный
// режим, duressUnlockedThisSession=false — декой требует пароль заново при
// каждом запуске (иначе переживает перезапуск и не защищает).
export function duressState() {
  return {
    duressLocked: false,
    duressPending: false,
    duressUnlockedThisSession: false,
  };
}
