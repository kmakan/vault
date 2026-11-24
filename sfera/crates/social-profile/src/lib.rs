//! Vault Sfera — профиль: имя, аватар, био, ссылки (ADR-006 §7.6).
//!
//! Профиль — типизированный конверт со своей подписью в **отдельном домене**
//! `sfera-profile:v1\0`. Домен отделяет подпись профиля от подписи поста
//! (`sfera-post:v1\0`): один и тот же ключ не должен создавать взаимозаменяемые
//! подписи для разных объектов. Само правило подписи не дублируется — профиль
//! вызывает `social_model::post::{sign_with_domain, verify_with_domain}`.
//!
//! Аватар — ссылка на зашифрованный блоб (`BlobId`), ключ едет отдельно в E2E,
//! как и у медиа поста. Решения о видимости профиля принимает `social-rights`;
//! здесь — только форма, подпись и чистое правило «новее побеждает» в книге.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

use social_model::{post as signing, Author, Fingerprint, FORMAT_VERSION};
use storage_api::BlobId;

/// Тип конверта профиля.
pub const PROFILE_KIND: &str = "social_profile";
/// Домен подписи профиля. Не менять без мажорной версии формата.
pub const SIGN_DOMAIN: &[u8] = b"sfera-profile:v1\0";

/// Домен идентификатора профиля: отделён от домена подписи, чтобы значение
/// `profile_id` нельзя было предъявить как подпись и наоборот.
pub const PROFILE_ID_DOMAIN: &[u8] = b"sfera-profile-id:v1\0";

pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_BIO_CHARS: usize = 500;
pub const MAX_LINKS: usize = 8;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_URL_CHARS: usize = 2048;

/// Аватар: ссылка на зашифрованный блоб, без ключа (ключ — в E2E-конверте).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AvatarRef {
    pub blob_id: BlobId,
    pub mime: String,
    /// Размер шифрованного блоба в байтах.
    pub size: u64,
}

/// Ссылка в профиле: подпись и URL. Разрешены только `https://`, `http://`,
/// `mailto:` — `javascript:` и прочие схемы в профиле не нужны.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProfileLink {
    pub label: String,
    pub url: String,
}

/// Профиль версии 1 — именно эта форма подписывается.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProfileV1 {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub author: Author,
    pub ts: u64,
    pub display_name: String,
    pub bio: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<AvatarRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<ProfileLink>,
}

/// Подписанный профиль: форма + подпись рядом (не внутри подписываемого).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SignedProfile {
    pub profile: ProfileV1,
    pub sig: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProfileError {
    InvalidVersion(u8),
    InvalidKind(String),
    EmptyName,
    NameTooLong { max: usize },
    BioTooLong { max: usize },
    TooManyLinks { max: usize },
    EmptyLinkLabel,
    LabelTooLong { max: usize },
    BadUrl(String),
    EmptyAvatarMime,
    EmptyAvatar,
    BadAuthor(String),
    Sign(String),
    /// Подпись не прошла проверку (в том числе чужой домен).
    InvalidSignature,
    Canonical(String),
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVersion(v) => write!(f, "unsupported profile version: {v}"),
            Self::InvalidKind(k) => write!(f, "unsupported profile type: {k}"),
            Self::EmptyName => f.write_str("display_name must not be empty"),
            Self::NameTooLong { max } => write!(f, "display_name exceeds {max} chars"),
            Self::BioTooLong { max } => write!(f, "bio exceeds {max} chars"),
            Self::TooManyLinks { max } => write!(f, "too many links (max {max})"),
            Self::EmptyLinkLabel => f.write_str("link label must not be empty"),
            Self::LabelTooLong { max } => write!(f, "link label exceeds {max} chars"),
            Self::BadUrl(u) => write!(f, "invalid link url: {u}"),
            Self::EmptyAvatarMime => f.write_str("avatar mime must not be empty"),
            Self::EmptyAvatar => f.write_str("avatar size must be > 0"),
            Self::BadAuthor(m) => write!(f, "bad author key: {m}"),
            Self::Sign(m) => write!(f, "sign failed: {m}"),
            Self::InvalidSignature => f.write_str("profile signature is invalid"),
            Self::Canonical(m) => write!(f, "canonical profile failed: {m}"),
        }
    }
}

impl std::error::Error for ProfileError {}

