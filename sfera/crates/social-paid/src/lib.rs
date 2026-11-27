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

use std::fmt;

use sfera_billing::creator::{
    check_entitlement, CreatorEntitlement, EntitlementError, EntitlementKind,
};
use sha2::{Digest, Sha256};
use social_audience::{AudienceKeys, MembershipChange};
use social_delivery::{
    unwrap_audience_key, wrap_audience_key, DeliveryError, RecipientKeyMaterial,
    SenderKeyMaterial, WrappedAudienceKey,
};
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
