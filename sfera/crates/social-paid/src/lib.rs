//! Vault Sfera — платный канал: право на доступ и эпохный ключ.
//!
//! Здесь связываются две уже существующие вещи:
//! - `sfera_billing::creator::CreatorEntitlement` — подписанное право
//!   подписчика (кто, на какой канал, до какого срока, к какой эпохе);
//! - `social_audience::AudienceKeys` — эпохные ключи аудитории с ротацией
//!   только при изменении состава.
//!
//! Ключ отдаётся только при АКТИВНОМ праве, совпадении создателя, получателя
//! и `key_id` текущей эпохи, и только действующему подписчику. Ключ не
//! сериализуется и не попадает в `Debug` — его обёртывает `social-delivery`
//! адресно каждому подписчику.
//!
//! Отзыв: окончание подписки удаляет участника и ротирует эпоху. Уже
//! полученные посты остаются читаемыми старым ключом — это честное
//! ограничение E2E, а не недоделка.

use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::path::Path;

use sfera_billing::creator::{
    check_entitlement, CreatorEntitlement, EntitlementError, EntitlementKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use social_audience::{
    AudienceKeys, AudienceKeysSnapshot, AudienceRestoreError, MembershipChange,
};
use social_delivery::{
    unwrap_audience_key, wrap_audience_key, DeliveryError, RecipientKeyMaterial,
    SenderKeyMaterial, WrappedAudienceKey,
};
use social_model::post as signing;
use social_model::{Author, Fingerprint};

/// Идентификатор ключа эпохи: SHA-256 от 32 байт ключа, hex.
/// В праве хранится только он, а не сам ключ.
#[must_use]
pub fn key_id(key: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(key))
}

/// Платный канал: создатель, витрина и эпохные ключи подписчиков.
///
/// Создатель входит в аудиторию с первой эпохи: он должен читать собственные
/// посты. Каждая подписка/отписка меняет состав и ротирует ключ.
pub struct PaidChannel {
    id: String,
    creator: Fingerprint,
    title: String,
    keys: AudienceKeys,
}

impl PaidChannel {
    /// Новый канал. Создатель — первый (и пока единственный) участник.
    pub fn create(id: impl Into<String>, creator: Fingerprint, title: impl Into<String>) -> Self {
        let id = id.into();
        let keys = AudienceKeys::new(format!("paid:{id}"), [creator.clone()]);
        Self { id, creator, title: title.into(), keys }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn creator(&self) -> &Fingerprint {
        &self.creator
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn epoch(&self) -> u64 {
        self.keys.epoch()
    }

    /// Идентификатор ключа ТЕКУЩЕЙ эпохи. Именно его требует право.
    #[must_use]
    pub fn current_key_id(&self) -> String {
        key_id(self.keys.current_key())
    }

    pub fn is_subscriber(&self, fp: &Fingerprint) -> bool {
        self.keys.is_member(fp)
    }

    pub fn subscriber_count(&self) -> usize {
        self.keys.members().count()
    }

    /// Подписка. Новый участник меняет состав → эпоха и ключ ротируются.
    pub fn subscribe(&mut self, subscriber: &Fingerprint) -> MembershipChange {
        self.keys.add_member(subscriber)
    }

    /// Отписка. Удаление участника ротирует ключ: новых постов он не получит.
    pub fn unsubscribe(&mut self, subscriber: &Fingerprint) -> MembershipChange {
        self.keys.remove_member(subscriber)
    }

    /// Обернуть текущий ключ эпохи для подписчика тем же E2E-примитивом,
    /// что и остальная доставка. Не-подписчику — `NotAMember`.
    pub fn wrap_current_key(
        &self,
        sender: &SenderKeyMaterial,
        recipient: &RecipientKeyMaterial,
    ) -> Result<WrappedAudienceKey, DeliveryError> {
        wrap_audience_key(&self.keys, sender, recipient)
    }

    /// Развернуть обёрнутый ключ подписчиком. Проверка членства — на стороне
    /// отправителя (обёртка), здесь только криптография.
    pub fn unwrap_key(
        &self,
        wrapped: &WrappedAudienceKey,
        recipient_x25519_private_hex: &str,
        sender_x25519_public_hex: &str,
        recipient_pq_seed_hex: &str,
    ) -> Result<[u8; 32], DeliveryError> {
        unwrap_audience_key(
            wrapped,
            recipient_x25519_private_hex,
            sender_x25519_public_hex,
            recipient_pq_seed_hex,
        )
    }

    /// Проверить право и выдать ключ текущей эпохи.
    ///
    /// Порядок проверок важен: сначала подпись/срок/владелец права, затем
    /// членство, затем свежесть эпохи. Иначе устаревшее право могло бы
    /// получить новый ключ после ротации.
    pub fn access(
        &self,
        token: &CreatorEntitlement,
        issuer: &Author,
        subject: &Fingerprint,
        now: u64,
    ) -> Result<ChannelAccess, AccessError> {
        if token.kind != EntitlementKind::Channel {
            return Err(AccessError::WrongKind);
        }
        check_entitlement(token, issuer, &self.creator, subject, now)
            .map_err(AccessError::Entitlement)?;
        if !self.keys.is_member(subject) {
            return Err(AccessError::NotAMember);
        }
        let key_id = self.current_key_id();
        if token.key_id != key_id {
            return Err(AccessError::StaleKey);
        }
        Ok(ChannelAccess {
            audience_id: self.keys.audience_id().to_string(),
            epoch: self.keys.epoch(),
            key_id,
            key: *self.keys.current_key(),
        })
    }
}

impl fmt::Debug for PaidChannel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PaidChannel")
            .field("id", &self.id)
            .field("creator", &self.creator)
            .field("title", &self.title)
            .field("epoch", &self.keys.epoch())
            .field("subscribers", &self.keys.members().count())
            .finish_non_exhaustive()
    }
}