impl ProfileV1 {
    /// Собрать и провалидировать профиль.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        author: Author,
        ts: u64,
        display_name: impl Into<String>,
        bio: impl Into<String>,
        avatar: Option<AvatarRef>,
        links: Vec<ProfileLink>,
    ) -> Result<Self, ProfileError> {
        let profile = Self {
            v: FORMAT_VERSION,
            kind: PROFILE_KIND.to_string(),
            author,
            ts,
            display_name: display_name.into(),
            bio: bio.into(),
            avatar,
            links,
        };
        profile.validate()?;
        Ok(profile)
    }

    /// Семантическая проверка формы (не подписи).
    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.v != FORMAT_VERSION {
            return Err(ProfileError::InvalidVersion(self.v));
        }
        if self.kind != PROFILE_KIND {
            return Err(ProfileError::InvalidKind(self.kind.clone()));
        }
        let name = self.display_name.trim();
        if name.is_empty() {
            return Err(ProfileError::EmptyName);
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(ProfileError::NameTooLong { max: MAX_NAME_CHARS });
        }
        if self.bio.chars().count() > MAX_BIO_CHARS {
            return Err(ProfileError::BioTooLong { max: MAX_BIO_CHARS });
        }
        if self.links.len() > MAX_LINKS {
            return Err(ProfileError::TooManyLinks { max: MAX_LINKS });
        }
        for link in &self.links {
            let label = link.label.trim();
            if label.is_empty() {
                return Err(ProfileError::EmptyLinkLabel);
            }
            if label.chars().count() > MAX_LABEL_CHARS {
                return Err(ProfileError::LabelTooLong { max: MAX_LABEL_CHARS });
            }
            if !valid_url(&link.url) {
                return Err(ProfileError::BadUrl(link.url.clone()));
            }
        }
        if let Some(avatar) = &self.avatar {
            if avatar.mime.trim().is_empty() {
                return Err(ProfileError::EmptyAvatarMime);
            }
            if avatar.size == 0 {
                return Err(ProfileError::EmptyAvatar);
            }
        }
        Ok(())
    }
}

/// URL в профиле: только `https://`, `http://`, `mailto:`; без пробелов и
/// управляющих символов. Проверка формы, а не сетевой проверки.
fn valid_url(url: &str) -> bool {
    if url.is_empty() || url.chars().count() > MAX_URL_CHARS {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if let Some(addr) = url.strip_prefix("mailto:") {
        return addr.contains('@');
    }
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            return !rest.is_empty() && !rest.starts_with('/') && rest.contains('.');
        }
    }
    false
}

/// Канонический JCS профиля — то, что подписывается (без домена).
pub fn canonical_profile(profile: &ProfileV1) -> Result<Vec<u8>, String> {
    social_model::canonical::canonical_bytes(profile)
}

/// Подписать готовый профиль приватным ключом автора.
pub fn sign_profile(seed_hex: &str, profile: &ProfileV1) -> Result<SignedProfile, ProfileError> {
    profile.validate()?;
    let sig = signing::sign_with_domain(SIGN_DOMAIN, seed_hex, profile).map_err(ProfileError::Sign)?;
    Ok(SignedProfile {
        profile: profile.clone(),
        sig,
    })
}

/// Собрать и подписать профиль из ключа автора.
pub fn compose(
    seed_hex: &str,
    ts: u64,
    display_name: impl Into<String>,
    bio: impl Into<String>,
    avatar: Option<AvatarRef>,
    links: Vec<ProfileLink>,
) -> Result<SignedProfile, ProfileError> {
    let pub_key = signing::public_key_hex(seed_hex).map_err(ProfileError::BadAuthor)?;
    let author = Author::from_public_key_hex(&pub_key).map_err(ProfileError::BadAuthor)?;
    let profile = ProfileV1::new(author, ts, display_name, bio, avatar, links)?;
    sign_profile(seed_hex, &profile)
}

/// Проверка подписи И формы. Подпись, сделанная в домене поста, не пройдёт.
pub fn verify_profile(signed: &SignedProfile) -> bool {
    signed.profile.validate().is_ok()
        && signing::verify_with_domain(
            SIGN_DOMAIN,
            &signed.profile,
            &signed.profile.author,
            &signed.sig,
        )
}

/// Результат обновления книги профилей.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpsertOutcome {
    Inserted,
    Updated,
    /// Тот же профиль уже есть (повторная доставка).
    Duplicate,
    /// Входящий профиль старше сохранённого или проиграл детерминированный
    /// tie-break при равном `ts` — откат не допускается.
    Stale,
}

/// Локальная книга профилей, ключ — канонический отпечаток автора.
#[derive(Clone, Debug, Default)]
pub struct ProfileBook {
    by_fp: BTreeMap<String, SignedProfile>,
}

