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
  publicChannels: 'social_public_channels',
  publicChannel: 'social_public_channel',
  createPublicChannel: 'social_create_public_channel',
  publishPublicPost: 'social_publish_public_post',
  contacts: 'social_contacts',
  setContactRole: 'social_set_contact_role',
  roleOptions: 'social_role_options',
  audiences: 'social_audiences',
  createAudience: 'social_create_audience',
  setAudienceMembers: 'social_set_audience_members',
  audienceMembers: 'social_audience_members',
  acceptInvite: 'social_accept_contact_request',
  publishPost: 'social_publish_post',
  commentOnPost: 'social_comment_on_post',
  receiveComment: 'social_receive_comment',
  reactToPost: 'social_react_to_post',
  receiveReaction: 'social_receive_reaction',
  discussion: 'social_discussion',
  profile: 'social_profile',
  setMyProfile: 'social_set_my_profile',
  receiveProfile: 'social_receive_profile',
  receiveInbox: 'social_receive_inbox',
  openReceivedAvatar: 'social_open_received_avatar',
  storeCaps: 'social_store_caps',
  companion: 'social_companion_action',
  plans: 'social_plans_from_server',
  planFor: 'social_plan_for',
  mediaKind: 'social_media_kind',
  orgAllowsMedia: 'social_organization_role_allows_media',
  uploadMedia: 'social_upload_media',
  uploadAvatar: 'social_upload_avatar',
  publishWithMedia: 'social_publish_with_media',
  libraryItems: 'social_library_items',
  libraryForget: 'social_library_forget',
  libraryOpen: 'social_library_open',
  libraryStream: 'social_library_stream',
  libraryThumb: 'social_library_thumb',
  syncStatus: 'social_sync_status',
  syncOutbox: 'social_sync_outbox',
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

    publicChannels() {
      return invoke(COMMANDS.publicChannels);
    },

    publicChannel(id) {
      return invoke(COMMANDS.publicChannel, { id });
    },

    createPublicChannel(req) {
      return invoke(COMMANDS.createPublicChannel, { req });
    },

    publishPublicPost(req) {
      return invoke(COMMANDS.publishPublicPost, { req });
    },

    contacts() {
      return invoke(COMMANDS.contacts);
    },

    // fp и роль приходят из формы; проверку состояния делает Rust.
    setContactRole(req) {
      return invoke(COMMANDS.setContactRole, { req });
    },

    // Пресеты прав по ролям — подпись под селектором, значения из Rust.
    roleOptions() {
      return invoke(COMMANDS.roleOptions);
    },

    audiences() {
      return invoke(COMMANDS.audiences);
    },

    // id и members приходят из формы; версию и форму Rust не подменяем.
    createAudience(req) {
      return invoke(COMMANDS.createAudience, { req });
    },

    setAudienceMembers(req) {
      return invoke(COMMANDS.setAudienceMembers, { req });
    },

    audienceMembers(id) {
      return invoke(COMMANDS.audienceMembers, { id });
    },

    acceptInvite(req) {
      return invoke(COMMANDS.acceptInvite, { req });
    },

    publishPost(req) {
      return invoke(COMMANDS.publishPost, { req });
    },

    // Исходную аудиторию и права вычисляет Rust; UI передаёт только действие.
    commentOnPost(req) {
      return invoke(COMMANDS.commentOnPost, { req });
    },

    receiveComment(postId, comment) {
      return invoke(COMMANDS.receiveComment, { postId, comment });
    },

    reactToPost(req) {
      return invoke(COMMANDS.reactToPost, { req });
    },

    receiveReaction(postId, reaction) {
      return invoke(COMMANDS.receiveReaction, { postId, reaction });
    },

    discussion(postId) {
      return invoke(COMMANDS.discussion, { postId });
    },

    profile(fp) {
      return invoke(COMMANDS.profile, { fp });
    },

    // Форму профиля собирает UI, подпись и «новее побеждает» — в Rust.
    setMyProfile(req) {
      return invoke(COMMANDS.setMyProfile, { req });
    },

    // Входной E2E-конверт и ключи разбирает только Rust.
    receiveProfile(envelope) {
      return invoke(COMMANDS.receiveProfile, { envelope });
    },

    // Явный PEEK-цикл; фонового монитора ящика UI не создаёт.
    receiveInbox() {
      return invoke(COMMANDS.receiveInbox);
    },

    // Чужой аватар открывается по profile_id; ключ не покидает Rust.
    openReceivedAvatar(profileId) {
      return invoke(COMMANDS.openReceivedAvatar, { profileId });
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

    // Аватар возвращает только ссылку на блоб; ключ остаётся в Rust.
    uploadAvatar(mime, dataBase64) {
      return invoke(COMMANDS.uploadAvatar, { mime, dataBase64 });
    },

    publishWithMedia(req, uploaded) {
      return invoke(COMMANDS.publishWithMedia, { req, uploaded });
    },

    libraryItems() {
      return invoke(COMMANDS.libraryItems);
    },

    libraryForget(blobId) {
      return invoke(COMMANDS.libraryForget, { blobId });
    },

    // Расшифрованный файл приходит из Rust; ключ и формат UI не видит.
    libraryOpen(blobId) {
      return invoke(COMMANDS.libraryOpen, { blobId });
    },

    // Адрес потокового просмотра: схему, origin и MIME выбирает Rust.
    libraryStream(blobId) {
      return invoke(COMMANDS.libraryStream, { blobId });
    },

    // Маленький JPEG для плитки; None — миниатюры нет.
    libraryThumb(blobId) {
      return invoke(COMMANDS.libraryThumb, { blobId });
    },

    // Очередь и факт подключения транспорта — только числа от Rust.
    syncStatus(now) {
      return invoke(COMMANDS.syncStatus, { now });
    },

    // Запуск отправки явный: факт ответа сервера фиксирует outbox в Rust.
    syncOutbox(now) {
      return invoke(COMMANDS.syncOutbox, { now });
    },
  };
}