/// Выданный доступ: ключ эпохи для расшифровки постов канала.
///
/// `Serialize` намеренно не реализован. `Debug` скрывает ключ. Наружу
/// (в JS/FFI) объект не отдаётся: вызывающий код сразу использует ключ.
#[derive(PartialEq, Eq)]
pub struct ChannelAccess {
    audience_id: String,
    epoch: u64,
    key_id: String,
    key: [u8; 32],
}

impl ChannelAccess {
    pub fn audience_id(&self) -> &str {
        &self.audience_id
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// Ключ эпохи. Только для расшифровки/обёртки в ядре.
    pub fn key(&self) -> &[u8; 32] {
        &self.key
    }
}

impl fmt::Debug for ChannelAccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChannelAccess")
            .field("audience_id", &self.audience_id)
            .field("epoch", &self.epoch)
            .field("key_id", &self.key_id)
            .field("key", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessError {
    /// Подпись, срок, создатель или получатель права не совпали.
    Entitlement(EntitlementError),
    /// Право выдано не на канал (например, на чаевые).
    WrongKind,
    /// Право есть, но подписчик не входит в текущий состав канала.
    NotAMember,
    /// Право ссылается на прошлую эпоху: нужен новый ключ/право.
    StaleKey,
}

impl fmt::Display for AccessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Entitlement(e) => write!(f, "entitlement: {e}"),
            Self::WrongKind => f.write_str("entitlement is not for a channel"),
            Self::NotAMember => f.write_str("subject is not a current subscriber"),
            Self::StaleKey => f.write_str("entitlement refers to a stale epoch key"),
        }
    }
}

impl std::error::Error for AccessError {}

// --- Ссылка-приглашение в канал --------------------------------------------
//
// Приглашение — только НАВИГАЦИЯ: «вот канал, вот создатель, вот срок».
// Оно не даёт подписку и не обходит оплату. Подписку выдаёт создатель после
// оплаты/решения; право на ключ проверяется отдельно (`access`).
//
// Подпись создателя обязательна: иначе чужой человек собрал бы ссылку от
// имени автора и увёл подписчиков на свой канал.

pub const CHANNEL_INVITE_DOMAIN: &[u8] = b"sfera-channel-invite:v1\0";
pub const CHANNEL_INVITE_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelInvite {
    pub v: u8,
    pub channel_id: String,
    /// Создатель канала: отпечаток и публичный ключ для проверки подписи.
    pub creator: Author,
    pub title: String,
    pub created_at: u64,
    /// `0` — бессрочное; иначе unix-время окончания.
    pub expires_at: u64,
    /// Неугадываемый код: hex SHA-256 от seed, пришедшего извне.
    pub code: String,
    pub sig: String,
}