impl ProfileBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Принять профиль. Подпись проверяется; более старый не откатывает новый.
    pub fn upsert(&mut self, signed: SignedProfile) -> Result<UpsertOutcome, ProfileError> {
        if !verify_profile(&signed) {
            return Err(ProfileError::InvalidSignature);
        }
        let fp = signed.profile.author.fp.as_str().to_string();
        let Some(existing) = self.by_fp.get(&fp) else {
            self.by_fp.insert(fp, signed);
            return Ok(UpsertOutcome::Inserted);
        };

        match signed.profile.ts.cmp(&existing.profile.ts) {
            std::cmp::Ordering::Less => return Ok(UpsertOutcome::Stale),
            std::cmp::Ordering::Greater => {
                self.by_fp.insert(fp, signed);
                return Ok(UpsertOutcome::Updated);
            }
            std::cmp::Ordering::Equal => {
                let incoming = canonical_profile(&signed.profile).map_err(ProfileError::Canonical)?;
                let stored =
                    canonical_profile(&existing.profile).map_err(ProfileError::Canonical)?;
                if incoming == stored {
                    return Ok(UpsertOutcome::Duplicate);
                }
                // Равный `ts`, разное содержание: оба устройства должны выбрать
                // один и тот же профиль без переговоров.
                if incoming <= stored {
                    return Ok(UpsertOutcome::Stale);
                }
                self.by_fp.insert(fp, signed);
                Ok(UpsertOutcome::Updated)
            }
        }
    }

    pub fn get(&self, fp: &Fingerprint) -> Option<&SignedProfile> {
        self.by_fp.get(fp.as_str())
    }

    pub fn len(&self) -> usize {
        self.by_fp.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_fp.is_empty()
    }

    pub fn remove(&mut self, fp: &Fingerprint) -> Option<SignedProfile> {
        self.by_fp.remove(fp.as_str())
    }

    /// Снимок для сохранения (порядок не важен — он по `fp`).
    pub fn snapshot(&self) -> Vec<SignedProfile> {
        self.by_fp.values().cloned().collect()
    }

    /// Восстановить книгу: каждый профиль перепроверяется, более старый не
    /// вытесняет новый.
    pub fn restore(
        profiles: impl IntoIterator<Item = SignedProfile>,
    ) -> Result<Self, ProfileError> {
        let mut book = ProfileBook::new();
        for signed in profiles {
            book.upsert(signed)?;
        }
        Ok(book)
    }
}

/// Сериализовать подписанный профиль для E2E-конверта. Вместе с ним может
/// ехать манифест аватара: его тип принадлежит social-library, поэтому здесь
/// он передаётся готовым JSON-значением, без обратной зависимости фич.
pub fn envelope_json(
    signed: &SignedProfile,
    avatar_manifest: Option<&serde_json::Value>,
) -> Result<String, ProfileError> {
    let mut value = serde_json::json!({ "profile": signed });
    if let Some(manifest) = avatar_manifest {
        value["avatar_manifest"] = manifest.clone();
    }
    serde_json::to_string(&value).map_err(|e| ProfileError::Canonical(e.to_string()))
}

/// Разобрать содержимое адресного конверта. Манифест валидируется в тип,
/// а не остаётся непрозрачным JSON с произвольным ключом.
pub fn parse_envelope_json(
    plaintext: &str,
) -> Result<(SignedProfile, Option<social_library::AvatarManifest>), ProfileError> {
    let value: serde_json::Value = serde_json::from_str(plaintext)
        .map_err(|e| ProfileError::Canonical(format!("envelope json: {e}")))?;
    let signed: SignedProfile = serde_json::from_value(value.get("profile").cloned().ok_or_else(|| {
        ProfileError::Canonical("envelope has no profile".into())
    })?)
    .map_err(|e| ProfileError::Canonical(format!("envelope profile: {e}")))?;
    if !verify_profile(&signed) {
        return Err(ProfileError::InvalidSignature);
    }
    let manifest: Option<social_library::AvatarManifest> = value.get("avatar_manifest").cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| ProfileError::Canonical(format!("avatar manifest: {e}")))?;
    if let (Some(avatar), Some(manifest)) = (signed.profile.avatar.as_ref(), manifest.as_ref()) {
        if manifest.blob_id != avatar.blob_id.to_hex() {
            return Err(ProfileError::Canonical("avatar manifest does not match profile".into()));
        }
    }
    Ok((signed, manifest))
}

