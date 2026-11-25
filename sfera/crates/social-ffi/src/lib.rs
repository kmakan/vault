//! Vault Sfera — тонкий слой Tauri-команд `social_*` (ADR-006 §9.1, §9.3).
//!
//! Правило: FFI — это только граница. Каждая команда вызывает ОДИН facade
//! `social-app`, превращает ошибку в типизированный `CommandError` и ловит
//! панику через `catch_unwind`. Никаких решений, форматов и правил здесь нет;
//! DTO версионированы, чтобы менять-wire явно.
//!
//! Tauri подключён с `default-features = false`: только макрос команд и IPC-типы,
//! без GUI-рантайма. Те же функции вызываются напрямую из тестов.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use storage_api::Range;
use social_app::{
    AppError, Audience, ContactRecord, MediaRef, PostAudience, ProfileLink,
    SferaApp, SignedPost, StoreCaps, SyncReport,
};

mod stream;
mod persistence;

pub use stream::{
    media_url, parse_http_range, resolve_range, serve_range, stream_info, valid_blob_id,
    MediaResponse, RangeSpec, MEDIA_SCHEME,
};

/// Версия wire-контракта команд. Поднимать при ломающем изменении DTO.
pub const API_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandError {
    /// Машинный код: `version`, `input`, `app`, `transport`, `panic`, `lock`.
    pub code: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    fn version() -> Self { Self::new("version", "unsupported API version") }
    fn input(e: impl std::fmt::Display) -> Self { Self::new("input", e.to_string()) }
    fn backend(e: impl std::fmt::Display) -> Self { Self::new("backend", e.to_string()) }
    fn panic() -> Self { Self::new("panic", "command panicked; app state intact") }
    fn lock() -> Self { Self::new("lock", "app state lock poisoned") }
}

impl From<AppError> for CommandError {
    fn from(e: AppError) -> Self { Self::new("app", e.to_string()) }
}

/// Порт доставки: тонкий адаптер поверх email/relay. Решение о том, что
/// отправлять, принимает outbox; здесь только «отправить / не отправилось».
pub trait DeliveryPort: Send + Sync {
    fn send(&self, item: &social_app::OutboxItem) -> bool;
}

/// Состояние команд: приложение + порт доставки. Блокировка на всё время
/// команды — последовательный доступ к локальному состоянию фич.
pub struct SferaState {
    app: Mutex<SferaApp>,
    delivery: Option<Arc<dyn DeliveryPort>>,
    /// Манифесты только принятых и проверенных профилей; ключ не уходит в JS.
    received_avatars: Mutex<std::collections::HashMap<String, social_library::AvatarManifest>>,
    /// Каталог локальных ключей и метаданных (media_library.json).
    keys_dir: std::path::PathBuf,
}

impl SferaState {
    pub fn new(app: SferaApp, delivery: Option<Arc<dyn DeliveryPort>>) -> Self {
        Self {
            app: Mutex::new(app),
            delivery,
            received_avatars: Mutex::new(std::collections::HashMap::new()),
            keys_dir: std::env::var("SFERA_KEYS_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .unwrap_or_else(|| std::path::PathBuf::from("."))
                        .join(".sfera")
                        .join("keys")
                }),
        }
    }

    pub fn with_keys_dir(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.keys_dir = dir.into();
        self
    }

    /// Восстановить принятую книгу после загрузки app data и до первой команды.
    /// Пустого файла нет — это первый запуск, а не потеря книги.
    pub fn load_received_profiles(self) -> Result<Self, CommandError> {
        let avatars = self.call(|app| {
            let avatars = persistence::load_at(&self.keys_dir, app).map_err(CommandError::from)?;
            persistence::load_discussion_at(&self.keys_dir, app).map_err(CommandError::from)?;
            Ok(avatars)
        })?;
        *self.received_avatars.lock().map_err(|_| CommandError::backend("received avatars lock"))? = avatars;
        Ok(self)
    }

    /// Сохранить книгу и манифесты после изменения профиля. Если диск отказал,
    /// команда возвращает ошибку, а не заявляет устойчивое сохранение.
    fn persist_received_profiles(&self, app: &SferaApp) -> Result<(), CommandError> {
        let path = self.keys_dir.join(persistence::FILE);
        // Битый файл не перезаписывается новым снимком: это была бы потеря
        // принятой книги без явной диагностики.
        if path.exists() {
            persistence::validate_at(&self.keys_dir).map_err(CommandError::from)?;
        }
        let avatars = self.received_avatars.lock()
            .map_err(|_| CommandError::backend("received avatars lock"))?;
        persistence::save_at(&self.keys_dir, app.profiles().snapshot(), app.feed_snapshot(), &avatars,
            app.discussion().snapshot_comments(), app.discussion().snapshot_reactions())
            .map_err(CommandError::from)
    }

    /// Единственный путь к ядру: паника поймана, poisoned-lock — ошибка.
    fn call<R>(&self, f: impl FnOnce(&mut SferaApp) -> Result<R, CommandError>) -> Result<R, CommandError> {
        match catch_unwind(AssertUnwindSafe(|| {
            let mut app = self.app.lock().map_err(|_| CommandError::lock())?;
            f(&mut app)
        })) {
            Ok(r) => r,
            Err(_) => Err(CommandError::panic()),
        }
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut SferaApp) -> Result<R, CommandError>) -> Result<R, CommandError> {
        self.call(|app| {
            let result = f(app)?;
            self.persist_received_profiles(app)?;
            Ok(result)
        })
    }
    /// Приватные ключи Sfera для приёма конверта: только внутрь Rust-команды,
    /// в DTO/JS не возвращаются.
    pub fn encryption(&self) -> Result<social_keys::EncryptionIdentity, CommandError> {
        social_keys::load_at(&self.keys_dir)
            .map_err(|e| CommandError::backend(format!("encryption: {e}")))
    }

    /// Общий inbox: открыть конверт один раз и маршрутизировать по типу
    /// проверенного payload, а не пытаться принять комментарий как профиль.
    pub fn receive_envelope(
        &self,
        envelope: &social_delivery::SealedEnvelope,
    ) -> Result<OutcomeDto, CommandError> {
        let encryption = self.encryption()?;
        let (kind, outcome, profile_id, manifest) = self.call(|app| {
            let plaintext = social_delivery::open_payload(
                envelope, encryption.x25519_private_hex(), &envelope.from_x25519,
                encryption.pq_seed_hex(),
            ).map_err(|e| CommandError::input(e))?;
            if let Ok(payload) = social_discussion::parse_envelope_json(&plaintext) {
                let outcome = app.receive_discussion_payload(payload, 0)?;
                return Ok(("discussion".to_string(), outcome, String::new(), None));
            }
            let received = app.receive_profile_envelope(
                envelope, encryption.x25519_private_hex(), encryption.pq_seed_hex(),
            )?;
            let outcome = match received.outcome {
                social_app::ProfileUpsertOutcome::Inserted => social_discussion::EventOutcome::Inserted,
                social_app::ProfileUpsertOutcome::Updated => social_discussion::EventOutcome::Updated,
                social_app::ProfileUpsertOutcome::Duplicate => social_discussion::EventOutcome::Duplicate,
                social_app::ProfileUpsertOutcome::Stale => social_discussion::EventOutcome::Stale,
            };
            Ok(("profile".to_string(), outcome,
                received.profile_id, received.avatar_manifest))
        })?;
        if let Some(manifest) = manifest {
            self.received_avatars.lock().map_err(|_| CommandError::backend("received avatars lock"))?
                .insert(profile_id, manifest);
        }
        self.mutate(|_| Ok(OutcomeDto { v: API_VERSION, kind: Some(kind), outcome: format!("{outcome:?}").to_lowercase() }))
    }

    /// Обратная совместимость внешнего порта профиля.
    pub fn receive_profile_envelope(
        &self,
        envelope: &social_delivery::SealedEnvelope,
    ) -> Result<OutcomeDto, CommandError> {
        let encryption = self.encryption()?;
        let (outcome, profile_id, manifest) = self.call(|app| {
            let received = app.receive_profile_envelope(
                envelope,
                encryption.x25519_private_hex(),
                encryption.pq_seed_hex(),
            )?;
            Ok((received.outcome, received.profile_id, received.avatar_manifest))
        })?;
        if let Some(manifest) = manifest {
            self.received_avatars.lock().map_err(|_| CommandError::backend("received avatars lock"))?
                .insert(profile_id, manifest);
        }
        self.mutate(|_| Ok(outcome.into()))
    }

    /// Контакты нового проверенного bundle: меняем сразу, не требуя перезапуска.
    pub fn set_link_contacts(&self, contacts: Vec<social_link::LinkedContact>) -> Result<(), String> {
        let mut app = self.app.lock().map_err(|_| "app state lock poisoned".to_string())?;
        app.set_link_contacts(contacts);
        Ok(())
    }

    /// Каталог ключей нужен потоковому HTTP-протоколу: URL содержит только
    /// blob_id, ключ и локальный путь наружу не уходят.
    pub fn keys_dir(&self) -> &std::path::Path {
        &self.keys_dir
    }

    /// Хендл хранилища для async-команд: копируем Arc и не держим mutex
    /// во время сетевой/дисковой записи.
    pub fn store_handle(&self) -> Result<Arc<dyn storage_api::BlobStore>, CommandError> {
        let app = self.app.lock().map_err(|_| CommandError::lock())?;
        Ok(app.store().clone())
    }

    fn identity(&self) -> Result<IdentityDto, CommandError> {
        self.call(|app| {
            Ok(IdentityDto {
                v: API_VERSION,
                fp: app.identity().fingerprint().as_str().to_string(),
                pub_key: app.identity().author().pub_key.clone(),
            })
        })
    }
}