impl ChannelInvite {
    #[must_use]
    pub fn unsigned(&self) -> Self {
        Self { sig: String::new(), ..self.clone() }
    }

    /// Собрать и подписать приглашение ключом создателя канала.
    ///
    /// `code_seed` приходит извне (как в `social-invite`): ядро не прячет
    /// генерацию случайности, поведение детерминировано и тестируемо.
    pub fn create(
        channel: &PaidChannel,
        creator_seed_hex: &str,
        code_seed: &[u8],
        now: u64,
        expires_at: u64,
    ) -> Result<Self, ChannelInviteError> {
        let pub_key = signing::public_key_hex(creator_seed_hex)
            .map_err(|_| ChannelInviteError::BadSignature)?;
        let creator = Author::from_public_key_hex(&pub_key)
            .map_err(|_| ChannelInviteError::BadSignature)?;
        if !channel.creator.same(&creator.fp) {
            return Err(ChannelInviteError::NotCreator);
        }
        if code_seed.is_empty() {
            return Err(ChannelInviteError::EmptyCodeSeed);
        }
        if expires_at != 0 && expires_at <= now {
            return Err(ChannelInviteError::BadPeriod);
        }
        let mut invite = Self {
            v: CHANNEL_INVITE_VERSION,
            channel_id: channel.id.clone(),
            creator,
            title: channel.title.clone(),
            created_at: now,
            expires_at,
            code: hex::encode(Sha256::digest(code_seed)),
            sig: String::new(),
        };
        invite.sig = signing::sign_with_domain(
            CHANNEL_INVITE_DOMAIN,
            creator_seed_hex,
            &invite.unsigned(),
        )
        .map_err(|_| ChannelInviteError::BadSignature)?;
        Ok(invite)
    }

    /// Проверить форму и подпись. Срок здесь не проверяется — для него
    /// `valid_at`, чтобы «просрочено» отличалось от «подделано».
    pub fn verify(&self) -> Result<(), ChannelInviteError> {
        if self.v != CHANNEL_INVITE_VERSION {
            return Err(ChannelInviteError::UnsupportedVersion);
        }
        if self.channel_id.trim().is_empty() {
            return Err(ChannelInviteError::EmptyChannel);
        }
        if self.code.len() != 64 || !self.code.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ChannelInviteError::BadCode);
        }
        if self.expires_at != 0 && self.expires_at <= self.created_at {
            return Err(ChannelInviteError::BadPeriod);
        }
        let derived = Fingerprint::from_public_key_hex(&self.creator.pub_key)
            .map_err(|_| ChannelInviteError::BadSignature)?;
        if !derived.same(&self.creator.fp) {
            return Err(ChannelInviteError::BadSignature);
        }
        if !signing::verify_with_domain(
            CHANNEL_INVITE_DOMAIN,
            &self.unsigned(),
            &self.creator,
            &self.sig,
        ) {
            return Err(ChannelInviteError::BadSignature);
        }
        Ok(())
    }

    /// Приглашение действительно сейчас: подпись верна и срок не вышел.
    pub fn valid_at(&self, now: u64) -> Result<(), ChannelInviteError> {
        self.verify()?;
        if self.expires_at != 0 && now >= self.expires_at {
            return Err(ChannelInviteError::Expired);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelInviteError {
    UnsupportedVersion,
    EmptyChannel,
    EmptyCodeSeed,
    NotCreator,
    BadPeriod,
    BadCode,
    BadSignature,
    Expired,
}

impl fmt::Display for ChannelInviteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnsupportedVersion => "channel invite version is not supported",
            Self::EmptyChannel => "channel invite has no channel id",
            Self::EmptyCodeSeed => "channel invite code seed is empty",
            Self::NotCreator => "invite signer is not the channel creator",
            Self::BadPeriod => "channel invite period is invalid",
            Self::BadCode => "channel invite code is malformed",
            Self::BadSignature => "channel invite signature is invalid",
            Self::Expired => "channel invite has expired",
        })
    }
}

impl std::error::Error for ChannelInviteError {}

