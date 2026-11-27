//! Платный доступ создателя: подписанное право на контент (канал, рассылка,
//! сообщество, коммерческая страница, платное сообщение).
//!
//! Сервер видит только платёж, поэтому право приходит отдельным подписанным
//! токеном и проверяется локально. Цены и сроки в коде не живут: их присылает
//! каталог создателя, здесь — только форма и проверка подписи.
//!
//! Отзыв права — это прекращение выдачи ключей следующих эпох (`key_id`), а не
//! удаление уже доставленного контента. Это ограничение E2E, а не недоделка.

use serde::{Deserialize, Serialize};
use social_model::post as signing;
use social_model::{Author, Fingerprint};

/// Домен подписи отделяет право от поста, профиля и аттестации комментария.
pub const ENTITLEMENT_DOMAIN: &[u8] = b"sfera-creator-entitlement:v1\0";
pub const ENTITLEMENT_VERSION: u8 = 1;
const KEY_ID_HEX_LEN: usize = 64;

/// Что именно оплачено. Один тип токена на все платные потоки, чтобы клиент
/// проверял право одинаково и не заводил вторую систему доступа.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntitlementKind {
    Channel,
    Newsletter,
    Community,
    Business,
    PaidMessage,
    Tip,
}

/// Право подписчика на контент создателя на период.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatorEntitlement {
    pub v: u8,
    pub kind: EntitlementKind,
    /// Кто продаёт доступ.
    pub creator: Fingerprint,
    /// Кому выдан доступ.
    pub subject: Fingerprint,
    pub plan: String,
    /// Идентификатор эпохного ключа контента (32 байта, hex).
    pub key_id: String,
    pub period_start: u64,
    pub period_end: u64,
    pub issued_at: u64,
    /// Идентификатор платежа у провайдера. Не секрет и не карта.
    #[serde(default)]
    pub payment_id: String,
    pub sig: String,
}

impl CreatorEntitlement {
    /// Копия без подписи — ровно то, что подписывается и проверяется.
    #[must_use]
    pub fn unsigned(&self) -> Self {
        Self { sig: String::new(), ..self.clone() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntitlementError {
    UnsupportedVersion,
    EmptyPlan,
    BadKeyId,
    BadPeriod,
    BadSignature,
    WrongCreator,
    WrongSubject,
    NotYetValid,
    Expired,
}

impl std::fmt::Display for EntitlementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnsupportedVersion => "entitlement version is not supported",
            Self::EmptyPlan => "entitlement plan is empty",
            Self::BadKeyId => "entitlement key id is not a 32-byte hex value",
            Self::BadPeriod => "entitlement period is empty or reversed",
            Self::BadSignature => "entitlement signature is invalid",
            Self::WrongCreator => "entitlement belongs to another creator",
            Self::WrongSubject => "entitlement belongs to another subject",
            Self::NotYetValid => "entitlement is not active yet",
            Self::Expired => "entitlement has expired",
        })
    }
}

impl std::error::Error for EntitlementError {}

/// Проверить форму и подпись токена. Издатель — ключ биллинг-сервиса; клиент
/// получает его публичную часть заранее и не доверяет полю внутри токена.
pub fn verify_entitlement(
    token: &CreatorEntitlement,
    issuer: &Author,
) -> Result<(), EntitlementError> {
    if token.v != ENTITLEMENT_VERSION {
        return Err(EntitlementError::UnsupportedVersion);
    }
    if token.plan.trim().is_empty() {
        return Err(EntitlementError::EmptyPlan);
    }
    if token.key_id.len() != KEY_ID_HEX_LEN
        || !token.key_id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(EntitlementError::BadKeyId);
    }
    if token.period_end <= token.period_start {
        return Err(EntitlementError::BadPeriod);
    }
    if !signing::verify_with_domain(
        ENTITLEMENT_DOMAIN,
        &token.unsigned(),
        issuer,
        &token.sig,
    ) {
        return Err(EntitlementError::BadSignature);
    }
    Ok(())
}

