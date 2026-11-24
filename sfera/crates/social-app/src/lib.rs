//! Vault Sfera — композиционный корень (ADR-006 §9).
//!
//! Единственное место, где фичи видят друг друга. Здесь НЕТ правил: форма,
//! подпись, права, ротация ключей и ретраи живут в своих крейтах. Корень только
//! держит состояние каждой фичи и связывает его с портами (хранилище,
//! отправитель). Стрелки: `social-app → все фичи`, `фича ↛ фича`.
//!
//! Бюджет — 300 строк (ratchet ADR-006 §9.5). Время приходит аргументом `now`:
//! корень не читает системные часы, поэтому сценарии детерминированы.

use std::collections::BTreeMap;
use std::sync::Arc;

use social_audience::AudienceKeys;
use social_contacts::ContactBook;
use social_delivery::SenderKeyMaterial;
use social_feed::Feed;
use social_post::{compose, PostError};
use social_profile::{ProfileBook, ProfileError};
mod profile_publish;
use social_sync::{ingest, DrainReport, Outbox, Quota, QuotaError, RetryPolicy};
use storage_api::BlobStore;

// Типы домена реэкспортируются корнем: social-ffi → social-app, не в обход.
pub use social_account::Identity;
pub use social_audience::MembershipChange;
pub use social_contacts::ContactRecord;
pub use social_feed::PostId;
pub use social_model::{Author, Fingerprint};
pub use social_post::{MediaRef, PostAudience, SignedPost};
pub use social_profile::{AvatarRef, ProfileLink, SignedProfile};
pub use social_profile::UpsertOutcome as ProfileUpsertOutcome;
pub use social_rights::{Access, Audience, Role};
pub use social_sync::{OutboxItem, SyncReport};
pub use storage_api::{StoreCaps, StoreKind};

/// Итог публикации: книга обновлена, а рассылка видна по числам.
#[derive(Clone, Debug)]
pub struct ProfilePublication {
    pub outcome: ProfileUpsertOutcome,
    pub sealed: usize,
    pub skipped: usize,
}

#[derive(Debug)]
pub enum AppError {
    Post(PostError),
    Profile(ProfileError),
    Quota(QuotaError),
    Canonical(String),
    UnknownAudience(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Post(e) => write!(f, "post: {e}"),
            Self::Profile(e) => write!(f, "profile: {e}"),
            Self::Quota(e) => write!(f, "quota: {e}"),
            Self::Canonical(m) => write!(f, "canonical form failed: {m}"),
            Self::UnknownAudience(id) => write!(f, "unknown audience: {id}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<PostError> for AppError { fn from(e: PostError) -> Self { Self::Post(e) } }
impl From<ProfileError> for AppError { fn from(e: ProfileError) -> Self { Self::Profile(e) } }
impl From<QuotaError> for AppError { fn from(e: QuotaError) -> Self { Self::Quota(e) } }

/// Сборка приложения. Ничего не шифрует и не решает — только держит порты.
pub struct SferaApp {
    identity: Identity,
    feed: Feed,
    profiles: ProfileBook,
    contacts: ContactBook,
    outbox: Outbox,
    audiences: BTreeMap<String, AudienceKeys>,
    store: Arc<dyn BlobStore>,
    peers: Vec<social_link::LinkedContact>,
    encryption: Option<SenderKeyMaterial>,
}

impl std::fmt::Debug for SferaApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SferaApp")
            .field("identity", &self.identity)
            .field("feed", &self.feed.len())
            .field("profiles", &self.profiles.len())
            .field("outbox", &self.outbox.len())
            .field("audiences", &self.audiences.keys())
            .finish_non_exhaustive()
    }
}

impl SferaApp {
    /// Собрать приложение из идентичности, порта хранилища и политик.
    pub fn new(
        identity: Identity,
        store: Arc<dyn BlobStore>,
        retry: RetryPolicy,
        quota: Quota,
    ) -> Self {
        Self {
            identity,
            feed: Feed::new(),
            profiles: ProfileBook::new(),
            contacts: ContactBook::new(),
            outbox: Outbox::new(retry, quota),
            audiences: BTreeMap::new(),
            store,
            peers: Vec::new(),
            encryption: None,
        }
    }

    /// Публичные ключи получателей из проверенного bundle связывания.
    pub fn set_link_contacts(&mut self, peers: Vec<social_link::LinkedContact>) {
        self.peers = peers;
    }

