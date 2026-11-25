// Sfera UI: состояние экранов. Только оркестрация вызовов Rust —
// правила, форматы, права и цены остаются в Rust (ADR-006 §9.3).
// Модуль не трогает DOM, поэтому проверяется в node без GUI.

import { reactive } from 'vue';
import { createShell } from './shell.js';
import { hasLocale, translate } from '../locales/index.js';
import { THEMES } from '../themes/index.js';

const DRAFT_KEY = 'sfera.draft';

export function createAppState({
  bridge,
  locale = 'ru',
  theme = 'dark',
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!bridge) throw new Error('bridge required');

  const shell = createShell();
  // Реактивный объект создаётся здесь: все методы замыкаются на него же.
  // Если обернуть state снаружи в main.js, появится Proxy рядом с обычным
  // объектом и вкладки не будут переключаться (GUI-приёмка 21.11).
  const state = reactive({
    locale: hasLocale(locale) ? locale : 'en',
    theme: THEMES[theme] ? theme : 'dark',
    tab: shell.active(),
    apiVersion: null,
    // Черновик композера живёт в состоянии приложения: вкладки монтируются
    // заново, а набранный текст терять нельзя (продукт §3.3).
    draft: '',
    link: null,
    identity: null,
    // Свой профиль (подписанный конверт). Форма редактирует его, подпись
    // и порядок «новее побеждает» остаются в Rust.
    myProfile: null,
    // Выбранный, но ещё не сохранённый аватар: ссылка на блоб без ключа.
    avatarDraft: null,
    feed: [],
    // Обсуждение по id поста: готовые подписанные события из Rust.
    discussions: {},
    contacts: [],
    // Принятые по IMAP профили по fingerprint; avatar — только data URL
    // из Rust, ключ и манифест в состоянии JS не появляются.
    contactProfiles: {},
    contactAvatars: {},
    // Пресеты прав по ролям приходят из social-rights через FFI.
    roleOptions: [],
    audiences: [],
    // Состав сфер по id: отпечатки и эпоха. Ключи остаются в Rust.
    audienceMembers: {},
    caps: null,
    // Честное состояние очереди: чисел и флага транспорта достаточно, чтобы
    // не выдавать локальную публикацию за доставку.
    sync: null,
    lastSyncAt: null,
    receiveReport: null,
    // Результаты загрузки: ключ файла живёт здесь только до публикации,
    // затем уходит в E2E-манифест и очищается.
    uploads: [],
    library: [],
    // Миниатюры по blob_id: маленький data URL для плитки/ленты. Полный
    // файл по-прежнему открывается отдельным вызовом.
    thumbs: {},
    // Открытый файл: содержимое уже расшифровано в Rust. `previewUrl` —
    // только способ показать картинку; для остальных типов он пуст.
    preview: null,
    previewUrl: null,
    error: null,
  });

  async function load(key, fn) {
    try {
      state[key] = await fn();
      return state[key];
    } catch (e) {
      state.error = String(e?.message ?? e);
      return null;
    }
  }

  // Миниатюры не критичны: ошибка одного превью не должна ронять экран.
  async function loadThumbs() {
    const ids = new Set();
    for (const item of state.library ?? []) {
      if (item.thumb_blob_id) ids.add(item.blob_id);
    }
    for (const entry of state.feed ?? []) {
      for (const m of entry.post?.post?.media ?? []) {
        if (m.thumb_blob_id) ids.add(m.blob_id);
      }
    }
    for (const id of ids) {
      if (state.thumbs[id]) continue;
      try {
        const content = await bridge.libraryThumb(id);
        if (content) {
          state.thumbs[id] = `data:${content.mime};base64,${content.data_base64}`;
        }
      } catch {
        // Превью не обязательно: файл всё равно откроется по клику.
      }
    }
  }

  // Плашка синхронизации не критична: при отказе команды лента остаётся
  // рабочей, а время обновления показывают локальные часы.
  async function loadSync() {
    try {
      state.sync = await bridge.syncStatus(clock());
    } catch {
      state.sync = null;
    }
    state.lastSyncAt = clock();
  }

  // Чтение файла и base64 — граница UI: байты дальше шифрует Rust.
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Принятый профиль — именно по fingerprint из подписанного конверта,
  // не по адресу письма. AvatarRef сам не содержит profile_id, поэтому его
  // вычисляет Rust в DTO (UI не повторяет хеш).
  async function loadContactProfile(fp) {
    try {
      const profile = await bridge.profile(fp);
      state.contactProfiles[fp] = profile;
      if (profile?.profile?.avatar) {
        const content = await bridge.openReceivedAvatar(profile.profile.avatar.profile_id);
        state.contactAvatars[fp] = `data:${content.mime};base64,${content.data_base64}`;
      } else {
        delete state.contactAvatars[fp];
      }
      return profile;
    } catch (e) {
      state.error = String(e?.message ?? e);
      return null;
    }
  }

  async function loadDiscussion(postId) {
    if (!postId) return null;
    try {
      const dto = await bridge.discussion(postId);
      state.discussions[postId] = dto;
      return dto;
    } catch (e) {
      state.error = String(e?.message ?? e);
      return null;
    }
  }

  async function loadAllDiscussions() {
    await Promise.all((state.feed ?? []).map((entry) => loadDiscussion(entry.id)));
  }

  // Состав сферы: отпечатки и эпоха приходят из Rust, ключи не покидают ядро.
  async function fetchAudienceMembers(id) {
    try {
      const dto = await bridge.audienceMembers(id);
      state.audienceMembers[id] = dto;
      return dto;
    } catch (e) {
      state.error = String(e?.message ?? e);
      return null;
    }
  }

  return {
    state,
    loadThumbs,
    loadAudienceMembers: fetchAudienceMembers,

    t(key, params) {
      return translate(state.locale, key, params);
    },

    setLocale(code) {
      if (!hasLocale(code)) return false;
      state.locale = code;
      return true;
    },

    setTheme(id) {
      if (!THEMES[id]) return false;
      state.theme = id;
      return true;
    },

    themeVars() {
      return THEMES[state.theme].vars;
    },

    openTab(id) {
      const ok = shell.select(id);
      if (ok) state.tab = shell.active();
      return ok;
    },

    // Сохранение черновика — состояние UI, а не протокол: текст не подписы-
    // вается и в Rust не уходит до публикации.
    setDraft(text) {
      state.draft = String(text ?? '');
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(DRAFT_KEY, state.draft);
        } catch {
          // Приватный режим или квота: черновик живёт до конца сессии.
        }
      }
    },

    tabs() {
      return shell.tabs();
    },

    async init() {
      state.error = null;
      if (typeof localStorage !== 'undefined') {
        try {
          state.draft = localStorage.getItem(DRAFT_KEY) ?? '';
        } catch {
          // Черновик необязателен: без хранилища начинаем с пустой формы.
        }
      }
      state.apiVersion = await bridge.apiVersion();
      await Promise.all([
        load('link', () => bridge.linkStatus()),
        load('identity', () => bridge.identity()),
        load('feed', () => bridge.feed()),
        load('contacts', () => bridge.contacts()),
        load('roleOptions', () => bridge.roleOptions()),
        load('audiences', () => bridge.audiences()),
        load('caps', () => bridge.storeCaps()),
        load('library', () => bridge.libraryItems()),
      ]);
      await loadThumbs();
      await loadSync();
      if (state.identity?.fp) {
        await load('myProfile', () => bridge.profile(state.identity.fp));
        state.avatarDraft = state.myProfile?.profile?.avatar ?? null;
      }
      await Promise.all((state.audiences ?? []).map((a) => fetchAudienceMembers(a.id)));
      await Promise.all((state.contacts ?? []).map((c) => loadContactProfile(c.fp)));
      await loadAllDiscussions();
      return state;
    },

    loadFeed: async () => {
      const feed = await load('feed', () => bridge.feed());
      await loadThumbs();
      await loadSync();
      await loadAllDiscussions();
      return feed;
    },
    loadContacts: () => load('contacts', () => bridge.contacts()),
    loadContactProfile,
    loadDiscussion,

    async commentOnPost(postId, body, parentId = null) {
      const now = clock();
      // ID и версию события назначает Rust: UI не вычисляет протокол.
      const signed = await bridge.commentOnPost({
        v: state.apiVersion, post_id: postId,
        parent_id: parentId, ts: now, body, media: [], now,
      });
      await loadDiscussion(postId);
      return signed;
    },

    async reactToPost(postId, emoji, removed = false) {
      const now = clock();
      const signed = await bridge.reactToPost({
        v: state.apiVersion, post_id: postId, emoji, removed, now,
      });
      await loadDiscussion(postId);
      return signed;
    },

    // Явный запрос пользователя, не фоновый цикл. Отчёт и профили читаются
    // только из Rust; внешняя доставка по-прежнему подтверждается отдельно.
    async receiveInbox() {
      const report = await bridge.receiveInbox();
      state.receiveReport = report;
      await Promise.all((state.contacts ?? []).map((c) => loadContactProfile(c.fp)));
      await load('feed', () => bridge.feed());
      await loadThumbs();
      await loadSync();
      await loadAllDiscussions();
      return report;
    },

    // Роль меняется только у принятого контакта: состояние проверяет Rust.
    // fp и role приходят из формы, версию протокола UI не изобретает.
    async setContactRole(fp, role) {
      if (!fp || !role) throw new Error('fp and role required');
      if (state.apiVersion == null) throw new Error('bridge not initialized');
      await bridge.setContactRole({ v: state.apiVersion, fp, role });
      state.contacts = await bridge.contacts();
      return state.contacts;
    },

    // Тип медиа решает Rust: UI только показывает готовую подпись.
    mediaKind(mime) {
      return bridge.mediaKind(mime);
    },

    loadProfile: async () => {
      if (!state.identity?.fp) return null;
      const profile = await load('myProfile', () => bridge.profile(state.identity.fp));
      state.avatarDraft = profile?.profile?.avatar ?? null;
      return profile;
    },

    // Имя, био и ссылки приходят из формы; подпись и валидация — в Rust.
    async saveProfile({ displayName, bio = '', links = [] }) {
      if (!displayName || !displayName.trim()) throw new Error('display name required');
      if (state.apiVersion == null) throw new Error('bridge not initialized');
      const now = clock();
      const result = await bridge.setMyProfile({
        v: state.apiVersion,
        ts: now,
        display_name: displayName.trim(),
        bio,
        // Ссылка на аватар, а не его ключ: ключ остаётся в каталоге Rust.
        avatar: state.avatarDraft ?? null,
        links,
        now,
      });
      if (state.identity?.fp) {
        state.myProfile = await bridge.profile(state.identity.fp);
        state.avatarDraft = state.myProfile?.profile?.avatar ?? null;
      }
      return result;
    },

    // Заявка приходит готовой (QR/файл): ts и nonce уже в ней. UI не
    // изобретает идентичность и не обходит дедуп в social-contacts.
    async acceptInvite(request) {
      if (!request) throw new Error('invite required');
      const accepted = await bridge.acceptInvite({
        v: state.apiVersion,
        request,
      });
      state.contacts = await bridge.contacts();
      return accepted;
    },
    loadAudiences: () => load('audiences', () => bridge.audiences()),

    // Сфера создаётся на устройстве: id и состав контактов приходят из формы,
    // версию протокола и правилоepoch решает Rust.
    async createAudience({ id, members = [] }) {
      if (!id || !id.trim()) throw new Error('audience id required');
      await bridge.createAudience({
        v: state.apiVersion,
        id: id.trim(),
        members,
      });
      state.audiences = await bridge.audiences();
      await fetchAudienceMembers(id.trim());
      return state.audiences;
    },

    // Состав меняется целиком: ротацию эпохи и ключа решает social-audience.
    async setAudienceMembers({ id, members = [] }) {
      if (!id) throw new Error('audience id required');
      const result = await bridge.setAudienceMembers({
        v: state.apiVersion,
        id,
        members,
      });
      state.audiences = await bridge.audiences();
      await fetchAudienceMembers(id);
      return result;
    },
    loadCaps: () => load('caps', () => bridge.storeCaps()),

    // Чтение файла и base64 — граница UI. Ключ шифрования возвращается Rust
    // и должен уйти в E2E-конверт, а не сохраняться в состоянии экрана.
    async uploadFile(file) {
      if (!file) throw new Error('file required');
      const dataBase64 = await readBase64(file);
      const result = await bridge.uploadMedia(file.type || 'application/octet-stream', dataBase64);
      state.uploads.push(result);
      state.library = await bridge.libraryItems();
      await loadThumbs();
      return result;
    },

    // Аватар — такой же шифрованный блоб, но в очередь вложений поста не
    // попадает. Ключ остаётся в каталоге Rust, поэтому превью работает и
    // после перезапуска, без повторной загрузки.
    async uploadAvatar(file) {
      if (!file) throw new Error('file required');
      if (!String(file.type || '').startsWith('image/')) {
        throw new Error('avatar must be an image');
      }
      const dataBase64 = await readBase64(file);
      const result = await bridge.uploadAvatar(file.type, dataBase64);
      state.avatarDraft = result.avatar;
      state.library = await bridge.libraryItems();
      await loadThumbs();
      return result;
    },

    clearAvatar() {
      state.avatarDraft = null;
    },

    clearUploads() {
      state.uploads = [];
    },

    loadLibrary: async () => {
      const library = await load('library', () => bridge.libraryItems());
      await loadThumbs();
      return library;
    },

    // Просмотр своего файла: расшифровка и ключ — в Rust, здесь только
    // показ уже готовых байтов. Аудио/видео не читаем целиком: WebView сам
    // запросит Range у адреса, который отдал Rust.
    async openFile(blobId) {
      const item = state.library.find((i) => i.blob_id === blobId);
      if (item && (item.kind === 'Audio' || item.kind === 'Video')) {
        const stream = await bridge.libraryStream(blobId);
        if (!stream) throw new Error('file not found');
        state.preview = {
          blob_id: stream.blob_id,
          mime: stream.mime,
          size: stream.size,
          kind: item.kind,
        };
        state.previewUrl = stream.url;
        return state.preview;
      }
      const content = await bridge.libraryOpen(blobId);
      if (!content) throw new Error('file not found');
      state.preview = content;
      // Картинка, звук и видео играются прямо в окне; для документов
      // честно говорим, что встроенного просмотра нет.
      const inline = content.kind === 'Image' || content.kind === 'Audio' || content.kind === 'Video';
      state.previewUrl = inline
        ? `data:${content.mime};base64,${content.data_base64}`
        : null;
      return content;
    },

    closePreview() {
      state.preview = null;
      state.previewUrl = null;
    },

    async forgetFile(blobId) {
      await bridge.libraryForget(blobId);
      if (state.preview?.blob_id === blobId) {
        state.preview = null;
        state.previewUrl = null;
      }
      delete state.thumbs[blobId];
      // Забытый блоб нельзя расшифровать: висячая ссылка на аватар не нужна.
      if (state.avatarDraft?.blob_id === blobId) state.avatarDraft = null;
      state.library = await bridge.libraryItems();
    },

    // Публикация с медиа: Rust сам строит MediaRef и E2E-манифест.
    async publishWithMedia({ body, audience }) {
      if (!body || !body.trim()) throw new Error('empty post');
      if (!audience) throw new Error('audience required');
      if (state.apiVersion == null) throw new Error('bridge not initialized');
      const req = {
        v: state.apiVersion,
        ts: clock(),
        body,
        audience,
        media: [],
        now: clock(),
      };
      const post = await bridge.publishWithMedia(req, state.uploads);
      state.uploads = [];
      state.feed = await bridge.feed();
      await loadThumbs();
      await loadSync();
      return post;
    },

    // QR из мессенджера: проверка цепочки — в Rust, UI только передаёт URI.
    async acceptLink(uri) {
      state.link = await load('link', () => bridge.linkAccept(uri));
      return state.link;
    },

    // Тело, адресат и медиа приходят из формы; форма аудитории — из Rust.
    // UI не собирает `PostAudience` и не подставляет версию протокола.
    async publish({ body, audience, media = [] }) {
      if (!body || !body.trim()) throw new Error('empty post');
      if (!audience) throw new Error('audience required');
      if (state.apiVersion == null) throw new Error('bridge not initialized');
      const now = clock();
      const post = await bridge.publishPost({
        v: state.apiVersion,
        ts: now,
        body,
        audience,
        media,
        now,
      });
      state.feed = await bridge.feed();
      await loadSync();
      return post;
    },

    companion(deepLinkHandled) {
      return bridge.companionAction(deepLinkHandled);
    },
  };
}
