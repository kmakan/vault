// Sfera UI: лёгкий каркас из пяти вкладок (ADR-006 §10, §17).
// Только навигация и состояние активной вкладки. Никаких правил, цен,
// подписей и форматов — они живут в Rust и приходят через Tauri-команды.
// Организации и платные возможности НЕ получают отдельных вкладок: они
// контекстно появляются в «Профиле» и «Хранилище».

export const TABS = Object.freeze([
  { id: 'feed', labelKey: 'nav_feed' },
  { id: 'contacts', labelKey: 'nav_contacts' },
  { id: 'create', labelKey: 'nav_create' },
  { id: 'storage', labelKey: 'nav_storage' },
  { id: 'profile', labelKey: 'nav_profile' },
]);

// Контекстная кнопка мессенджера: одна, в профиле. Состояние приходит из
// Rust (sfera-companion): установлен → открыть, нет → установить.
export const COMPANION = Object.freeze({
  openLabelKey: 'companion_open',
  installLabelKey: 'companion_install',
  hintKey: 'companion_hint',
});

export function companionLabelKey(installed) {
  return installed ? COMPANION.openLabelKey : COMPANION.installLabelKey;
}

export function createShell(initial = 'feed') {
  let active = TABS.some((t) => t.id === initial) ? initial : TABS[0].id;
  return {
    active: () => active,
    select(id) {
      if (!TABS.some((t) => t.id === id)) return false;
      active = id;
      return true;
    },
    tabs: () => TABS,
  };
}