// ── DTO с версией ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IdentityDto { pub v: u8, pub fp: String, pub pub_key: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublishPostRequest {
    pub v: u8,
    pub ts: u64,
    pub body: String,
    pub audience: PostAudience,
    #[serde(default)]
    pub media: Vec<MediaRef>,
    pub now: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PostDto { pub v: u8, pub id: String, pub ts: u64 }

/// Структурное описание аудитории поста. Разбор wire-формы — на границе
/// Rust, подписи для людей — в локалях UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudienceViewDto {
    /// `all` | `sphere` | `selected` | `except`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Сколько отпечатков перечислено (для `selected`/`except`).
    pub count: usize,
}

fn audience_view(spec: &Audience) -> AudienceViewDto {
    match spec {
        Audience::AllContacts => AudienceViewDto { kind: "all".into(), id: None, count: 0 },
        Audience::Sphere { id } => {
            AudienceViewDto { kind: "sphere".into(), id: Some(id.clone()), count: 0 }
        }
        Audience::Selected { fps } => {
            AudienceViewDto { kind: "selected".into(), id: None, count: fps.len() }
        }
        Audience::AllExcept { fps } => {
            AudienceViewDto { kind: "except".into(), id: None, count: fps.len() }
        }
    }
}

/// Содержимое своего файла для просмотра. Ключ остался в Rust: наружу
/// уходит уже расшифрованный файл, MIME и размер plaintext.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LibraryContentDto {
    pub v: u8,
    pub blob_id: String,
    pub mime: String,
    pub kind: social_media_kind::MediaKind,
    pub size: u64,
    pub data_base64: String,
}

/// Запрос Range для стриминга: JS передаёт только границы. Выбор чанков,
/// расшифровка и кламп — в `social-library`, здесь нет протокольных решений.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LibraryRangeRequestDto {
    pub v: u8,
    pub blob_id: String,
    pub start: u64,
    /// `None` — до конца plaintext.
    pub end: Option<u64>,
}

/// Расшифрованный диапазон: границы после клампа и полный размер plaintext,
/// чтобы UI мог показать прогресс и запросить следующий кусок.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LibraryRangeDto {
    pub v: u8,
    pub blob_id: String,
    pub mime: String,
    pub size: u64,
    pub start: u64,
    pub end: u64,
    pub data_base64: String,
}

/// Адрес потокового просмотра. `url` собирает Rust с правильным для платформы
/// origin; JS только подставляет его в `<video>/<audio>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamDto {
    pub v: u8,
    pub blob_id: String,
    pub mime: String,
    pub size: u64,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceivePostsRequest {
    pub v: u8,
    pub posts: Vec<SignedPost>,
    pub received_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ReportDto { pub v: u8, pub inserted: usize, pub duplicates: usize, pub rejected: usize }

impl From<SyncReport> for ReportDto {
    fn from(r: SyncReport) -> Self {
        Self { v: API_VERSION, inserted: r.inserted, duplicates: r.duplicates, rejected: r.rejected }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetProfileRequest {
    pub v: u8,
    pub ts: u64,
    pub display_name: String,
    pub bio: String,
    #[serde(default)]
    pub avatar: Option<social_app::AvatarRef>,
    #[serde(default)]
    pub links: Vec<ProfileLink>,
    pub now: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccessRequest {
    pub v: u8,
    pub viewer: social_app::Fingerprint,
    pub audience: Audience,
    #[serde(default)]
    pub viewer_spheres: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContactRequestDto { pub v: u8, pub contact: ContactRecord }

/// Смена роли: только fp и роль. Состояние, сферы и overrides трогать нельзя —
/// это отдельные решения владельца (блокировка, история, точечные права).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetContactRoleDto {
    pub v: u8,
    pub fp: social_app::Fingerprint,
    pub role: social_app::Role,
}

/// Пресет прав роли для UI: честная подпись под селектором. Значения и права
/// приходят из `social-rights`; JS не держит свою таблицу соответствий.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleOptionDto {
    pub value: String,
    pub can_view_media: bool,
    pub can_react: bool,
    pub can_view_history: bool,
    pub can_request_chat: bool,
    pub profile: String,
}

fn role_options() -> Vec<RoleOptionDto> {
    social_app::Role::all()
        .into_iter()
        .map(|role| {
            let p = role.preset();
            RoleOptionDto {
                value: role.as_str().to_string(),
                can_view_media: p.can_view_media,
                can_react: p.can_react,
                can_view_history: p.can_view_history,
                can_request_chat: p.can_request_chat,
                profile: p.profile.as_str().to_string(),
            }
        })
        .collect()
}

/// Заявка на контакт: форма из social-contacts, без приватного ключа.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InviteDto { pub v: u8, pub request: social_contacts::ContactRequest }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudienceDto {
    pub v: u8,
    pub id: String,
    pub members: Vec<social_app::Fingerprint>,
}

/// Состав сферы для UI: id, текущая эпоха и отпечатки участников.
/// Ключи эпох остаются в Rust и не сериализуются.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudienceMembersDto {
    pub v: u8,
    pub id: String,
    pub epoch: u64,
    pub members: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ChangedDto { pub v: u8, pub changed: bool }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutcomeDto { pub v: u8, pub outcome: String, #[serde(default, skip_serializing_if = "Option::is_none")] pub kind: Option<String> }

impl From<social_app::ProfileUpsertOutcome> for OutcomeDto {
    fn from(o: social_app::ProfileUpsertOutcome) -> Self {
        let outcome = profile_outcome_name(o);
        Self { v: API_VERSION, outcome: outcome.into(), kind: None }
    }
}

fn profile_outcome_name(o: social_app::ProfileUpsertOutcome) -> &'static str {
    match o {
        social_app::ProfileUpsertOutcome::Inserted => "inserted",
        social_app::ProfileUpsertOutcome::Updated => "updated",
        social_app::ProfileUpsertOutcome::Duplicate => "duplicate",
        social_app::ProfileUpsertOutcome::Stale => "stale",
    }
}

/// Результат публикации: сколько адресных конвертов готово и сколько контактов
/// осталось без ключей. Сами ключи и адреса в DTO не попадают.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProfilePublicationDto {
    pub v: u8,
    pub outcome: String,
    pub sealed: usize,
    pub skipped: usize,
}

impl From<social_app::ProfilePublication> for ProfilePublicationDto {
    fn from(p: social_app::ProfilePublication) -> Self {
        Self {
            v: API_VERSION,
            outcome: profile_outcome_name(p.outcome).into(),
            sealed: p.sealed,
            skipped: p.skipped,
        }
    }
}

/// Аватар для UI: ссылка на блоб, без ключа файла и локального пути.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AvatarDto {
    pub v: u8,
    pub avatar: social_app::AvatarRef,
}

