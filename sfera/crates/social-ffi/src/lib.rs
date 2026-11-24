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
    /// Каталог локальных ключей и метаданных (media_library.json).
    keys_dir: std::path::PathBuf,
}

impl SferaState {
    pub fn new(app: SferaApp, delivery: Option<Arc<dyn DeliveryPort>>) -> Self {
        Self {
            app: Mutex::new(app),
            delivery,
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

    /// Хендл хранилища для async-команд: копируем Arc и не держим mutex
    /// во время сетевой/дисковой записи.
    pub fn store_handle(&self) -> Result<Arc<dyn storage_api::BlobStore>, CommandError> {
        let app = self.app.lock().map_err(|_| CommandError::lock())?;
        Ok(app.store().clone())
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
pub struct OutcomeDto { pub v: u8, pub outcome: String }

impl From<social_app::ProfileUpsertOutcome> for OutcomeDto {
    fn from(o: social_app::ProfileUpsertOutcome) -> Self {
        let outcome = match o {
            social_app::ProfileUpsertOutcome::Inserted => "inserted",
            social_app::ProfileUpsertOutcome::Updated => "updated",
            social_app::ProfileUpsertOutcome::Duplicate => "duplicate",
            social_app::ProfileUpsertOutcome::Stale => "stale",
        };
        Self { v: API_VERSION, outcome: outcome.into() }
    }
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
    state.call(|app| {
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
    state.call(|app| Ok(app.receive_posts(req.posts, req.received_at).into()))
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
fn social_set_my_profile(state: tauri::State<'_, SferaState>, req: SetProfileRequest) -> Result<OutcomeDto, CommandError> {
    check(req.v)?;
    state.call(|app| {
        Ok(app.set_my_profile(
            req.ts, req.display_name, req.bio, req.avatar, req.links, req.now,
        )?.into())
    })
}

#[tauri::command]
fn social_profile(state: tauri::State<'_, SferaState>, fp: String) -> Result<Option<serde_json::Value>, CommandError> {
    state.call(|app| {
        let fp = social_app::Fingerprint::from_str(&fp);
        match app.profile_of(&fp) {
            None => Ok(None),
            Some(p) => Ok(Some(serde_json::to_value(p).map_err(CommandError::input)?)),
        }
    })
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
#[tauri::command]
async fn social_upload_media(
    state: tauri::State<'_, SferaState>,
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
            | "social_receive_posts"
            | "social_feed"
            | "social_contacts"
            | "social_audiences"
            | "social_mark_read"
            | "social_set_my_profile"
            | "social_profile"
            | "social_access"
            | "social_put_contact"
            | "social_set_contact_role"
            | "social_role_options"
            | "social_accept_contact_request"
            | "social_upload_media"
            | "social_library_items"
            | "social_library_forget"
            | "social_library_open"
            | "social_library_open_range"
            | "social_library_thumb"
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
        social_receive_posts,
        social_feed,
        social_contacts,
        social_audiences,
        social_mark_read,
        social_set_my_profile,
        social_profile,
        social_access,
        social_put_contact,
        social_set_contact_role,
        social_role_options,
        social_accept_contact_request,
        social_upload_media,
        social_library_items,
        social_library_forget,
        social_library_open,
        social_library_open_range,
        social_library_thumb,
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
    use std::sync::Arc;
    use social_app::Identity;
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