// --- Локальное хранилище каналов -------------------------------------------
//
// Ключи канала — секрет: файл 0600, ключи не уходят в JS и не имеют
// `Serialize` на уровне `AudienceKeys`. Здесь — единственный слой, который
// переводит их в hex для диска и обратно. Шифрование ключей ключом устройства
// (keychain) — следующий слой; до него файл защищён правами 0600.

pub const CHANNEL_BOOK_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChannelStoreError {
    Io(String),
    Format(String),
    Invalid(String),
}

impl fmt::Display for ChannelStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(m) => write!(f, "channel store io: {m}"),
            Self::Format(m) => write!(f, "channel store format: {m}"),
            Self::Invalid(m) => write!(f, "channel store invalid: {m}"),
        }
    }
}

impl std::error::Error for ChannelStoreError {}

#[derive(Serialize, Deserialize)]
struct StoredKey {
    epoch: u64,
    key_hex: String,
}

#[derive(Serialize, Deserialize)]
struct StoredChannel {
    id: String,
    creator: String,
    title: String,
    audience_id: String,
    epoch: u64,
    current_key_hex: String,
    members: Vec<String>,
    history: Vec<StoredKey>,
}

#[derive(Serialize, Deserialize)]
struct StoredBook {
    v: u8,
    channels: Vec<StoredChannel>,
}

/// Книга платных каналов. Живёт в Rust; в FFI отдаются только метаданные.
#[derive(Default)]
pub struct ChannelBook {
    channels: BTreeMap<String, PaidChannel>,
}