fn check(v: u8) -> Result<(), CommandError> {
    if v == API_VERSION { Ok(()) } else { Err(CommandError::version()) }
}

/// DTO содержимого: уже расшифрованные байты, MIME и размер plaintext.
/// Ключ и формат блоба остаются в Rust.
fn content_dto(o: social_library::Opened) -> LibraryContentDto {
    use base64::Engine as _;
    LibraryContentDto {
        v: API_VERSION,
        blob_id: o.blob_id,
        mime: o.mime,
        kind: o.kind,
        size: o.size,
        data_base64: base64::engine::general_purpose::STANDARD.encode(&o.bytes),
    }
}

fn range_dto(o: social_library::OpenedRange) -> LibraryRangeDto {
    use base64::Engine as _;
    LibraryRangeDto {
        v: API_VERSION,
        blob_id: o.blob_id,
        mime: o.mime,
        size: o.size,
        start: o.start,
        end: o.end,
        data_base64: base64::engine::general_purpose::STANDARD.encode(&o.bytes),
    }
}

// ── Команды ──────────────────────────────────────────────────────────────

/// Версия wire-контракта: UI сверяет её перед вызовами.
#[tauri::command]
fn social_api_version() -> u8 { API_VERSION }

#[tauri::command]
fn social_identity(state: tauri::State<'_, SferaState>) -> Result<IdentityDto, CommandError> {
    state.identity()
}

/// Опубликовать пост. Возвращает id поста — единственное, что нужно UI.
#[tauri::command]
fn social_publish_post(state: tauri::State<'_, SferaState>, req: PublishPostRequest) -> Result<PostDto, CommandError> {
    check(req.v)?;
    state.mutate(|app| {
        let post = app.publish_post(req.ts, req.body, req.audience, req.media, req.now)?;
        let id = social_app::PostId::from_post(&post.post)
            .map_err(|e| CommandError::input(e))?
            .to_hex();
        Ok(PostDto { v: API_VERSION, id, ts: post.post.ts })
    })
}

/// Принять входящие конверты с почты/релея.
#[tauri::command]
fn social_receive_posts(state: tauri::State<'_, SferaState>, req: ReceivePostsRequest) -> Result<ReportDto, CommandError> {
    check(req.v)?;
    state.mutate(|app| Ok(app.receive_posts(req.posts, req.received_at).into()))
}

/// Снимок ленты для UI. Порядок и дедуп посчитаны в `social-feed`.
#[tauri::command]
fn social_feed(state: tauri::State<'_, SferaState>) -> Result<Vec<serde_json::Value>, CommandError> {
    state.call(|app| {
        let me = app.identity().fingerprint().clone();
        app.feed().ordered().iter()
            .map(|e| {
                let mut value = serde_json::to_value(e).map_err(CommandError::input)?;
                // Аудитория и «мой пост» — структурными полями: UI не
                // разбирает wire-форму и не сравнивает ключи сам.
                if let Some(obj) = value.as_object_mut() {
                    obj.insert(
                        "audience_view".into(),
                        serde_json::to_value(audience_view(&e.post.post.audience.spec))
                            .map_err(CommandError::input)?,
                    );
                    obj.insert(
                        "is_mine".into(),
                        serde_json::to_value(e.post.post.author.fp.same(&me))
                            .map_err(CommandError::input)?,
                    );
                }
                Ok(value)
            })
            .collect()
    })
}

/// Варианты адресата для экрана «Создать»: id, эпоха и спецификация уже в
/// той форме, которую принимает `social_publish_post`. UI только передаёт
/// выбранный вариант обратно, ничего не собирая сам.
#[tauri::command]
fn social_audiences(state: tauri::State<'_, SferaState>) -> Result<Vec<PostAudience>, CommandError> {
    state.call(|app| {
        Ok(app.audiences()
            .map(|k| {
                let id = k.audience_id().to_string();
                PostAudience {
                    id: id.clone(),
                    epoch: k.epoch(),
                    spec: social_app::Audience::Sphere { id },
                }
            })
            .collect())
    })
}

/// Контакты для вкладки «Контакты». Состав и состояние — из
/// `social-contacts`; FFI только сериализует записи.
#[tauri::command]
fn social_contacts(state: tauri::State<'_, SferaState>) -> Result<Vec<serde_json::Value>, CommandError> {
    state.call(|app| {
        app.contacts().contacts()
            .map(|c| serde_json::to_value(c).map_err(CommandError::input))
            .collect()
    })
}

#[tauri::command]
fn social_mark_read(state: tauri::State<'_, SferaState>, post_id: String) -> Result<bool, CommandError> {
    state.call(|app| {
        let id: social_app::PostId = post_id.parse().map_err(CommandError::input)?;
        Ok(app.mark_read(&id))
    })
}

#[tauri::command]
fn social_set_my_profile(state: tauri::State<'_, SferaState>, req: SetProfileRequest) -> Result<ProfilePublicationDto, CommandError> {
    check(req.v)?;
    let avatar = req.avatar.clone();
    let manifest = match avatar {
        Some(ref a) => {
            let stored = social_library::avatar_at(&state.keys_dir)
                .map_err(|e| CommandError::backend(format!("avatar: {e}")))?
                .ok_or_else(|| CommandError::input("avatar manifest not found; upload avatar first"))?;
            if stored.blob_id != a.blob_id.to_hex() {
                return Err(CommandError::input("avatar does not match the remembered manifest"));
            }
            Some(serde_json::to_value(stored).map_err(CommandError::input)?)
        }
        None => {
            social_library::forget_avatar_at(&state.keys_dir)
                .map_err(|e| CommandError::backend(format!("avatar: {e}")))?;
            None
        }
    };
    state.mutate(|app| {
        Ok(app.set_my_profile(
            req.ts, req.display_name, req.bio, req.avatar, req.links, req.now, manifest,
        )?.into())
    })
}

#[tauri::command]
fn social_profile(state: tauri::State<'_, SferaState>, fp: String) -> Result<Option<serde_json::Value>, CommandError> {
    state.call(|app| {
        let fp = social_app::Fingerprint::from_str(&fp);
        match app.profile_of(&fp) {
            None => Ok(None),
            Some(p) => {
                let mut value = serde_json::to_value(p).map_err(CommandError::input)?;
                if let (Some(avatar), Some(id)) = (
                    value.get_mut("profile").and_then(|p| p.get_mut("avatar")),
                    p.profile.avatar.as_ref().map(|_| social_profile::profile_id(p)),
                ) {
                    if let Some(object) = avatar.as_object_mut() {
                        object.insert("profile_id".into(), serde_json::Value::String(id));
                    }
                }
                Ok(Some(value))
            }
        }
    })
}

/// Принять адресный профиль: ключи читаются из app data и не покидают Rust.
#[tauri::command]
fn social_receive_profile(
    state: tauri::State<'_, SferaState>,
    envelope: social_delivery::SealedEnvelope,
) -> Result<OutcomeDto, CommandError> {
    state.receive_profile_envelope(&envelope)
}

