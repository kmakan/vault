// Sfera UI: адаптер к Tauri-командам. Только вызовы и разбор DTO —
// никаких правил, цен, MIME-классификации или прав (ADR-006 §9.3).
// В тестах подставляется fake invoke, поэтому слой проверяем без GUI.

import { companionLabelKey } from './shell.js';

// Имена команд совпадают с #[tauri::command] в social-ffi / social-ffi-extra.
export const COMMANDS = Object.freeze({
  apiVersion: 'social_api_version',
  linkStatus: 'social_link_status',
  linkAccept: 'social_link_accept',
  identity: 'social_identity',
  feed: 'social_feed',
  contacts: 'social_contacts',
  audiences: 'social_audiences',
  createAudience: 'social_create_audience',
  acceptInvite: 'social_accept_contact_request',
  publishPost: 'social_publish_post',
  profile: 'social_profile',
  storeCaps: 'social_store_caps',
  companion: 'social_companion_action',
  plans: 'social_plans_from_server',
  planFor: 'social_plan_for',
  mediaKind: 'social_media_kind',
  orgAllowsMedia: 'social_organization_role_allows_media',
  uploadMedia: 'social_upload_media',
  publishWithMedia: 'social_publish_with_media',
});

export function createBridge(invoke) {
  if (typeof invoke !== 'function') throw new Error('invoke required');

  return {
    apiVersion() {
      return invoke(COMMANDS.apiVersion);
    },

    linkStatus() {
      return invoke(COMMANDS.linkStatus);
    },

    linkAccept(uri) {
      return invoke(COMMANDS.linkAccept, { uri });
    },

    identity() {
      return invoke(COMMANDS.identity);
    },

    feed() {
      return invoke(COMMANDS.feed);
    },

    contacts() {
      return invoke(COMMANDS.contacts);
    },

    audiences() {
      return invoke(COMMANDS.audiences);
    },

    // id и members приходят из формы; версию и форму Rust не подменяем.
    createAudience(req) {
      return invoke(COMMANDS.createAudience, { req });
    },

    acceptInvite(req) {
      return invoke(COMMANDS.acceptInvite, { req });
    },

    publishPost(req) {
      return invoke(COMMANDS.publishPost, { req });
    },

    profile(fp) {
      return invoke(COMMANDS.profile, { fp });
    },

    storeCaps() {
      return invoke(COMMANDS.storeCaps);
    },

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

    // Файл читается в base64 на границе UI; шифрование и тип — в Rust.
    uploadMedia(mime, dataBase64) {
      return invoke(COMMANDS.uploadMedia, { mime, dataBase64 });
    },

    publishWithMedia(req, uploaded) {
      return invoke(COMMANDS.publishWithMedia, { req, uploaded });
    },
  };
}