/// Полная проверка права: подпись, владелец, получатель и окно действия.
/// `now` передаёт вызывающий код, а не токен: время — не часть доверия.
pub fn check_entitlement(
    token: &CreatorEntitlement,
    issuer: &Author,
    creator: &Fingerprint,
    subject: &Fingerprint,
    now: u64,
) -> Result<(), EntitlementError> {
    verify_entitlement(token, issuer)?;
    if !token.creator.same(creator) {
        return Err(EntitlementError::WrongCreator);
    }
    if !token.subject.same(subject) {
        return Err(EntitlementError::WrongSubject);
    }
    if now < token.period_start {
        return Err(EntitlementError::NotYetValid);
    }
    if now >= token.period_end {
        return Err(EntitlementError::Expired);
    }
    Ok(())
}

/// Ответ на вопрос «можно ли отдавать ключ этой эпохи сейчас».
#[must_use]
pub fn entitlement_active(
    token: &CreatorEntitlement,
    issuer: &Author,
    creator: &Fingerprint,
    subject: &Fingerprint,
    now: u64,
) -> bool {
    check_entitlement(token, issuer, creator, subject, now).is_ok()
}

// --- Каталог тарифов создателя ---------------------------------------------

/// Один тариф автора. Цена в копейках, без плавающей точки.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatorPlan {
    pub plan: String,
    pub title: String,
    pub kind: EntitlementKind,
    pub months: u16,
    pub kopecks: u64,
    pub currency: String,
}

/// Витрина автора: кому продаём и какие периоды есть.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatorCatalog {
    pub creator: Fingerprint,
    pub plans: Vec<CreatorPlan>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreatorCatalogError {
    Empty,
    EmptyPlan,
    DuplicatePlan,
    BadMonths,
    NonPositivePrice,
    EmptyCurrency,
}

impl std::fmt::Display for CreatorCatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "creator catalog has no plans",
            Self::EmptyPlan => "creator plan id is empty",
            Self::DuplicatePlan => "creator plan is duplicated",
            Self::BadMonths => "creator plan period must be positive",
            Self::NonPositivePrice => "creator plan price must be positive",
            Self::EmptyCurrency => "creator plan currency is empty",
        })
    }
}

impl std::error::Error for CreatorCatalogError {}