/// Единственное решение о доступе — в `social-rights`; FFI только передаёт.
#[tauri::command]
fn social_access(state: tauri::State<'_, SferaState>, req: AccessRequest) -> Result<Option<serde_json::Value>, CommandError> {
    check(req.v)?;
    state.call(|app| {
        Ok(app.access(&req.viewer, &req.audience, &req.viewer_spheres)
            .map(|a| serde_json::to_value(a).map_err(CommandError::input))
            .transpose()?)
    })
}

#[tauri::command]
fn social_put_contact(state: tauri::State<'_, SferaState>, req: ContactRequestDto) -> Result<(), CommandError> {
    check(req.v)?;
    state.call(|app| { app.put_contact(req.contact); Ok(()) })
}

/// Смена роли принятого контакта: проверку и запись делает `social-contacts`.
#[tauri::command]
fn social_set_contact_role(
    state: tauri::State<'_, SferaState>,
    req: SetContactRoleDto,
) -> Result<(), CommandError> {
    check(req.v)?;
    state.call(|app| {
        app.set_contact_role(&req.fp, req.role)
            .map_err(|e| CommandError::input(format!("{e:?}")))
    })
}

/// Пресеты прав по ролям — для подписи под селектором в UI.
#[tauri::command]
fn social_role_options() -> Result<Vec<RoleOptionDto>, CommandError> {
    Ok(role_options())
}

#[tauri::command]
fn social_create_audience(state: tauri::State<'_, SferaState>, req: AudienceDto) -> Result<(), CommandError> {
    check(req.v)?;
    state.call(|app| { app.create_audience(req.id, req.members); Ok(()) })
}

#[tauri::command]
fn social_set_audience_members(state: tauri::State<'_, SferaState>, req: AudienceDto) -> Result<ChangedDto, CommandError> {
    check(req.v)?;
    state.call(|app| {
        Ok(ChangedDto {
            v: API_VERSION,
            changed: app.set_audience_members(&req.id, req.members)?
                == social_app::MembershipChange::Changed,
        })
    })
}

/// Состав сферы для экрана «Контакты»: без ключей, только отпечатки и эпоха.
#[tauri::command]
fn social_audience_members(
    state: tauri::State<'_, SferaState>,
    id: String,
) -> Result<AudienceMembersDto, CommandError> {
    state.call(|app| {
        let keys = app
            .audience(&id)
            .ok_or_else(|| CommandError::input("unknown audience"))?;
        Ok(AudienceMembersDto {
            v: API_VERSION,
            id: keys.audience_id().to_string(),
            epoch: keys.epoch(),
            members: keys.members().map(str::to_string).collect(),
        })
    })
}

/// Опубликовать пост с уже загруженным медиа. `MediaRef` и E2E-манифест
/// собираются в Rust из результата загрузки: UI не знает ни ключ, ни локатор.
#[tauri::command]
fn social_publish_with_media(
    state: tauri::State<'_, SferaState>,
    req: PublishPostRequest,
    uploaded: Vec<social_upload::UploadResult>,
) -> Result<PostDto, CommandError> {
    check(req.v)?;
    let mut media = Vec::with_capacity(uploaded.len());
    let mut manifests = Vec::with_capacity(uploaded.len());
    for u in &uploaded {
        let blob_id = storage_api::BlobId::from_bytes(
            hex::decode(&u.blob_id)
                .map_err(|e| CommandError::input(format!("blob id: {e}")))?
                .try_into()
                .map_err(|_| CommandError::input("blob id must be 32 bytes"))?,
        );
        media.push(social_post::MediaRef {
            blob_id,
            // Миниатюра — отдельный блоб; её id нужен получателю, чтобы
            // показать превью без скачивания полного файла.
            thumb_blob_id: u.thumb.as_ref().and_then(|t| {
                hex::decode(&t.blob_id)
                    .ok()?
                    .try_into()
                    .ok()
                    .map(storage_api::BlobId::from_bytes)
            }),
            mime: u.mime.clone(),
            size: u.size,
        });
        // post_id станет известен после подписи; манифест собираем там же.
        manifests.push(u.clone());
    }
    state.call(|app| {
        let post = app.publish_post(req.ts, req.body, req.audience, media, req.now)?;
        let id = social_app::PostId::from_post(&post.post)
            .map_err(|e| CommandError::input(e))?
            .to_hex();
        for u in &manifests {
            let m = social_upload::build_manifest(&id, u)
                .map_err(|e| CommandError::input(format!("manifest: {e:?}")))?;
            // Манифест едет в E2E-конверте; здесь проверяем форму до отправки.
            m.validate().map_err(|e| CommandError::input(format!("manifest: {e:?}")))?;
        }
        Ok(PostDto { v: API_VERSION, id, ts: post.post.ts })
    })
}

/// Загрузить файл: шифрование в `social-media`, запись через `BlobStore`.
/// base64 приходит из UI; ключ файла уходит только в ответе и должен попасть
/// в E2E-конверт, а не в хранилище или логи (ADR-006 §5.2).
/// Общая загрузка медиа: ключ сохраняется в каталоге, наружу не уходит.
async fn upload_media(
    state: &SferaState,
    mime: String,
    data_base64: String,
) -> Result<social_upload::UploadResult, CommandError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| CommandError::input(format!("bad base64: {e}")))?;
    let store = state.store_handle()?;
    let result = social_upload::upload_encrypted(store.as_ref(), &mime, &bytes)
        .await
        .map_err(|e| CommandError::backend(format!("upload: {e}")))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    social_library::remember_at(&state.keys_dir, &result, now)
        .map_err(|e| CommandError::backend(format!("library: {e}")))?;
    Ok(result)
}

#[tauri::command]
async fn social_upload_media(
    state: tauri::State<'_, SferaState>,
    mime: String,
    data_base64: String,
) -> Result<social_upload::UploadResult, CommandError> {
    upload_media(&state, mime, data_base64).await
}

/// Загрузить аватар и запомнить его манифест. В ответе только `AvatarRef`:
/// file_key, URI и ключи шифрования профиля в JS не попадают.
#[tauri::command]
async fn social_upload_avatar(
    state: tauri::State<'_, SferaState>,
    mime: String,
    data_base64: String,
) -> Result<AvatarDto, CommandError> {
    let result = upload_media(&state, mime, data_base64).await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    social_library::remember_avatar_at(&state.keys_dir, &result.blob_id, now)
        .map_err(|e| CommandError::backend(format!("avatar: {e}")))?;
    let blob_id = storage_api::BlobId::from_bytes(
        hex::decode(&result.blob_id)
            .map_err(|e| CommandError::input(format!("blob id: {e}")))?
            .try_into()
            .map_err(|_| CommandError::input("blob id must be 32 bytes"))?,
    );
    Ok(AvatarDto {
        v: API_VERSION,
        avatar: social_app::AvatarRef { blob_id, mime: result.mime, size: result.size },
    })
}

/// Список своих файлов для галереи: без ключей и локальных путей.
#[tauri::command]
fn social_library_items(state: tauri::State<'_, SferaState>) -> Result<Vec<social_library::LibraryItem>, CommandError> {
    social_library::items_at(&state.keys_dir)
        .map_err(|e| CommandError::backend(format!("library: {e}")))
}

/// Убрать файл из локального каталога. Сам зашифрованный блоб остаётся в
/// хранилище: удаление из списка не равно удалению данных (ADR-006 §5.2).
#[tauri::command]
fn social_library_forget(state: tauri::State<'_, SferaState>, blob_id: String) -> Result<bool, CommandError> {
    social_library::forget_at(&state.keys_dir, &blob_id)
        .map_err(|e| CommandError::backend(format!("library: {e}")))
}