impl ChannelBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.channels.len()
    }

    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
    }

    pub fn insert(&mut self, channel: PaidChannel) -> Option<PaidChannel> {
        self.channels.insert(channel.id.clone(), channel)
    }

    pub fn get(&self, id: &str) -> Option<&PaidChannel> {
        self.channels.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut PaidChannel> {
        self.channels.get_mut(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &PaidChannel> {
        self.channels.values()
    }

    pub fn remove(&mut self, id: &str) -> Option<PaidChannel> {
        self.channels.remove(id)
    }

    /// Атомарно записать книгу. Каталог создаётся, файл — 0600.
    pub fn save_to(&self, path: &Path) -> Result<(), ChannelStoreError> {
        let channels = self
            .channels
            .values()
            .map(|channel| {
                let snapshot = channel.keys.snapshot_for_storage();
                StoredChannel {
                    id: channel.id.clone(),
                    creator: channel.creator.as_str().to_string(),
                    title: channel.title.clone(),
                    audience_id: snapshot.audience_id,
                    epoch: snapshot.epoch,
                    current_key_hex: hex::encode(snapshot.current),
                    members: snapshot.members,
                    history: snapshot
                        .history
                        .into_iter()
                        .map(|(epoch, key)| StoredKey {
                            epoch,
                            key_hex: hex::encode(key),
                        })
                        .collect(),
                }
            })
            .collect();
        let body = serde_json::to_vec(&StoredBook {
            v: CHANNEL_BOOK_VERSION,
            channels,
        })
        .map_err(|e| ChannelStoreError::Format(e.to_string()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ChannelStoreError::Io(e.to_string()))?;
        }
        let tmp = path.with_extension("tmp");
        write_private(&tmp, &body)?;
        std::fs::rename(&tmp, path).map_err(|e| ChannelStoreError::Io(e.to_string()))?;
        Ok(())
    }

    /// Прочитать книгу. Отсутствующий файл — пустая книга, а не ошибка.
    /// Повреждённый файл — ошибка: молча терять ключи каналов нельзя.
    pub fn load_from(path: &Path) -> Result<Self, ChannelStoreError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(path).map_err(|e| ChannelStoreError::Io(e.to_string()))?;
        let stored: StoredBook = serde_json::from_slice(&bytes)
            .map_err(|e| ChannelStoreError::Format(e.to_string()))?;
        if stored.v != CHANNEL_BOOK_VERSION {
            return Err(ChannelStoreError::Invalid(
                "unsupported channel book version".into(),
            ));
        }
        let mut book = Self::default();
        for stored in stored.channels {
            if stored.id.trim().is_empty() || stored.creator.trim().is_empty() {
                return Err(ChannelStoreError::Invalid(
                    "channel has empty id or creator".into(),
                ));
            }
            let current = decode_key(&stored.current_key_hex)?;
            let mut history = Vec::with_capacity(stored.history.len());
            for key in stored.history {
                history.push((key.epoch, decode_key(&key.key_hex)?));
            }
            let snapshot = AudienceKeysSnapshot {
                audience_id: stored.audience_id,
                epoch: stored.epoch,
                current,
                members: stored.members,
                history,
            };
            let keys = AudienceKeys::restore(snapshot).map_err(|e: AudienceRestoreError| {
                ChannelStoreError::Invalid(format!("channel {}: {e}", stored.id))
            })?;
            let channel = PaidChannel {
                id: stored.id.clone(),
                creator: Fingerprint::from_str(&stored.creator),
                title: stored.title,
                keys,
            };
            if book.channels.insert(stored.id.clone(), channel).is_some() {
                return Err(ChannelStoreError::Invalid(format!(
                    "duplicate channel {}",
                    stored.id
                )));
            }
        }
        Ok(book)
    }
}

fn decode_key(value: &str) -> Result<[u8; 32], ChannelStoreError> {
    let bytes = hex::decode(value.trim())
        .map_err(|_| ChannelStoreError::Invalid("channel key is not hex".into()))?;
    bytes
        .try_into()
        .map_err(|_| ChannelStoreError::Invalid("channel key is not 32 bytes".into()))
}

#[cfg(unix)]
fn write_private(path: &Path, body: &[u8]) -> Result<(), ChannelStoreError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| ChannelStoreError::Io(e.to_string()))?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|e| ChannelStoreError::Io(e.to_string()))
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &[u8]) -> Result<(), ChannelStoreError> {
    let mut file = std::fs::File::create(path)
        .map_err(|e| ChannelStoreError::Io(e.to_string()))?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|e| ChannelStoreError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sfera_billing::creator::ENTITLEMENT_DOMAIN;
    use social_model::post as signing;

    const ISSUER_SEED: &str = "0900000000000000000000000000000000000000000000000000000000000009";
    const CREATOR_SEED: &str = "0100000000000000000000000000000000000000000000000000000000000001";
    const SUBJECT_SEED: &str = "0200000000000000000000000000000000000000000000000000000000000002";
    const OTHER_SEED: &str = "0300000000000000000000000000000000000000000000000000000000000003";

    fn fp(seed: &str) -> Fingerprint {
        Fingerprint::from_public_key_hex(&signing::public_key_hex(seed).unwrap()).unwrap()
    }

    fn issuer() -> Author {
        Author::from_public_key_hex(&signing::public_key_hex(ISSUER_SEED).unwrap()).unwrap()
    }

    fn channel() -> PaidChannel {
        PaidChannel::create("chan-1", fp(CREATOR_SEED), "Платный канал")
    }

    fn token(channel: &PaidChannel, kind: EntitlementKind) -> CreatorEntitlement {
        let mut token = CreatorEntitlement {
            v: 1,
            kind,
            creator: fp(CREATOR_SEED),
            subject: fp(SUBJECT_SEED),
            plan: "monthly".into(),
            key_id: channel.current_key_id(),
            period_start: 1_000,
            period_end: 1_000 + 30 * 86_400,
            issued_at: 999,
            payment_id: "pay_1".into(),
            sig: String::new(),
        };
        token.sig = signing::sign_with_domain(ENTITLEMENT_DOMAIN, ISSUER_SEED, &token).unwrap();
        token
    }

    #[test]
    fn subscriber_with_active_entitlement_gets_current_key() {
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let token = token(&channel, EntitlementKind::Channel);
        let access = channel
            .access(&token, &issuer(), &fp(SUBJECT_SEED), 2_000)
            .expect("доступ выдан");
        assert_eq!(access.epoch(), channel.epoch());
        assert_eq!(access.key_id(), channel.current_key_id());
        assert_eq!(access.key(), channel.keys.current_key());
    }

    #[test]
    fn expired_or_foreign_entitlement_is_rejected() {
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let token = token(&channel, EntitlementKind::Channel);

        assert_eq!(
            channel.access(&token, &issuer(), &fp(SUBJECT_SEED), token.period_end),
            Err(AccessError::Entitlement(EntitlementError::Expired))
        );
        assert_eq!(
            channel.access(&token, &issuer(), &fp(OTHER_SEED), 2_000),
            Err(AccessError::Entitlement(EntitlementError::WrongSubject))
        );
    }

    #[test]
    fn entitlement_for_another_kind_is_rejected() {
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let token = token(&channel, EntitlementKind::Tip);
        assert_eq!(
            channel.access(&token, &issuer(), &fp(SUBJECT_SEED), 2_000),
            Err(AccessError::WrongKind)
        );
    }

    #[test]
    fn subscription_rotation_invalidates_old_epoch_key() {
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let old = token(&channel, EntitlementKind::Channel);
        let old_key = channel.current_key_id();

        // Новый подписчик меняет состав → эпоха и ключ ротируются.
        channel.subscribe(&fp(OTHER_SEED));
        assert_ne!(channel.current_key_id(), old_key);
        assert_eq!(
            channel.access(&old, &issuer(), &fp(SUBJECT_SEED), 2_000),
            Err(AccessError::StaleKey)
        );

        // Новое право на текущую эпоху снова открывает доступ.
        let fresh = token(&channel, EntitlementKind::Channel);
        assert!(channel
            .access(&fresh, &issuer(), &fp(SUBJECT_SEED), 2_000)
            .is_ok());
    }

    #[test]
    fn unsubscribed_subject_loses_access_even_with_fresh_entitlement() {
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        channel.unsubscribe(&fp(SUBJECT_SEED));
        let fresh = token(&channel, EntitlementKind::Channel);
        assert_eq!(
            channel.access(&fresh, &issuer(), &fp(SUBJECT_SEED), 2_000),
            Err(AccessError::NotAMember)
        );
    }

    #[test]
    fn creator_keeps_access_to_own_channel() {
        let channel = channel();
        let mut token = token(&channel, EntitlementKind::Channel);
        token.subject = fp(CREATOR_SEED);
        token.sig = String::new();
        token.sig = signing::sign_with_domain(ENTITLEMENT_DOMAIN, ISSUER_SEED, &token).unwrap();
        assert!(channel
            .access(&token, &issuer(), &fp(CREATOR_SEED), 2_000)
            .is_ok());
    }

    #[test]
    fn creator_can_sign_entitlement_without_platform_money() {
        // Фаза «самозанятый»: платформа не проводит деньги автора и не берёт
        // комиссию. Автор сам собирает оплату и сам подписывает право.
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let mut token = CreatorEntitlement {
            v: 1,
            kind: EntitlementKind::Channel,
            creator: fp(CREATOR_SEED),
            subject: fp(SUBJECT_SEED),
            plan: "monthly".into(),
            key_id: channel.current_key_id(),
            period_start: 1_000,
            period_end: 1_000 + 30 * 86_400,
            issued_at: 999,
            payment_id: "creator-side-payment".into(),
            sig: String::new(),
        };
        token.sig = signing::sign_with_domain(ENTITLEMENT_DOMAIN, CREATOR_SEED, &token).unwrap();
        let creator_author =
            Author::from_public_key_hex(&signing::public_key_hex(CREATOR_SEED).unwrap()).unwrap();
        assert!(channel
            .access(&token, &creator_author, &fp(SUBJECT_SEED), 2_000)
            .is_ok());
    }

    #[test]
    fn subscriber_can_unwrap_the_epoch_key_and_outsider_cannot() {
        let creator_keys = social_keys::EncryptionIdentity::generate([11; 32]).unwrap();
        let subscriber_keys = social_keys::EncryptionIdentity::generate([22; 32]).unwrap();
        let outsider_keys = social_keys::EncryptionIdentity::generate([33; 32]).unwrap();

        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let token = token(&channel, EntitlementKind::Channel);
        let access = channel
            .access(&token, &issuer(), &fp(SUBJECT_SEED), 2_000)
            .unwrap();

        let recipient = RecipientKeyMaterial {
            fp: fp(SUBJECT_SEED),
            x25519_public_hex: subscriber_keys.x25519_public_hex().into(),
            pq_ek_b64: subscriber_keys.pq_ek_b64().into(),
            address: "subscriber@example.test".into(),
        };
        let wrapped = channel
            .wrap_current_key(&creator_keys.sender_material(), &recipient)
            .expect("ключ обёрнут подписчику");
        let unwrapped = channel
            .unwrap_key(
                &wrapped,
                subscriber_keys.x25519_private_hex(),
                creator_keys.x25519_public_hex(),
                subscriber_keys.pq_seed_hex(),
            )
            .expect("подписчик развернул ключ");
        assert_eq!(&unwrapped, access.key());

        let outsider = RecipientKeyMaterial {
            fp: fp(OTHER_SEED),
            x25519_public_hex: outsider_keys.x25519_public_hex().into(),
            pq_ek_b64: outsider_keys.pq_ek_b64().into(),
            address: "outsider@example.test".into(),
        };
        assert_eq!(
            channel
                .wrap_current_key(&creator_keys.sender_material(), &outsider)
                .unwrap_err(),
            DeliveryError::NotAMember
        );
    }

    fn sample_invite() -> ChannelInvite {
        ChannelInvite::create(&channel(), CREATOR_SEED, b"invite-seed", 1_000, 10_000).unwrap()
    }

    #[test]
    fn channel_invite_is_signed_and_expires() {
        let invite = sample_invite();
        assert_eq!(invite.verify(), Ok(()));
        assert!(invite.valid_at(1_000).is_ok());
        assert!(invite.valid_at(9_999).is_ok());
        assert_eq!(invite.valid_at(10_000), Err(ChannelInviteError::Expired));
        assert_eq!(invite.code.len(), 64);
    }

    #[test]
    fn channel_invite_rejects_foreign_creator_and_tampering() {
        let channel = channel();
        assert_eq!(
            ChannelInvite::create(&channel, SUBJECT_SEED, b"x", 1, 0).unwrap_err(),
            ChannelInviteError::NotCreator
        );

        let mut invite = sample_invite();
        invite.title = "другой канал".into();
        assert_eq!(invite.verify().unwrap_err(), ChannelInviteError::BadSignature);

        let mut invite = sample_invite();
        invite.creator.fp = fp(OTHER_SEED);
        assert_eq!(invite.verify().unwrap_err(), ChannelInviteError::BadSignature);
    }

    #[test]
    fn channel_invite_does_not_subscribe_by_itself() {
        let channel = channel();
        let invite = sample_invite();
        assert!(invite.verify().is_ok());
        assert!(!channel.is_subscriber(&fp(SUBJECT_SEED)));
    }

    #[test]
    fn channel_book_roundtrip_keeps_key_and_membership() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("channels.json");
        let mut book = ChannelBook::new();
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let epoch = channel.epoch();
        let key_id = channel.current_key_id();
        book.insert(channel);
        book.save_to(&path).expect("книга записана");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "ключи каналов только для владельца");
        }

        let loaded = ChannelBook::load_from(&path).expect("книга прочитана");
        assert_eq!(loaded.len(), 1);
        let channel = loaded.get("chan-1").expect("канал на месте");
        assert_eq!(channel.epoch(), epoch);
        assert_eq!(channel.current_key_id(), key_id);
        assert!(channel.is_subscriber(&fp(SUBJECT_SEED)));

        let token = token(channel, EntitlementKind::Channel);
        assert!(channel
            .access(&token, &issuer(), &fp(SUBJECT_SEED), 2_000)
            .is_ok());
    }

    #[test]
    fn missing_channel_book_is_empty_and_corrupted_one_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("channels.json");
        assert!(ChannelBook::load_from(&path).unwrap().is_empty());

        std::fs::write(&path, b"{not json").unwrap();
        assert!(matches!(
            ChannelBook::load_from(&path),
            Err(ChannelStoreError::Format(_))
        ));
    }

    #[test]
    fn debug_never_prints_the_epoch_key() {
        let mut channel = channel();
        channel.subscribe(&fp(SUBJECT_SEED));
        let token = token(&channel, EntitlementKind::Channel);
        let access = channel
            .access(&token, &issuer(), &fp(SUBJECT_SEED), 2_000)
            .unwrap();
        let rendered = format!("{access:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains(&hex::encode(access.key())));
        assert!(!format!("{channel:?}").contains(&hex::encode(access.key())));
    }
}
