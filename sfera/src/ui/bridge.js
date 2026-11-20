// Sfera UI: адаптер к Tauri-командам. Только вызовы и разбор DTO —
// никаких правил, цен, MIME-классификации или прав (ADR-006 §9.3).
// В тестах подставляется fake invoke, поэтому слой проверяем без GUI.

import { companionLabelKey } from './shell.js';

// Имена команд совпадают с #[tauri::command] в social-ffi-extra.
export const COMMANDS = Object.freeze({
  companion: 'social_companion_action',
  plans: 'social_plans_from_server',
  planFor: 'social_plan_for',
  mediaKind: 'social_media_kind',
  orgAllowsMedia: 'social_organization_role_allows_media',
});

export function createBridge(invoke) {
  if (typeof invoke !== 'function') throw new Error('invoke required');

  return {
    async companionAction(deepLinkHandled) {
      const dto = await invoke(COMMANDS.companion, { deepLinkHandled });
      return {
        install: Boolean(dto.install),
        target: dto.target,
        labelKey: companionLabelKey(!dto.install),
      };
    },

    async plans(response) {
      // Вся валидация витрины уже сделана в Rust: social_plans_from_server
      // возвращает DTO или ошибку. Здесь только передача.
      return invoke(COMMANDS.plans, { response });
    },

    async planFor(response, months) {
      return invoke(COMMANDS.planFor, { response, months });
    },

    async mediaKind(mime) {
      return invoke(COMMANDS.mediaKind, { mime });
    },

    async orgAllowsMedia(role) {
      return Boolean(await invoke(COMMANDS.orgAllowsMedia, { role }));
    },
  };
}