/// Прочитать и расшифровать свой файл для предпросмотра. Расшифровка и
/// поиск ключа — в `social-library`; FFI только кодирует байты в base64.
/// `None` — файла нет в каталоге (например, запись удалена).
#[tauri::command]
async fn social_library_open(
    state: tauri::State<'_, SferaState>,
    blob_id: String,
) -> Result<Option<LibraryContentDto>, CommandError> {
    let store = state.store_handle()?;
    let opened = social_library::open_at(&state.keys_dir, store.as_ref(), &blob_id)
        .await
        .map_err(|e| CommandError::backend(format!("library: {e}")))?;
    Ok(opened.map(content_dto))
}

/// Прочитать полуоткрытый диапазон своего файла, не загружая его целиком.
/// Границы и версия проверяются на границе, чанки и шифр — в `social-library`.
async fn library_open_range(
    state: &SferaState,
    req: LibraryRangeRequestDto,
) -> Result<Option<LibraryRangeDto>, CommandError> {
    check(req.v)?;
    let range = Range::new(req.start, req.end).map_err(CommandError::input)?;
    let store = state.store_handle()?;
    let opened = social_library::open_range_at(&state.keys_dir, store.as_ref(), &req.blob_id, range)
        .await
        .map_err(|e| CommandError::backend(format!("library: {e}")))?;
    Ok(opened.map(range_dto))
}

#[tauri::command]
async fn social_library_open_range(
    state: tauri::State<'_, SferaState>,
    req: LibraryRangeRequestDto,
) -> Result<Option<LibraryRangeDto>, CommandError> {
    library_open_range(&state, req).await
}

/// Потоковый адрес своего файла без чтения самого файла. `None` — записи нет
/// в каталоге; `mime` и размер приходят из заголовка VAULTBLOB1.
#[tauri::command]
async fn social_library_stream(
    state: tauri::State<'_, SferaState>,
    blob_id: String,
) -> Result<Option<StreamDto>, CommandError> {
    let Some((mime, size)) = stream_info(&state, &blob_id).await? else {
        return Ok(None);
    };
    Ok(Some(StreamDto {
        v: API_VERSION,
        url: media_url(&blob_id),
        blob_id,
        mime,
        size,
    }))
}

/// Прочитать и расшифровать миниатюру своего файла. `None` — миниатюры нет
/// (не изображение или файл загружен до её появления).
#[tauri::command]
async fn social_library_thumb(
    state: tauri::State<'_, SferaState>,
    blob_id: String,
) -> Result<Option<LibraryContentDto>, CommandError> {
    let store = state.store_handle()?;
    let opened = social_library::open_thumb_at(&state.keys_dir, store.as_ref(), &blob_id)
        .await
        .map_err(|e| CommandError::backend(format!("library: {e}")))?;
    Ok(opened.map(content_dto))
}

/// Открыть ЧУЖОЙ аватар по стабильному ID автора. Манифест и его ключ были
/// приняты проверенным E2E-конвертом и остаются внутри Rust.
#[tauri::command]
async fn social_open_received_avatar(
    state: tauri::State<'_, SferaState>,
    profile_id: String,
) -> Result<LibraryContentDto, CommandError> {
    let manifest = state.received_avatars.lock()
        .map_err(|_| CommandError::backend("received avatars lock"))?
        .get(&profile_id).cloned()
        .ok_or_else(|| CommandError::input("profile has no received avatar"))?;
    let store = state.store_handle()?;
    let opened = social_library::open_avatar_with_optional_store(Some(store.as_ref()), &manifest)
        .await
        .map_err(|e| CommandError::backend(format!("avatar: {e}")))?;
    Ok(content_dto(opened))
}

/// Создание комментария: целевая аудитория берётся из поста в Rust.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommentRequest {
    pub v: u8,
    pub post_id: String,
    pub parent_id: Option<String>,
    pub ts: u64,
    pub body: String,
    #[serde(default)]
    pub media: Vec<MediaRef>,
    pub now: u64,
}

#[tauri::command]
fn social_comment_on_post(
    state: tauri::State<'_, SferaState>, req: CommentRequest,
) -> Result<social_discussion::SignedComment, CommandError> {
    check(req.v)?;
    let post_id: social_app::PostId = req.post_id.parse().map_err(CommandError::input)?;
    state.mutate(|app| Ok(app.comment_on_post(
        &post_id, req.parent_id, req.ts, &req.body, req.media, req.now,
    )?))
}

#[tauri::command]
fn social_receive_comment(
    state: tauri::State<'_, SferaState>, post_id: String,
    comment: social_discussion::SignedComment,
) -> Result<String, CommandError> {
    let post_id: social_app::PostId = post_id.parse().map_err(CommandError::input)?;
    state.mutate(|app| Ok(format!("{:?}", app.receive_comment(&post_id, comment)?).to_lowercase()))
}

/// Реакция: следующую версию вычисляет Rust по сохранённым событиям.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReactionRequest {
    pub v: u8,
    pub post_id: String,
    pub emoji: String,
    #[serde(default)]
    pub removed: bool,
    pub now: u64,
}

#[tauri::command]
fn social_react_to_post(
    state: tauri::State<'_, SferaState>, req: ReactionRequest,
) -> Result<social_discussion::SignedReaction, CommandError> {
    check(req.v)?;
    let post_id: social_app::PostId = req.post_id.parse().map_err(CommandError::input)?;
    state.mutate(|app| Ok(app.react_to_post(&post_id, &req.emoji, req.removed, req.now)?))
}

#[tauri::command]
fn social_receive_reaction(
    state: tauri::State<'_, SferaState>, post_id: String,
    reaction: social_discussion::SignedReaction,
) -> Result<String, CommandError> {
    let post_id: social_app::PostId = post_id.parse().map_err(CommandError::input)?;
    state.mutate(|app| Ok(format!("{:?}", app.receive_reaction(&post_id, reaction)?).to_lowercase()))
}

#[tauri::command]
fn social_discussion(
    state: tauri::State<'_, SferaState>, post_id: String,
) -> Result<serde_json::Value, CommandError> {
    let post_id: social_app::PostId = post_id.parse().map_err(CommandError::input)?;
    let target = post_id.to_hex().parse::<social_discussion::PostRef>()
        .map_err(|e| CommandError::input(e.to_string()))?;
    state.call(|app| {
        let comments = app.discussion().comments_for(&target);
        let mut reactions = app.discussion().reactions_for(&target);
        reactions.sort_by(|a, b| a.reaction.author.fp.as_str().cmp(b.reaction.author.fp.as_str())
            .then_with(|| a.reaction.emoji.cmp(&b.reaction.emoji)));
        let mut grouped: Vec<serde_json::Value> = Vec::new();
        for reaction in reactions {
            let author = reaction.reaction.author.fp.as_str().to_string();
            let emoji = reaction.reaction.emoji.clone();
            if let Some(group) = grouped.iter_mut().find(|g| g["emoji"] == emoji) {
                group["count"] = serde_json::json!(group["count"].as_u64().unwrap_or(0) + 1);
                group["authors"].as_array_mut().expect("reaction authors").push(serde_json::json!(author));
            } else {
                grouped.push(serde_json::json!({"emoji": emoji, "count": 1, "authors": [author]}));
            }
        }
        grouped.sort_by(|a, b| a["emoji"].as_str().unwrap_or("").cmp(b["emoji"].as_str().unwrap_or("")));
        Ok(serde_json::json!({
            "v": API_VERSION, "post_id": post_id.to_hex(),
            "comments": comments, "reactions": grouped,
        }))
    })
}

/// Принять приглашение/заявку: дедуп по (from,to,nonce) и переход состояния
/// живут в social-contacts; FFI только передаёт готовую форму (ADR-006 §4.1).
#[tauri::command]
fn social_accept_contact_request(
    state: tauri::State<'_, SferaState>,
    req: InviteDto,
) -> Result<bool, CommandError> {
    check(req.v)?;
    state.call(|app| {
        let outcome = app.contacts_mut().accept_request(&req.request)
            .map_err(|e| CommandError::input(format!("{e:?}")))?;
        Ok(outcome == social_contacts::RequestOutcome::Accepted)
    })
}

