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
}

impl SferaState {
    pub fn new(app: SferaApp, delivery: Option<Arc<dyn DeliveryPort>>) -> Self {
        Self { app: Mutex::new(app), delivery }
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudienceDto {
    pub v: u8,
    pub id: String,
    pub members: Vec<social_app::Fingerprint>,
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
        app.feed().ordered().iter()
            .map(|e| serde_json::to_value(e).map_err(|e| CommandError::input(e)))
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

/// Прогов run outbox через порт доставки. Без порта — типизированная ошибка.
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
        social_create_audience,
        social_set_audience_members,
        social_sync_outbox,
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
    fn audience_options_are_post_ready() {
        let st = state();
        let fp = social_app::Fingerprint::from_str("02:00:00:00:00:00:00:00:****");
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
    }

    #[test]
    fn panic_is_converted_to_typed_error() {
        let st = state();
        let r: Result<(), CommandError> = st.call(|_| panic!("boom"));
        assert_eq!(r.unwrap_err().code, "panic");
    }
}
