//! Vault Sfera — пост: тело + аудитория + медиа, подпись и проверка
//! (ADR-006 §3).
//!
//! Подпись — то же правило и тот же домен `sfera-post:v1\0`, что в
//! `social_model::post` (обобщённая `sign_value`/`verify_value`), а не вторая
//! копия алгоритма. Подписывается канонический JCS поста БЕЗ поля `sig`.

use social_model::{post as signing, Author, FORMAT_VERSION};
use social_rights::Audience;
use storage_api::BlobId;

pub const POST_KIND: &str = "social_post";

/// Аудитория поста: ссылка на именованный набор + эпоха ключа.
/// `spec` — та же форма аудитории, что проверяет `social-rights`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PostAudience {
    /// `aud_<hex>` или id сферы.
    pub id: String,
    /// Эпоха ключа аудитории на момент публикации (ADR-006 §4).
    pub epoch: u64,
    pub spec: Audience,
}

/// Ссылка на медиа в посте. Ключ файла сюда НЕ входит: он завёрнут ключом
/// аудитории и едет отдельно (ADR-006 §5.2).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MediaRef {
    pub blob_id: BlobId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_blob_id: Option<BlobId>,
    pub mime: String,
    /// Размер шифрованного блоба в байтах.
    pub size: u64,
}

/// Пост версии 1 — именно эта форма подписывается.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PostV1 {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub author: Author,
    pub ts: u64,
    pub body: String,
    pub audience: PostAudience,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<MediaRef>,
}

/// Подписанный пост: форма поста + подпись рядом (не внутри подписываемого).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SignedPost {
    pub post: PostV1,
    pub sig: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PostError {
    InvalidVersion(u8),
    InvalidKind(String),
    EmptyAudienceId,
    InvalidEpoch,
    EmptyMime,
    EmptyMedia,
    BadAuthor(String),
    Sign(String),
}

impl std::fmt::Display for PostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidVersion(v) => write!(f, "unsupported post version: {v}"),
            Self::InvalidKind(k) => write!(f, "unsupported post type: {k}"),
            Self::EmptyAudienceId => f.write_str("audience id must not be empty"),
            Self::InvalidEpoch => f.write_str("audience epoch must be >= 1"),
            Self::EmptyMime => f.write_str("media mime must not be empty"),
            Self::EmptyMedia => f.write_str("media size must be > 0"),
            Self::BadAuthor(m) => write!(f, "bad author key: {m}"),
            Self::Sign(m) => write!(f, "sign failed: {m}"),
        }
    }
}

impl std::error::Error for PostError {}

impl PostV1 {
    /// Собрать и провалидировать пост.
    pub fn new(
        author: Author,
        ts: u64,
        body: impl Into<String>,
        audience: PostAudience,
        media: Vec<MediaRef>,
    ) -> Result<Self, PostError> {
        let post = Self {
            v: FORMAT_VERSION,
            kind: POST_KIND.to_string(),
            author,
            ts,
            body: body.into(),
            audience,
            media,
        };
        post.validate()?;
        Ok(post)
    }

    /// Семантическая проверка формы (не подписи).
    pub fn validate(&self) -> Result<(), PostError> {
        if self.v != FORMAT_VERSION {
            return Err(PostError::InvalidVersion(self.v));
        }
        if self.kind != POST_KIND {
            return Err(PostError::InvalidKind(self.kind.clone()));
        }
        if self.audience.id.trim().is_empty() {
            return Err(PostError::EmptyAudienceId);
        }
        if self.audience.epoch == 0 {
            return Err(PostError::InvalidEpoch);
        }
        for media in &self.media {
            if media.mime.trim().is_empty() {
                return Err(PostError::EmptyMime);
            }
            if media.size == 0 {
                return Err(PostError::EmptyMedia);
            }
        }
        Ok(())
    }
}

/// Канонический JCS поста — то, что подписывается (без домена).
pub fn canonical_post(post: &PostV1) -> Result<Vec<u8>, String> {
    social_model::canonical::canonical_bytes(post)
}