/// Что видно в ленте про очередь: только числа. UI честно покажет, что
/// порт доставки не подключён, вместо выдуманного «Отправлено».
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatusDto {
    pub v: u8,
    pub pending: usize,
    pub failed: usize,
    pub due: usize,
    pub has_transport: bool,
}

fn sync_status(app: &SferaApp, now: u64, has_transport: bool) -> SyncStatusDto {
    let outbox = app.outbox();
    SyncStatusDto {
        v: API_VERSION,
        pending: outbox.pending_count(),
        failed: outbox.failed_count(),
        due: outbox.due(now).len(),
        has_transport,
    }
}

#[tauri::command]
fn social_sync_status(
    state: tauri::State<'_, SferaState>,
    now: u64,
) -> Result<SyncStatusDto, CommandError> {
    let has_transport = state.delivery.is_some();
    state.call(|app| Ok(sync_status(app, now, has_transport)))
}

/// Прогнать outbox через порт доставки. Без порта — типизированная ошибка.
#[tauri::command]
fn social_sync_outbox(state: tauri::State<'_, SferaState>, now: u64) -> Result<ReportDto, CommandError> {
    let delivery = state.delivery.clone().ok_or_else(|| CommandError::new("transport", "no delivery port"))?;
    state.call(move |app| {
        let r = app.sync_outbox(now, |item| delivery.send(item));
        Ok(ReportDto { v: API_VERSION, inserted: r.sent, duplicates: r.retried, rejected: r.failed })
    })
}

#[tauri::command]
fn social_store_caps(state: tauri::State<'_, SferaState>) -> Result<StoreCaps, CommandError> {
    state.call(|app| Ok(app.store().caps()))
}

/// Какие команды обслуживает этот крейт. Оболочке нужно собрать несколько
/// handler'ов в один `invoke_handler` (tauri допускает только один), поэтому
/// список имён живёт рядом с командами, а не в оболочке.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "social_api_version"
            | "social_identity"
            | "social_publish_post"
            | "social_comment_on_post"
            | "social_receive_comment"
            | "social_react_to_post"
            | "social_receive_reaction"
            | "social_discussion"
            | "social_receive_posts"
            | "social_feed"
            | "social_contacts"
            | "social_audiences"
            | "social_mark_read"
            | "social_set_my_profile"
            | "social_receive_profile"
            | "social_profile"
            | "social_access"
            | "social_put_contact"
            | "social_set_contact_role"
            | "social_role_options"
            | "social_accept_contact_request"
            | "social_upload_media"
            | "social_upload_avatar"
            | "social_library_items"
            | "social_library_forget"
            | "social_library_open"
            | "social_library_open_range"
            | "social_library_stream"
            | "social_library_thumb"
            | "social_open_received_avatar"
            | "social_publish_with_media"
            | "social_create_audience"
            | "social_set_audience_members"
            | "social_audience_members"
            | "social_sync_outbox"
            | "social_sync_status"
            | "social_store_caps"
    )
}