/// Проверить витрину до показа. Кривой каталог не должен превращаться в
/// бесплатную подписку или в тариф с нулевым сроком.
pub fn validate_creator_catalog(catalog: &CreatorCatalog) -> Result<(), CreatorCatalogError> {
    if catalog.plans.is_empty() {
        return Err(CreatorCatalogError::Empty);
    }
    let mut seen = std::collections::BTreeSet::new();
    for plan in &catalog.plans {
        if plan.plan.trim().is_empty() {
            return Err(CreatorCatalogError::EmptyPlan);
        }
        if plan.months == 0 {
            return Err(CreatorCatalogError::BadMonths);
        }
        if plan.kopecks == 0 {
            return Err(CreatorCatalogError::NonPositivePrice);
        }
        if plan.currency.trim().is_empty() {
            return Err(CreatorCatalogError::EmptyCurrency);
        }
        if !seen.insert((plan.plan.as_str(), plan.months)) {
            return Err(CreatorCatalogError::DuplicatePlan);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ISSUER_SEED: &str = "0900000000000000000000000000000000000000000000000000000000000009";
    const CREATOR_SEED: &str = "0100000000000000000000000000000000000000000000000000000000000001";
    const SUBJECT_SEED: &str = "0200000000000000000000000000000000000000000000000000000000000002";

    fn fp(seed: &str) -> Fingerprint {
        Fingerprint::from_public_key_hex(&signing::public_key_hex(seed).unwrap()).unwrap()
    }

    fn issuer() -> Author {
        Author::from_public_key_hex(&signing::public_key_hex(ISSUER_SEED).unwrap()).unwrap()
    }

    fn token() -> CreatorEntitlement {
        let mut token = CreatorEntitlement {
            v: ENTITLEMENT_VERSION,
            kind: EntitlementKind::Channel,
            creator: fp(CREATOR_SEED),
            subject: fp(SUBJECT_SEED),
            plan: "monthly".into(),
            key_id: "ab".repeat(32),
            period_start: 1_000,
            period_end: 1_000 + 30 * 86_400,
            issued_at: 999,
            payment_id: "pay_123".into(),
            sig: String::new(),
        };
        token.sig =
            signing::sign_with_domain(ENTITLEMENT_DOMAIN, ISSUER_SEED, &token).unwrap();
        token
    }

    #[test]
    fn valid_entitlement_is_active_inside_its_period() {
        let token = token();
        assert_eq!(verify_entitlement(&token, &issuer()), Ok(()));
        assert!(entitlement_active(
            &token,
            &issuer(),
            &fp(CREATOR_SEED),
            &fp(SUBJECT_SEED),
            2_000,
        ));
    }

    #[test]
    fn expired_and_not_yet_valid_are_distinguished() {
        let token = token();
        assert_eq!(
            check_entitlement(&token, &issuer(), &fp(CREATOR_SEED), &fp(SUBJECT_SEED), 999),
            Err(EntitlementError::NotYetValid)
        );
        assert_eq!(
            check_entitlement(
                &token,
                &issuer(),
                &fp(CREATOR_SEED),
                &fp(SUBJECT_SEED),
                token.period_end,
            ),
            Err(EntitlementError::Expired)
        );
    }

    #[test]
    fn entitlement_cannot_be_reused_for_another_subject_or_creator() {
        let token = token();
        let other = fp("0300000000000000000000000000000000000000000000000000000000000003");
        assert_eq!(
            check_entitlement(&token, &issuer(), &fp(CREATOR_SEED), &other, 2_000),
            Err(EntitlementError::WrongSubject)
        );
        assert_eq!(
            check_entitlement(&token, &issuer(), &other, &fp(SUBJECT_SEED), 2_000),
            Err(EntitlementError::WrongCreator)
        );
    }

    #[test]
    fn any_field_change_breaks_the_signature() {
        let mut token = token();
        token.plan = "annual".into();
        assert_eq!(
            verify_entitlement(&token, &issuer()),
            Err(EntitlementError::BadSignature)
        );
    }

    #[test]
    fn token_signed_for_another_domain_is_rejected() {
        let mut token = token();
        token.sig = signing::sign_with_domain(b"other-domain:v1\0", ISSUER_SEED, &token.unsigned())
            .unwrap();
        assert_eq!(
            verify_entitlement(&token, &issuer()),
            Err(EntitlementError::BadSignature)
        );
    }

    #[test]
    fn malformed_key_id_is_rejected_before_signature_use() {
        let mut token = token();
        token.key_id = "ab".repeat(16);
        assert_eq!(
            verify_entitlement(&token, &issuer()),
            Err(EntitlementError::BadKeyId)
        );
    }

    fn catalog() -> CreatorCatalog {
        CreatorCatalog {
            creator: fp(CREATOR_SEED),
            plans: vec![CreatorPlan {
                plan: "monthly".into(),
                title: "Месяц".into(),
                kind: EntitlementKind::Channel,
                months: 1,
                kopecks: 29_900,
                currency: "RUB".into(),
            }],
        }
    }

    #[test]
    fn creator_catalog_rejects_zero_price_and_duplicates() {
        assert_eq!(validate_creator_catalog(&catalog()), Ok(()));

        let mut free = catalog();
        free.plans[0].kopecks = 0;
        assert_eq!(
            validate_creator_catalog(&free),
            Err(CreatorCatalogError::NonPositivePrice)
        );

        let mut duplicate = catalog();
        duplicate.plans.push(catalog().plans[0].clone());
        assert_eq!(
            validate_creator_catalog(&duplicate),
            Err(CreatorCatalogError::DuplicatePlan)
        );
    }
}