/// Подписать готовый пост приватным ключом автора.
pub fn sign_post(seed_hex: &str, post: &PostV1) -> Result<SignedPost, PostError> {
    post.validate()?;
    let sig = signing::sign_value(seed_hex, post).map_err(PostError::Sign)?;
    Ok(SignedPost {
        post: post.clone(),
        sig,
    })
}

/// Собрать и подписать пост из ключа автора (удобный путь для ленты).
pub fn compose(
    seed_hex: &str,
    ts: u64,
    body: impl Into<String>,
    audience: PostAudience,
    media: Vec<MediaRef>,
) -> Result<SignedPost, PostError> {
    let pub_key = signing::public_key_hex(seed_hex).map_err(PostError::BadAuthor)?;
    let author = Author::from_public_key_hex(&pub_key).map_err(PostError::BadAuthor)?;
    let post = PostV1::new(author, ts, body, audience, media)?;
    sign_post(seed_hex, &post)
}

/// Проверка подписи И формы. Любая правка (тело, аудитория, медиа, ts)
/// ломает подпись; подмена `author.fp` отвергается проверкой ключа.
pub fn verify_post(signed: &SignedPost) -> bool {
    signed.post.validate().is_ok()
        && signing::verify_value(&signed.post, &signed.post.author, &signed.sig)
}

pub const POST_ENVELOPE_DOMAIN: &[u8] = b"sfera-post-delivery:v1\0";

/// Ошибка типизированного plaintext поста до его E2E-упаковки.
/// Доставка лишь шифрует этот JSON и не знает правил подписи поста.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PostEnvelopeError {
    Wrap(String),
    Unwrap(String),
}

impl std::fmt::Display for PostEnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wrap(message) => f.write_str(message),
            Self::Unwrap(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for PostEnvelopeError {}

pub fn post_envelope_json(post: &SignedPost) -> Result<String, PostEnvelopeError> {
    if !verify_post(post) {
        return Err(PostEnvelopeError::Wrap("post signature is invalid".into()));
    }
    serde_json::to_string(post).map_err(|e| PostEnvelopeError::Wrap(e.to_string()))
}

pub fn parse_post_envelope_json(plaintext: &str) -> Result<SignedPost, PostEnvelopeError> {
    let post: SignedPost = serde_json::from_str(plaintext)
        .map_err(|e| PostEnvelopeError::Unwrap(format!("post envelope: {e}")))?;
    if !verify_post(&post) {
        return Err(PostEnvelopeError::Unwrap("post signature is invalid".into()));
    }
    Ok(post)
}

pub fn post_publication_id(
    post: &SignedPost,
    recipient: &social_model::Fingerprint,
) -> Result<String, PostEnvelopeError> {
    use sha2::{Digest, Sha256};
    let canonical = canonical_post(&post.post).map_err(PostEnvelopeError::Wrap)?;
    let mut hasher = Sha256::new();
    hasher.update(POST_ENVELOPE_DOMAIN);
    hasher.update(canonical);
    hasher.update(recipient.as_str().as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod envelope_tests {
    use super::*;

    #[test]
    fn addressed_post_is_typed_signed_and_not_accepted_after_tampering() {
        let seed = "01".repeat(32);
        let recipient = social_model::Fingerprint::from_public_key_hex(
            &social_model::post::public_key_hex(&"02".repeat(32)).unwrap(),
        ).unwrap();
        let post = compose(&seed, 1, "Секретный пост",
            PostAudience {
                id: "family".into(), epoch: 1, spec: social_rights::Audience::AllContacts,
            }, vec![]).unwrap();
        let plaintext = post_envelope_json(&post).unwrap();
        assert_eq!(parse_post_envelope_json(&plaintext).unwrap(), post);
        let id = post_publication_id(&post, &recipient).unwrap();
        assert_eq!(id, post_publication_id(&post, &recipient).unwrap());
        assert_ne!(id, post_publication_id(&post, &post.post.author.fp).unwrap());
        let mut tampered = post;
        tampered.post.body = "Подмена".into();
        assert!(parse_post_envelope_json(&serde_json::to_string(&tampered).unwrap()).is_err());
    }
}