/// Регистратор всех `social_*` команд для Tauri-приложения.
///
/// Команды намеренно приватные: `#[tauri::command]` на `pub fn` в tauri 2.12
/// создаёт `#[macro_export]` для `__cmd__*`, и имена сталкиваются в глобальной
/// области модуля (E0255). `generate_handler!` видит приватные команды в этом
/// же модуле, поэтому наружу отдаётся только готовый handler.
pub fn social_commands_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        social_api_version,
        social_identity,
        social_publish_post,
        social_comment_on_post,
        social_receive_comment,
        social_react_to_post,
        social_receive_reaction,
        social_discussion,
        social_receive_posts,
        social_feed,
        social_contacts,
        social_audiences,
        social_mark_read,
        social_set_my_profile,
        social_receive_profile,
        social_profile,
        social_access,
        social_put_contact,
        social_set_contact_role,
        social_role_options,
        social_accept_contact_request,
        social_upload_media,
        social_upload_avatar,
        social_library_items,
        social_library_forget,
        social_library_open,
        social_library_open_range,
        social_library_stream,
        social_library_thumb,
        social_open_received_avatar,
        social_publish_with_media,
        social_create_audience,
        social_set_audience_members,
        social_audience_members,
        social_sync_outbox,
        social_sync_status,
        social_store_caps,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use social_app::Identity;
    use social_library::AvatarManifest;
    use social_profile::ProfileV1;
    use social_sync::{Quota, RetryPolicy};
    use storage_local::LocalStore;

    const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";

    fn state() -> SferaState {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path()).unwrap();
        let app = SferaApp::new(
            Identity::from_seed(SEED).unwrap(),
            Arc::new(store),
            RetryPolicy::default(),
            Quota::new(60, 10_000, 10, 0),
        );
        SferaState::new(app, None)
    }

    #[test]
    fn version_and_identity_contract() {
        assert_eq!(social_api_version(), API_VERSION);
        let id = state().identity().unwrap();
        assert_eq!(id.v, API_VERSION);
        assert!((16..=64).contains(&id.fp.len()), "fp len {}", id.fp.len());
        assert!(!id.pub_key.is_empty());
    }

    #[test]
    fn audience_view_is_structural_not_localized() {
        use social_model::Fingerprint;
        let all = audience_view(&Audience::AllContacts);
        assert_eq!(all.kind, "all");
        assert_eq!(all.id, None);

        let sphere = audience_view(&Audience::Sphere { id: "fam".into() });
        assert_eq!(sphere.kind, "sphere");
        assert_eq!(sphere.id.as_deref(), Some("fam"));

        let fp = |s: &str| Fingerprint::from_str(s);
        let selected = audience_view(&Audience::Selected {
            fps: vec![fp("02:00:00:00:00:00:00:00:****"), fp("03:00:00:00:00:00:00:00:****")],
        });
        assert_eq!(selected.kind, "selected");
        assert_eq!(selected.count, 2);

        let except = audience_view(&Audience::AllExcept { fps: vec![fp("02:00:00:00:00:00:00:00:****")] });
        assert_eq!(except.kind, "except");
        assert_eq!(except.count, 1);
    }

    #[test]
    fn sync_status_reports_queue_and_missing_port() {
        let st = state();
        let s = st.call(|app| Ok(sync_status(app, 1000, false))).unwrap();
        assert_eq!(s.v, API_VERSION);
        assert_eq!(s.pending, 0);
        assert_eq!(s.failed, 0);
        assert_eq!(s.due, 0);
        assert!(!s.has_transport);
    }

    #[test]
    fn discussion_goes_from_sealed_outbox_to_inbox_without_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let recipient = social_keys::EncryptionIdentity::generate([22; 32]).unwrap();
        social_keys::save_at(&dir.path().join("keys"), &recipient).unwrap();
        let store = Arc::new(LocalStore::new(dir.path().join("blobs")).unwrap());
        let app = SferaApp::new(Identity::from_seed(SEED).unwrap(), store,
            RetryPolicy::default(), Quota::new(60, 10_000, 10, 0));
        let st = SferaState::new(app, None).with_keys_dir(dir.path().join("keys"));
        let post = st.call(|app| Ok(app.publish_post(1, "post", PostAudience {
            id: "family".into(), epoch: 1, spec: Audience::AllContacts,
        }, vec![], 1)?)).unwrap();
        let _id = social_app::PostId::from_post(&post.post).unwrap();
        st.call(|app| Ok(app.receive_posts([post.clone()], 1))).unwrap();
        st.call(|app| {
            let fp = social_model::Fingerprint::from_public_key_hex(
                &social_model::post::public_key_hex(&"02".repeat(32)).unwrap()).unwrap();
            app.put_contact(ContactRecord::contact(fp, social_app::Role::Friend, vec![], true));
            Ok(())
        }).unwrap();
        let comment = social_discussion::compose_comment(
            &"02".repeat(32), &"44".repeat(32),
            social_discussion::DiscussionTarget {
                post_id: social_discussion::PostRef::from_post(&post.post).unwrap(),
                post_author: post.post.author.fp.clone(), audience: post.post.audience.clone(),
            }, None, 2, "СЕКРЕТНЫЙ_ОТВЕТ", vec![],
        ).unwrap();
        let plaintext = social_discussion::envelope_json(
            &social_discussion::DiscussionPayload::SocialComment(comment)).unwrap();
        let sender = social_keys::EncryptionIdentity::generate([11; 32]).unwrap();
        let envelope = social_delivery::seal_payload(&plaintext, &sender.sender_material(),
            &social_delivery::RecipientKeyMaterial {
                fp: recipient.fingerprint().unwrap(),
                x25519_public_hex: recipient.x25519_public_hex().into(),
                pq_ek_b64: recipient.pq_ek_b64().into(), address: "peer@example.org".into(),
            }).unwrap();
        assert!(!serde_json::to_string(&envelope).unwrap().contains("СЕКРЕТНЫЙ_ОТВЕТ"));
        let result = st.receive_envelope(&envelope).unwrap();
        assert_eq!(result.kind.as_deref(), Some("discussion"));
        assert_eq!(result.outcome, "inserted");
        st.call(|app| {
            let target = social_discussion::PostRef::from_post(&post.post).unwrap();
            assert_eq!(app.discussion().comments_for(&target).len(), 1);
            assert_eq!(app.discussion().comments_for(&target)[0].comment.body, "СЕКРЕТНЫЙ_ОТВЕТ");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn feed_and_discussion_survive_state_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalStore::new(dir.path().join("blobs")).unwrap());
        let app = SferaApp::new(Identity::from_seed(SEED).unwrap(), store.clone(),
            RetryPolicy::default(), Quota::new(60, 10_000, 10, 0));
        let st = SferaState::new(app, None).with_keys_dir(dir.path());
        let post = st.call(|app| Ok(app.publish_post(10, "Сохранённый пост", PostAudience {
            id: "family".into(), epoch: 1, spec: Audience::AllContacts,
        }, vec![], 10)?)).unwrap();
        let id = social_app::PostId::from_post(&post.post).unwrap();
        st.call(|app| Ok(app.receive_posts([post.clone()], 10))).unwrap();
        st.call(|app| Ok(app.comment_on_post(&id, None, 20, "Сохранённый ответ", vec![], 20)?)).unwrap();
        st.call(|app| Ok(app.react_to_post(&id, "❤️", false, 20)?)).unwrap();
        st.call(|app| st.persist_received_profiles(app)).unwrap();

        let restored = SferaState::new(SferaApp::new(Identity::from_seed(SEED).unwrap(), store,
            RetryPolicy::default(), Quota::new(60, 10_000, 10, 0)), None)
            .with_keys_dir(dir.path()).load_received_profiles().unwrap();
        restored.call(|app| {
            assert_eq!(app.feed_snapshot().len(), 1);
            let target = social_discussion::PostRef::from_post(&post.post).unwrap();
            assert_eq!(app.discussion().comments_for(&target).len(), 1);
            assert_eq!(app.discussion().reactions_for(&target).len(), 1);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn received_book_survives_new_state_and_profile_dto_has_avatar_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalStore::new(dir.path().join("blobs")).unwrap());
        let app = SferaApp::new(
            Identity::from_seed(SEED).unwrap(), store.clone(),
            RetryPolicy::default(), Quota::new(60, 10_000, 10, 0),
        );
        let st = SferaState::new(app, None).with_keys_dir(dir.path());
        let blob_id = "44".repeat(32);
        let manifest = AvatarManifest {
            blob_id: blob_id.clone(), content_id: "received".into(), uri: "sha256-".to_string() + &blob_id,
            file_key_hex: "55".repeat(32), nonce_prefix_hex: "00".repeat(8),
            mime: "image/png".into(), size: 3, store_id: "local".into(), thumb: None, set_at: 1,
        };
        let identity = social_app::Identity::from_seed("02".repeat(32).as_str()).unwrap();
        let author = identity.author();
        let signed = social_profile::sign_profile(
            &"02".repeat(32),
            &ProfileV1::new(
                author.clone(), 1, "Persisted Peer", "",
                Some(social_app::AvatarRef { blob_id: storage_api::BlobId::from_bytes([0x44; 32]), mime: "image/png".into(), size: 3 }),
                Vec::new(),
            ).unwrap(),
        ).unwrap();
        st.call(|app| { app.receive_profile(signed.clone())?; Ok(()) }).unwrap();
        persistence::save_at(dir.path(), vec![signed.clone()], vec![], &HashMap::from([(social_profile::profile_id(&signed), manifest)]), vec![], vec![]).unwrap();
        assert!(dir.path().join(persistence::FILE).exists());

        let restored = SferaState::new(
            SferaApp::new(Identity::from_seed(SEED).unwrap(), store,
                RetryPolicy::default(), Quota::new(60, 10_000, 10, 0)),
            None,
        ).with_keys_dir(dir.path()).load_received_profiles().unwrap();
        let profile = restored.call(|app| {
            let p = app.profile_of(&signed.profile.author.fp)
                .ok_or_else(|| CommandError::input("profile not restored"))?;
            let mut value = serde_json::to_value(p).map_err(CommandError::input)?;
            value["profile"]["avatar"]["profile_id"] = serde_json::Value::String(social_profile::profile_id(p));
            Ok(value)
        }).unwrap();
        assert_eq!(profile["profile"]["display_name"], "Persisted Peer");
        assert_eq!(profile["profile"]["avatar"]["profile_id"], social_profile::profile_id(&signed));
        let bytes = std::fs::read_to_string(dir.path().join(persistence::FILE)).unwrap();
        assert!(bytes.contains("Persisted Peer"));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join(persistence::FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Манифест восстановлен вместе с профилем: открытие не требует нового письма.
        assert_eq!(restored.received_avatars.lock().unwrap().len(), 1);
        let mut damaged: serde_json::Value = serde_json::from_str(&bytes).unwrap();
        damaged["profiles"][0]["sig"] = serde_json::Value::String("00".repeat(64));
        std::fs::write(dir.path().join(persistence::FILE), serde_json::to_vec(&damaged).unwrap()).unwrap();
        assert!(persistence::load_at(dir.path(), &mut SferaApp::new(
            Identity::from_seed(SEED).unwrap(), Arc::new(LocalStore::new(dir.path().join("other")).unwrap()),
            RetryPolicy::default(), Quota::new(60, 10_000, 10, 0),
        )).is_err());
    }

    #[tokio::test]
    async fn avatar_upload_returns_ref_without_key_and_remembers_manifest() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path().join("blobs")).unwrap();
        let app = SferaApp::new(
            Identity::from_seed(SEED).unwrap(),
            Arc::new(store),
            RetryPolicy::default(),
            Quota::new(60, 10_000, 10, 0),
        );
        let st = SferaState::new(app, None).with_keys_dir(dir.path());
        let dto = upload_media(
            &st,
            "image/png".into(),
            base64::engine::general_purpose::STANDARD.encode(b"avatar bytes"),
        ).await.unwrap();
        social_library::remember_avatar_at(dir.path(), &dto.blob_id, 30).unwrap();
        let stored = social_library::avatar_at(dir.path()).unwrap().unwrap();
        assert_eq!(stored.blob_id, dto.blob_id);
        let blob_id = storage_api::BlobId::from_bytes(
            hex::decode(&dto.blob_id).unwrap().try_into().unwrap(),
        );
        let response = AvatarDto {
            v: API_VERSION,
            avatar: social_app::AvatarRef { blob_id, mime: dto.mime.clone(), size: dto.size },
        };
        let wire = serde_json::to_string(&response).unwrap();
        assert!(!wire.contains(&dto.file_key_hex));
        assert!(!wire.contains(&dto.uri));
        assert_eq!(response.avatar.blob_id.to_hex(), dto.blob_id);
    }

    #[test]
    fn profile_publication_dto_reports_delivery_counts() {
        let dto = ProfilePublicationDto::from(social_app::ProfilePublication {
            outcome: social_app::ProfileUpsertOutcome::Updated,
            sealed: 2,
            skipped: 1,
        });
        assert_eq!(dto.outcome, "updated");
        assert_eq!(dto.sealed, 2);
        assert_eq!(dto.skipped, 1);
    }

    #[test]
    fn version_check_rejects_foreign_wire() {
        assert_eq!(check(API_VERSION).map(|_| ()).map_err(|e| e.code), Ok(()));
        assert_eq!(check(API_VERSION + 1).unwrap_err().code, "version");
    }

    #[test]
    fn no_delivery_port_is_typed_error() {
        let st = state();
        let delivery: Result<Arc<dyn DeliveryPort>, CommandError> = st.delivery.clone()
            .ok_or_else(|| CommandError::new("transport", "no delivery port"));
        assert_eq!(delivery.err().map(|e| e.code), Some("transport".to_string()));
    }

    #[test]
    fn contacts_are_listed_after_put() {
        let st = state();
        let fp = social_app::Fingerprint::from_str("02:00:00:00:00:00:00:00:****");
        let record = ContactRecord::contact(
            fp.clone(),
            social_app::Role::Friend,
            vec!["close".into()],
            false,
        );
        st.call(|app| { app.put_contact(record); Ok(()) }).unwrap();
        let listed: Vec<serde_json::Value> = st
            .call(|app| {
                app.contacts().contacts()
                    .map(|c| serde_json::to_value(c).map_err(CommandError::input))
                    .collect()
            })
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["fp"], serde_json::json!(fp.as_str()));
        assert_eq!(listed[0]["role"], serde_json::json!("friend"));
    }

    #[test]
    fn role_options_come_from_rights_not_ui() {
        let options = role_options();
        assert_eq!(options.len(), 4);
        assert_eq!(options[0].value, "close");
        assert!(options[0].can_view_history);
        // У знакомого история выключена дефолтом, а profile — краткий.
        let acquaintance = options.iter().find(|o| o.value == "acquaintance").unwrap();
        assert!(acquaintance.can_view_media);
        assert!(!acquaintance.can_view_history);
        assert_eq!(acquaintance.profile, "brief");
        let restricted = options.iter().find(|o| o.value == "restricted").unwrap();
        assert!(!restricted.can_view_media);
        assert_eq!(restricted.profile, "none");
    }

    #[test]
    fn set_contact_role_command_changes_only_role() {
        let st = state();
        let fp = social_app::Fingerprint::from_str("02:00:00:00:00:00:00:00:****");
        st.call(|app| {
            app.put_contact(ContactRecord::contact(
                fp.clone(),
                social_app::Role::Friend,
                vec!["work".into()],
                true,
            ));
            Ok(())
        }).unwrap();

        let req = SetContactRoleDto {
            v: API_VERSION,
            fp: fp.clone(),
            role: social_app::Role::Restricted,
        };
        // Тело команды вызывается напрямую: tauri::State вне рантайма не создать.
        st.call(|app| app.set_contact_role(&req.fp, req.role)
            .map_err(|e| CommandError::input(format!("{e:?}")))).unwrap();

        let listed: Vec<serde_json::Value> = st.call(|app| {
            app.contacts().contacts()
                .map(|c| serde_json::to_value(c).map_err(CommandError::input))
                .collect()
        }).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["role"], serde_json::json!("restricted"));
        assert_eq!(listed[0]["state"], serde_json::json!("contact"));
        assert_eq!(listed[0]["history_granted"], serde_json::json!(true));
    }

    #[test]
    fn audience_options_are_post_ready() {
        let st = state();
        let fp = social_app::Fingerprint::from_str("02:00:00:00:00:00:00:00:****");
        let fp_str = fp.as_str().to_string();
        st.call(|app| { app.create_audience("sphere_close", vec![fp]); Ok(()) }).unwrap();
        let options: Vec<PostAudience> = st
            .call(|app| {
                Ok(app.audiences()
                    .map(|k| {
                        let id = k.audience_id().to_string();
                        PostAudience {
                            id: id.clone(),
                            epoch: k.epoch(),
                            spec: social_app::Audience::Sphere { id },
                        }
                    })
                    .collect())
            })
            .unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, "sphere_close");
        assert_eq!(options[0].epoch, 1);
        assert_eq!(options[0].spec, social_app::Audience::Sphere { id: "sphere_close".into() });

        // Состав для UI: отпечатки и эпоха, без ключей.
        let members: Vec<String> = st
            .call(|app| {
                Ok(app
                    .audience("sphere_close")
                    .expect("audience")
                    .members()
                    .map(str::to_string)
                    .collect())
            })
            .unwrap();
        assert_eq!(members, vec![fp_str]);
    }

    #[tokio::test]
    async fn library_range_command_returns_clamped_plaintext() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalStore::new(dir.path().join("blobs")).unwrap());
        let plaintext: Vec<u8> = (0..25u32).map(|i| (i % 251) as u8).collect();
        let up = social_upload::upload_encrypted(store.as_ref(), "video/mp4", &plaintext)
            .await
            .unwrap();
        social_library::remember_at(dir.path(), &up, 1).unwrap();

        let app = SferaApp::new(
            Identity::from_seed(SEED).unwrap(),
            store,
            RetryPolicy::default(),
            Quota::new(60, 10_000, 10, 0),
        );
        let st = SferaState::new(app, None).with_keys_dir(dir.path());

        let dto = library_open_range(&st, LibraryRangeRequestDto {
            v: API_VERSION,
            blob_id: up.blob_id.clone(),
            start: 5,
            end: Some(19),
        })
        .await
        .unwrap()
        .expect("range");
        assert_eq!(dto.v, API_VERSION);
        assert_eq!((dto.start, dto.end, dto.size), (5, 19, 25));
        assert_eq!(dto.mime, "video/mp4");
        let got = base64::engine::general_purpose::STANDARD
            .decode(&dto.data_base64)
            .unwrap();
        assert_eq!(got, plaintext[5..19]);

        // Открытый конец клампится к размеру plaintext.
        let tail = library_open_range(&st, LibraryRangeRequestDto {
            v: API_VERSION,
            blob_id: up.blob_id.clone(),
            start: 22,
            end: None,
        })
        .await
        .unwrap()
        .expect("tail");
        assert_eq!((tail.start, tail.end), (22, 25));

        // Чужая версия и невалидные границы не доходят до хранилища.
        let err = library_open_range(&st, LibraryRangeRequestDto {
            v: API_VERSION + 1,
            blob_id: up.blob_id.clone(),
            start: 0,
            end: Some(1),
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, "version");
        let err = library_open_range(&st, LibraryRangeRequestDto {
            v: API_VERSION,
            blob_id: up.blob_id,
            start: 10,
            end: Some(5),
        })
        .await
        .unwrap_err();
        assert_eq!(err.code, "input");
    }

    #[test]
    fn handles_only_own_commands() {
        assert!(handles("social_library_open_range"));
        assert!(handles("social_feed"));
        assert!(handles("social_audiences"));
        assert!(!handles("social_companion_action"));
        assert!(!handles("not_a_command"));
    }

    #[test]
    fn panic_is_converted_to_typed_error() {
        let st = state();
        let r: Result<(), CommandError> = st.call(|_| panic!("boom"));
        assert_eq!(r.unwrap_err().code, "panic");
    }
}