    /// Свой ключ шифрования Sfera. Приватный ключ мессенджера сюда не копируется.
    pub fn set_encryption_identity(&mut self, sender: SenderKeyMaterial) {
        self.encryption = Some(sender);
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn feed(&self) -> &Feed {
        &self.feed
    }

    pub fn profiles(&self) -> &ProfileBook {
        &self.profiles
    }

    pub(crate) fn profiles_mut(&mut self) -> &mut ProfileBook {
        &mut self.profiles
    }

    pub(crate) fn outbox_mut(&mut self) -> &mut Outbox {
        &mut self.outbox
    }

    pub fn contacts(&self) -> &ContactBook {
        &self.contacts
    }

    /// Изменение книги контактов — только через корень: правило состояния
    /// заявки живёт в social-contacts, корень не принимает решений.
    pub fn contacts_mut(&mut self) -> &mut ContactBook {
        &mut self.contacts
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    pub fn store(&self) -> &Arc<dyn BlobStore> {
        &self.store
    }

    pub fn audience(&self, id: &str) -> Option<&AudienceKeys> {
        self.audiences.get(id)
    }

    /// Все аудитории автора. Только чтение: состав и эпохи решает
    /// `social-audience`, корень их не пересчитывает.
    pub fn audiences(&self) -> impl Iterator<Item = &AudienceKeys> {
        self.audiences.values()
    }

    /// Зарегистрировать ключи аудитории (состояние фичи `social-audience`).
    pub fn put_audience(&mut self, keys: AudienceKeys) {
        self.audiences.insert(keys.audience_id().to_string(), keys);
    }

    /// Создать аудиторию с заданным составом: конструктор живёт в
    /// `social-audience`, корень только вызывает его.
    pub fn create_audience<I>(&mut self, id: impl Into<String>, members: I)
    where
        I: IntoIterator<Item = Fingerprint>,
    {
        self.put_audience(AudienceKeys::new(id, members));
    }

    /// Применить состав аудитории; ротацию решает `social-audience`.
    pub fn set_audience_members<I>(
        &mut self,
        id: &str,
        members: I,
    ) -> Result<MembershipChange, AppError>
    where
        I: IntoIterator<Item = Fingerprint>,
    {
        let keys = self
            .audiences
            .get_mut(id)
            .ok_or_else(|| AppError::UnknownAudience(id.to_string()))?;
        Ok(keys.apply_membership(members))
    }

    /// Принять контакт; переходы решают `social-contacts`.
    pub fn put_contact(&mut self, record: ContactRecord) {
        self.contacts.upsert(record);
    }

    /// Сменить роль принятого контакта; проверку состояния делает
    /// `social-contacts`, корень только передаёт вызов.
    pub fn set_contact_role(
        &mut self,
        fp: &Fingerprint,
        role: Role,
    ) -> Result<(), social_contacts::ContactError> {
        self.contacts.set_role(fp, role)
    }

    /// Опубликовать пост: сборка/подпись в `social-post`, постановка в outbox.
    /// Доставку делает `sync_outbox`, здесь её нет.
    pub fn publish_post(
        &mut self,
        ts: u64,
        body: impl Into<String>,
        audience: PostAudience,
        media: Vec<social_post::MediaRef>,
        now: u64,
    ) -> Result<SignedPost, AppError> {
        let post = compose(self.identity.signing_seed(), ts, body, audience, media)?;
        let id = PostId::from_post(&post.post)
            .map_err(|e| AppError::Canonical(e.to_string()))?
            .to_hex();
        let len = social_post::canonical_post(&post.post)
            .map_err(AppError::Canonical)?
            .len() as u64;
        self.outbox.enqueue(id, len, now)?;
        Ok(post)
    }

    /// Принять входящие посты: проверка подписи и дедуп в `social-feed`.
    pub fn receive_posts(
        &mut self,
        posts: impl IntoIterator<Item = SignedPost>,
        received_at: u64,
    ) -> SyncReport {
        ingest(&mut self.feed, posts, received_at)
    }

    /// Отметить прочитанным — локальное состояние ленты.
    pub fn mark_read(&mut self, id: &PostId) -> bool {
        self.feed.mark_read(id)
    }

    /// Опубликовать свой профиль: подпись в `social-profile`, обновление книги.
    /// Адресная рассылка и манифест — композиция в `social-bridge`.
    pub fn set_my_profile(
        &mut self,
        ts: u64,
        display_name: impl Into<String>,
        bio: impl Into<String>,
        avatar: Option<AvatarRef>,
        links: Vec<ProfileLink>,
        now: u64,
        avatar_manifest: Option<serde_json::Value>,
    ) -> Result<ProfilePublication, AppError> {
        let sender = self.encryption.clone();
        let peers = self.peers.clone();
        profile_publish::set_my_profile(
            self, ts, display_name, bio, avatar, links, now,
            avatar_manifest, &peers, sender.as_ref(),
        )
    }

    /// Принять чужой профиль; «новее побеждает» решает `social-profile`.
    pub fn receive_profile(&mut self, signed: SignedProfile) -> Result<ProfileUpsertOutcome, AppError> {
        Ok(self.profiles.upsert(signed)?)
    }

    /// Профиль по отпечатку (для показа контактам).
    pub fn profile_of(&self, fp: &Fingerprint) -> Option<&SignedProfile> {
        self.profiles.get(fp)
    }

    /// Решение о доступе: состояние отношения из `social-contacts`, вердикт
    /// считает `social-rights`. Корень только соединяет их.
    pub fn access(
        &self,
        viewer: &Fingerprint,
        audience: &Audience,
        viewer_spheres: &[String],
    ) -> Option<Access> {
        let record = self.contacts.get(viewer)?;
        Some(social_rights::evaluate(
            viewer,
            record.state,
            record.role,
            &record.overrides,
            audience,
            viewer_spheres,
        ))
    }

    /// Прогнать очередь. `send` — тонкий адаптер email/relay; корень не знает,
    /// чем именно отправляется конверт.
    pub fn sync_outbox(&mut self, now: u64, send: impl FnMut(&OutboxItem) -> bool) -> DrainReport {
        self.outbox.drain_due(now, send)
    }
}