/// Идентификатор одной версии публикации. Стабильный `profile_id` отвечает
/// на «какой профиль», а outbox требует также «какая версия»: иначе обновление
/// имени или аватара навсегда выглядело бы дубликатом первой отправки.
pub fn publication_id(signed: &SignedProfile, recipient: &Fingerprint) -> Result<String, ProfileError> {
    let canonical = canonical_profile(&signed.profile).map_err(ProfileError::Canonical)?;
    let mut hasher = Sha256::new();
    hasher.update(PROFILE_ID_DOMAIN);
    hasher.update(&canonical);
    hasher.update(recipient.as_str().as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn profile_publication_id_changes_with_version_and_recipient() {
        let first = compose(SEED, 100, "Анна", "", None, vec![]).unwrap();
        let updated = compose(SEED, 200, "Анна Петрова", "", None, vec![]).unwrap();
        let alice = Fingerprint::from_public_key_hex(&"11".repeat(32)).unwrap();
        let bob = Fingerprint::from_public_key_hex(&"22".repeat(32)).unwrap();
        assert_ne!(publication_id(&first, &alice).unwrap(), publication_id(&updated, &alice).unwrap());
        assert_ne!(publication_id(&first, &alice).unwrap(), publication_id(&first, &bob).unwrap());
        assert_eq!(publication_id(&first, &alice).unwrap(), publication_id(&first, &alice).unwrap());
    }

    #[test]
    fn envelope_contains_signed_profile_and_optional_avatar_manifest() {
        let signed = compose(SEED, 100, "Анна", "", None, vec![]).unwrap();
        let manifest = serde_json::json!({"blob_id":"ab","file_key_hex":"cd"});
        let value: serde_json::Value = serde_json::from_str(&envelope_json(&signed, Some(&manifest)).unwrap()).unwrap();
        assert_eq!(value["profile"]["profile"]["display_name"], "Анна");
        assert_eq!(value["profile"]["sig"], signed.sig);
        assert_eq!(value["avatar_manifest"], manifest);
        let without: serde_json::Value = serde_json::from_str(&envelope_json(&signed, None).unwrap()).unwrap();
        assert!(without.get("avatar_manifest").is_none());
    }

    #[test]
    fn envelope_parse_verifies_signature_and_keeps_manifest() {
        let signed = compose(SEED, 100, "Анна", "", None, vec![]).unwrap();
        let manifest = serde_json::json!({
            "blob_id": signed.profile.avatar.as_ref().map_or("ab".into(), |a| a.blob_id.to_hex()),
            "content_id": "content", "file_key_hex": "11".repeat(32),
            "nonce_prefix_hex": "22".repeat(4), "mime": "image/png", "size": 3,
            "store_id": "local", "uri": "/tmp/avatar", "set_at": 1,
        });
        let plaintext = envelope_json(&signed, Some(&manifest)).unwrap();
        let (parsed, parsed_manifest) = parse_envelope_json(&plaintext).unwrap();
        assert_eq!(parsed, signed);
        assert_eq!(parsed_manifest.map(|m| m.file_key_hex), Some("11".repeat(32)));
        let tampered = plaintext.replace("Анна", "Ева");
        assert_eq!(parse_envelope_json(&tampered).unwrap_err(), ProfileError::InvalidSignature);
        assert!(parse_envelope_json("{}").is_err());
    }

    #[test]
    fn name_with_only_spaces_is_rejected() {
        let p = compose(SEED, 1, "   ", "", None, vec![]);
        assert_eq!(p.unwrap_err(), ProfileError::EmptyName);
    }

    #[test]
    fn javascript_scheme_is_rejected() {
        let links = vec![ProfileLink {
            label: "сайт".into(),
            url: "javascript:alert(1)".into(),
        }];
        let err = compose(SEED, 1, "Аня", "", None, links).unwrap_err();
        assert!(matches!(err, ProfileError::BadUrl(_)));
    }
}

/// Стабильный идентификатор профиля для ссылок и публичных страниц
/// (ADR-008: коммерческие страницы должны быть адресуемы).
///
/// Считается от ПУБЛИЧНОГО ключа автора, а не от `ts` или имени: смена
/// отображаемого имени или аватара не должна ломать уже разосланные ссылки.
/// Домен разделён с подписью профиля — значение нельзя спутать с подписью
/// или переиспользовать как её.
pub fn profile_id(signed: &SignedProfile) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PROFILE_ID_DOMAIN);
    hasher.update(signed.profile.author.pub_key.as_bytes());
    hex::encode(hasher.finalize())
}

/// Короткая форма идентификатора для показа человеку: первые 16 hex-символов.
/// Для адресации использовать полную (`profile_id`), короткая — только подпись.
pub fn profile_id_short(signed: &SignedProfile) -> String {
    profile_id(signed)[..16].to_string()
}
