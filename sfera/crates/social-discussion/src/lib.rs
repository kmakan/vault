//! Подписанные комментарии и реакции к постам Sfera.
//!
//! Подпись доказывает авторство, но НЕ доступ к посту: исходная аудитория и
//! `can_react` проверяются композиционным корнем до ingest. Здесь — форма,
//! отдельные домены подписи, стабильные ID и детерминированная локальная книга.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use sha2::{Digest, Sha256};
use social_model::{post as signing, Author, Fingerprint, FORMAT_VERSION};
use social_post::{MediaRef, PostAudience, SignedPost};

pub const COMMENT_KIND: &str = "social_comment";
pub const REACTION_KIND: &str = "social_reaction";
pub const COMMENT_DOMAIN: &[u8] = b"sfera-comment:v1\0";
pub const REACTION_DOMAIN: &[u8] = b"sfera-reaction:v1\0";
pub const MAX_COMMENT_CHARS: usize = 4_000;
pub const ENVELOPE_DOMAIN: &[u8] = b"sfera-discussion-envelope:v1\0";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "event", rename_all = "snake_case")]
pub enum DiscussionPayload {
    SocialComment(SignedComment),
    SocialReaction(SignedReaction),
    /// Участник → владельцу поста. Владелец проверяет свою книгу и исходный
    /// пост, затем выпускает подтверждение для исходной аудитории.
    CommentSubmission { comment: SignedComment, post: SignedPost },
    ReactionSubmission { reaction: SignedReaction, post: SignedPost },
    CommentAttestation(CommentAttestation),
    ReactionAttestation(ReactionAttestation),
    /// Владелец поста делегирует публичные адресные ключи участника только
    /// тем, кому уже разрешено видеть его обсуждение. Не доказывает доступ.
    PeerDelegate(PeerDelegate),
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PeerDelegate {
    pub post: SignedPost,
    pub actor: social_model::Author,
    pub owner: social_delivery::RecipientKeyMaterial,
    pub encryption: social_delivery::RecipientKeyMaterial,
    pub ts: u64,
    pub sig: String,
}

/// Подтверждение подписано владельцем поста отдельным доменом. Нельзя
/// переиспользовать подпись автора комментария или подпись самого поста.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CommentAttestation {
    pub comment: SignedComment,
    pub post: SignedPost,
    pub ts: u64,
    pub sig: String,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReactionAttestation {
    pub reaction: SignedReaction,
    pub post: SignedPost,
    pub ts: u64,
    pub sig: String,
}

pub fn envelope_json(payload: &DiscussionPayload) -> Result<String, DiscussionError> {
    serde_json::to_string(payload).map_err(|e| DiscussionError::Canonical(e.to_string()))
}

pub fn parse_envelope_json(plaintext: &str) -> Result<DiscussionPayload, DiscussionError> {
    let payload: DiscussionPayload = serde_json::from_str(plaintext)
        .map_err(|e| DiscussionError::Canonical(format!("discussion envelope: {e}")))?;
    let valid = match &payload {
        DiscussionPayload::SocialComment(signed) => verify_comment(signed),
        DiscussionPayload::SocialReaction(signed) => verify_reaction(signed),
        DiscussionPayload::CommentSubmission { comment, post } => {
            verify_comment(comment) && valid_submission_post(post, &comment.comment.target)
        }
        DiscussionPayload::ReactionSubmission { reaction, post } => {
            verify_reaction(reaction) && valid_submission_post(post, &reaction.reaction.target)
        }
        DiscussionPayload::CommentAttestation(attested) => verify_comment_attestation(attested),
        DiscussionPayload::ReactionAttestation(attested) => verify_reaction_attestation(attested),
        DiscussionPayload::PeerDelegate(delegated) => verify_peer_delegate(delegated),
    };
    if !valid { return Err(DiscussionError::InvalidSignature); }
    Ok(payload)
}

fn valid_submission_post(post: &SignedPost, target: &DiscussionTarget) -> bool {
    social_post::verify_post(post)
        && post.post.author.fp.same(&target.post_author)
        && post.post.audience == target.audience
        && PostRef::from_post(&post.post).is_ok_and(|id| id == target.post_id)
}

pub const COMMENT_ATTESTATION_DOMAIN: &[u8] = b"sfera-comment-attestation:v1\0";
pub const REACTION_ATTESTATION_DOMAIN: &[u8] = b"sfera-reaction-attestation:v1\0";

#[derive(serde::Serialize)]
struct AttestationBody<'a, T> { event: &'a T, post: &'a SignedPost, ts: u64 }

pub fn attest_comment(
    seed_hex: &str, comment: SignedComment, post: SignedPost, ts: u64,
) -> Result<CommentAttestation, DiscussionError> {
    if !verify_comment(&comment) || !valid_submission_post(&post, &comment.comment.target) {
        return Err(DiscussionError::InvalidSignature);
    }
    let body = AttestationBody { event: &comment, post: &post, ts };
    let sig = signing::sign_with_domain(COMMENT_ATTESTATION_DOMAIN, seed_hex, &body)
        .map_err(DiscussionError::Sign)?;
    Ok(CommentAttestation { comment, post, ts, sig })
}

pub fn attest_reaction(
    seed_hex: &str, reaction: SignedReaction, post: SignedPost, ts: u64,
) -> Result<ReactionAttestation, DiscussionError> {
    if !verify_reaction(&reaction) || !valid_submission_post(&post, &reaction.reaction.target) {
        return Err(DiscussionError::InvalidSignature);
    }
    let body = AttestationBody { event: &reaction, post: &post, ts };
    let sig = signing::sign_with_domain(REACTION_ATTESTATION_DOMAIN, seed_hex, &body)
        .map_err(DiscussionError::Sign)?;
    Ok(ReactionAttestation { reaction, post, ts, sig })
}

pub fn verify_comment_attestation(attested: &CommentAttestation) -> bool {
    valid_submission_post(&attested.post, &attested.comment.comment.target)
        && verify_comment(&attested.comment)
        && signing::verify_with_domain(
            COMMENT_ATTESTATION_DOMAIN,
            &AttestationBody { event: &attested.comment, post: &attested.post, ts: attested.ts },
            &attested.post.post.author, &attested.sig,
        )
}

pub fn verify_reaction_attestation(attested: &ReactionAttestation) -> bool {
    valid_submission_post(&attested.post, &attested.reaction.reaction.target)
        && verify_reaction(&attested.reaction)
        && signing::verify_with_domain(
            REACTION_ATTESTATION_DOMAIN,
            &AttestationBody { event: &attested.reaction, post: &attested.post, ts: attested.ts },
            &attested.post.post.author, &attested.sig,
        )
}

pub const PEER_DELEGATE_DOMAIN: &[u8] = b"sfera-peer-delegate:v1\0";

pub fn delegate_peer(
    seed_hex: &str, post: SignedPost, actor: social_model::Author,
    encryption: social_delivery::RecipientKeyMaterial, ts: u64,
    owner: social_delivery::RecipientKeyMaterial,
) -> Result<PeerDelegate, DiscussionError> {
    if !social_post::verify_post(&post)
        || actor.fp != encryption.fp
        || actor.pub_key.trim().is_empty()
        || encryption.address.trim().is_empty()
        || encryption.x25519_public_hex.trim().is_empty()
        || encryption.pq_ek_b64.trim().is_empty()
        || owner.fp != post.post.author.fp
        || owner.address.trim().is_empty()
        || owner.x25519_public_hex.trim().is_empty()
        || owner.pq_ek_b64.trim().is_empty()
    {
        return Err(DiscussionError::DeliveryUnavailable("delegate material is incomplete".into()));
    }
    let unsigned = PeerDelegate { post, actor, owner, encryption, ts, sig: String::new() };
    let sig = signing::sign_with_domain(PEER_DELEGATE_DOMAIN, seed_hex, &unsigned)
        .map_err(DiscussionError::Sign)?;
    Ok(PeerDelegate { sig, ..unsigned })
}

pub fn verify_peer_delegate(delegated: &PeerDelegate) -> bool {
    social_post::verify_post(&delegated.post)
        && delegated.actor.fp == delegated.encryption.fp
        && delegated.owner.fp == delegated.post.post.author.fp
        && !delegated.owner.address.trim().is_empty()
        && !delegated.owner.x25519_public_hex.trim().is_empty()
        && !delegated.owner.pq_ek_b64.trim().is_empty()
        && !delegated.encryption.address.trim().is_empty()
        && !delegated.encryption.x25519_public_hex.trim().is_empty()
        && !delegated.encryption.pq_ek_b64.trim().is_empty()
        && signing::verify_with_domain(
            PEER_DELEGATE_DOMAIN,
            &PeerDelegate { sig: String::new(), ..delegated.clone() },
            &delegated.post.post.author,
            &delegated.sig,
        )
}

pub fn publication_id(payload: &DiscussionPayload, recipient: &Fingerprint) -> Result<String, DiscussionError> {
    let canonical = match payload {
        DiscussionPayload::SocialComment(signed) => social_model::canonical::canonical_bytes(&signed.comment),
        DiscussionPayload::SocialReaction(signed) => social_model::canonical::canonical_bytes(&signed.reaction),
        DiscussionPayload::CommentSubmission { comment, .. } => social_model::canonical::canonical_bytes(comment),
        DiscussionPayload::ReactionSubmission { reaction, .. } => social_model::canonical::canonical_bytes(reaction),
        DiscussionPayload::CommentAttestation(attested) => social_model::canonical::canonical_bytes(attested),
        DiscussionPayload::ReactionAttestation(attested) => social_model::canonical::canonical_bytes(attested),
        DiscussionPayload::PeerDelegate(delegated) => social_model::canonical::canonical_bytes(delegated),
    }.map_err(DiscussionError::Canonical)?;
    let mut hasher = Sha256::new();
    hasher.update(ENVELOPE_DOMAIN);
    // Разные назначения одного исходного события не должны схлопываться в
    // один outbox item (submission владельцу ≠ attestation аудитории).
    // Явный стабильный домен назначения, а не сериализация discriminant:
    // wire-ID не должен меняться от внутреннего представления Rust enum.
    hasher.update(match payload {
        DiscussionPayload::SocialComment(_) => b"social-comment".as_slice(),
        DiscussionPayload::SocialReaction(_) => b"social-reaction".as_slice(),
        DiscussionPayload::CommentSubmission { .. } => b"comment-submission".as_slice(),
        DiscussionPayload::ReactionSubmission { .. } => b"reaction-submission".as_slice(),
        DiscussionPayload::CommentAttestation(_) => b"comment-attestation".as_slice(),
        DiscussionPayload::ReactionAttestation(_) => b"reaction-attestation".as_slice(),
        DiscussionPayload::PeerDelegate(_) => b"peer-delegate".as_slice(),
    });
    hasher.update(canonical);
    hasher.update(recipient.as_str().as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

/// Хеш подписанной формы поста. Не зависит от `social-feed`: событие можно
/// проверить и отправить до прибытия самого поста (pending).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PostRef([u8; 32]);

impl PostRef {
    pub fn from_post(post: &social_post::PostV1) -> Result<Self, DiscussionError> {
        let canonical = social_post::canonical_post(post).map_err(DiscussionError::Canonical)?;
        Ok(Self(Sha256::digest(canonical).into()))
    }

    pub fn to_hex(self) -> String { hex::encode(self.0) }
}

impl fmt::Display for PostRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.to_hex()) }
}

impl fmt::Debug for PostRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "PostRef({self})") }
}

impl FromStr for PostRef {
    type Err = DiscussionError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = hex::decode(s.trim()).map_err(|_| DiscussionError::BadId("post id is not hex".into()))?;
        Ok(Self(raw.try_into().map_err(|_| DiscussionError::BadId("post id must be 32 bytes".into()))?))
    }
}

impl serde::Serialize for PostRef {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> { s.serialize_str(&self.to_hex()) }
}

impl<'de> serde::Deserialize<'de> for PostRef {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::from_str(&String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

/// Ссылка на конкретный пост и его автора. Аудитория подписывается вместе с
/// событием: получатель не может расширить её молча при пересылке.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiscussionTarget {
    pub post_id: PostRef,
    pub post_author: Fingerprint,
    pub audience: PostAudience,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CommentV1 {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    /// Стабильный случайный идентификатор, 32 байта hex. Не хеш текста:
    /// два одинаковых комментария остаются разными событиями.
    pub id: String,
    pub target: DiscussionTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub author: Author,
    pub ts: u64,
    pub body: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<MediaRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SignedComment {
    pub comment: CommentV1,
    pub sig: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReactionV1 {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub target: DiscussionTarget,
    pub author: Author,
    /// Небольшой набор Unicode-emoji, не HTML и не произвольная строка.
    pub emoji: String,
    /// При удалении тип сохраняется в `removed_emoji`, чтобы tombstone
    /// заменил именно прежнюю реакцию, а не создал новую пустую запись.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_emoji: Option<String>,
    /// Монотонная версия от автора к посту. Большая версия заменяет старую,
    /// равная — только детерминированный tie-break или дубликат.
    pub version: u64,
    /// Пустая строка = снять реакцию. Tombstone необходим, иначе удаление
    /// нельзя распространить как подписанное событие.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SignedReaction {
    pub reaction: ReactionV1,
    pub sig: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscussionError {
    InvalidVersion(u8),
    InvalidKind(String),
    BadId(String),
    EmptyBody,
    BodyTooLong,
    EmptyEmoji,
    InvalidVersionOrder,
    BadAuthor(String),
    Sign(String),
    Canonical(String),
    InvalidSignature,
    NotInAudience,
    ParticipationDenied,
    UnknownPost,
    UnknownParent,
    DeliveryUnavailable(String),
    NotPostAuthor,
    AttestationMismatch,
}

impl fmt::Display for DiscussionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVersion(v) => write!(f, "unsupported discussion version: {v}"),
            Self::InvalidKind(k) => write!(f, "unsupported discussion type: {k}"),
            Self::BadId(m) => f.write_str(m),
            Self::EmptyBody => f.write_str("comment must contain text or media"),
            Self::BodyTooLong => write!(f, "comment exceeds {MAX_COMMENT_CHARS} chars"),
            Self::EmptyEmoji => f.write_str("reaction emoji is empty"),
            Self::InvalidVersionOrder => f.write_str("reaction version must be positive"),
            Self::BadAuthor(m) => f.write_str(m),
            Self::Sign(m) => write!(f, "sign failed: {m}"),
            Self::Canonical(m) => write!(f, "canonical discussion failed: {m}"),
            Self::InvalidSignature => f.write_str("discussion signature is invalid"),
            Self::NotInAudience => f.write_str("discussion author is outside the post audience"),
            Self::ParticipationDenied => f.write_str("discussion is not permitted for this role"),
            Self::UnknownPost => f.write_str("discussion post is not available"),
            Self::UnknownParent => f.write_str("parent comment is not available"),
            Self::DeliveryUnavailable(m) => write!(f, "discussion delivery unavailable: {m}"),
            Self::NotPostAuthor => f.write_str("only the original post author may attest a discussion"),
            Self::AttestationMismatch => f.write_str("attested post does not match the local post"),
        }
    }
}

impl std::error::Error for DiscussionError {}

fn id_is_hex32(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

impl CommentV1 {
    pub fn new(
        id: impl Into<String>, target: DiscussionTarget, parent_id: Option<String>,
        author: Author, ts: u64, body: impl Into<String>, media: Vec<MediaRef>,
    ) -> Result<Self, DiscussionError> {
        let comment = Self {
            v: FORMAT_VERSION, kind: COMMENT_KIND.into(), id: id.into(), target,
            parent_id, author, ts, body: body.into(), media,
        };
        comment.validate()?;
        Ok(comment)
    }

    pub fn validate(&self) -> Result<(), DiscussionError> {
        if self.v != FORMAT_VERSION { return Err(DiscussionError::InvalidVersion(self.v)); }
        if self.kind != COMMENT_KIND { return Err(DiscussionError::InvalidKind(self.kind.clone())); }
        if !id_is_hex32(&self.id) { return Err(DiscussionError::BadId("comment id must be 32 bytes hex".into())); }
        if self.parent_id.as_ref().is_some_and(|id| !id_is_hex32(id)) {
            return Err(DiscussionError::BadId("parent comment id must be 32 bytes hex".into()));
        }
        if self.parent_id.as_ref() == Some(&self.id) {
            return Err(DiscussionError::BadId("comment cannot reply to itself".into()));
        }
        if self.body.trim().is_empty() && self.media.is_empty() { return Err(DiscussionError::EmptyBody); }
        if self.body.chars().count() > MAX_COMMENT_CHARS { return Err(DiscussionError::BodyTooLong); }
        if self.target.audience.id.trim().is_empty() || self.target.audience.epoch == 0 {
            return Err(DiscussionError::BadId("invalid target audience".into()));
        }
        Ok(())
    }
}

pub fn new_comment_id() -> Result<String, DiscussionError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| DiscussionError::Canonical(format!("comment id entropy: {e}")))?;
    Ok(hex::encode(bytes))
}

pub fn sign_comment(seed_hex: &str, comment: &CommentV1) -> Result<SignedComment, DiscussionError> {
    comment.validate()?;
    let sig = signing::sign_with_domain(COMMENT_DOMAIN, seed_hex, comment).map_err(DiscussionError::Sign)?;
    Ok(SignedComment { comment: comment.clone(), sig })
}

pub fn compose_comment(
    seed_hex: &str, id: &str, target: DiscussionTarget, parent_id: Option<String>,
    ts: u64, body: &str, media: Vec<MediaRef>,
) -> Result<SignedComment, DiscussionError> {
    let author = Author::from_public_key_hex(&signing::public_key_hex(seed_hex).map_err(DiscussionError::BadAuthor)?)
        .map_err(DiscussionError::BadAuthor)?;
    sign_comment(seed_hex, &CommentV1::new(id, target, parent_id, author, ts, body, media)?)
}

pub fn verify_comment(signed: &SignedComment) -> bool {
    signed.comment.validate().is_ok() && signing::verify_with_domain(
        COMMENT_DOMAIN, &signed.comment, &signed.comment.author, &signed.sig,
    )
}

impl ReactionV1 {
    pub fn validate(&self) -> Result<(), DiscussionError> {
        if self.v != FORMAT_VERSION { return Err(DiscussionError::InvalidVersion(self.v)); }
        if self.kind != REACTION_KIND { return Err(DiscussionError::InvalidKind(self.kind.clone())); }
        if self.version == 0 { return Err(DiscussionError::InvalidVersionOrder); }
        if self.removed != Some(true) && self.emoji.is_empty() { return Err(DiscussionError::EmptyEmoji); }
        if self.removed == Some(true) && self.removed_emoji.as_deref().unwrap_or("").is_empty() {
            return Err(DiscussionError::BadId("reaction tombstone must name the removed emoji".into()));
        }
        let emoji = if self.removed == Some(true) { self.removed_emoji.as_deref().unwrap_or("") } else { &self.emoji };
        let count = emoji.chars().count();
        if !(1..=16).contains(&count) || emoji.chars().any(char::is_control) {
            return Err(DiscussionError::EmptyEmoji);
        }
        Ok(())
    }
}

pub fn sign_reaction(seed_hex: &str, reaction: &ReactionV1) -> Result<SignedReaction, DiscussionError> {
    reaction.validate()?;
    let sig = signing::sign_with_domain(REACTION_DOMAIN, seed_hex, reaction).map_err(DiscussionError::Sign)?;
    Ok(SignedReaction { reaction: reaction.clone(), sig })
}

pub fn compose_reaction(
    seed_hex: &str, target: DiscussionTarget, emoji: &str, version: u64, removed: bool,
) -> Result<SignedReaction, DiscussionError> {
    let author = Author::from_public_key_hex(&signing::public_key_hex(seed_hex).map_err(DiscussionError::BadAuthor)?)
        .map_err(DiscussionError::BadAuthor)?;
    sign_reaction(seed_hex, &ReactionV1 {
        v: FORMAT_VERSION, kind: REACTION_KIND.into(), target, author,
        emoji: if removed { String::new() } else { emoji.into() }, version,
        removed_emoji: removed.then(|| emoji.into()),
        removed: removed.then_some(true),
    })
}

pub fn verify_reaction(signed: &SignedReaction) -> bool {
    signed.reaction.validate().is_ok() && signing::verify_with_domain(
        REACTION_DOMAIN, &signed.reaction, &signed.reaction.author, &signed.sig,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventOutcome { Inserted, Updated, Duplicate, Stale }

/// Локальные данные обсуждения. Входной фильтр прав находится снаружи: этот
/// тип не утверждает, что принятый автор имеет доступ к аудитории.
#[derive(Clone, Debug, Default)]
pub struct DiscussionBook {
    comments: BTreeMap<String, SignedComment>,
    reactions: BTreeMap<(String, String, String), SignedReaction>,
}

impl DiscussionBook {
    pub fn new() -> Self { Self::default() }

    pub fn insert_comment(&mut self, signed: SignedComment) -> Result<EventOutcome, DiscussionError> {
        if !verify_comment(&signed) { return Err(DiscussionError::InvalidSignature); }
        if let Some(parent) = &signed.comment.parent_id {
            let Some(parent) = self.comments.get(parent) else {
                return Err(DiscussionError::UnknownParent);
            };
            if parent.comment.target != signed.comment.target {
                return Err(DiscussionError::UnknownParent);
            }
        }
        if self.comments.contains_key(&signed.comment.id) {
            if self.comments.get(&signed.comment.id) != Some(&signed) {
                return Err(DiscussionError::BadId("comment id is already bound to another event".into()));
            }
            return Ok(EventOutcome::Duplicate);
        }
        self.comments.insert(signed.comment.id.clone(), signed);
        Ok(EventOutcome::Inserted)
    }

    pub fn insert_reaction(&mut self, signed: SignedReaction) -> Result<EventOutcome, DiscussionError> {
        if !verify_reaction(&signed) { return Err(DiscussionError::InvalidSignature); }
        let key = (
            signed.reaction.target.post_id.to_hex(),
            signed.reaction.author.fp.as_str().to_string(),
            signed.reaction.removed_emoji.clone().unwrap_or_else(|| signed.reaction.emoji.clone()),
        );
        let Some(existing) = self.reactions.get(&key) else {
            self.reactions.insert(key, signed);
            return Ok(EventOutcome::Inserted);
        };
        if existing == &signed { return Ok(EventOutcome::Duplicate); }
        let incoming = social_model::canonical::canonical_bytes(&signed.reaction).map_err(DiscussionError::Canonical)?;
        let stored = social_model::canonical::canonical_bytes(&existing.reaction).map_err(DiscussionError::Canonical)?;
        if signed.reaction.version < existing.reaction.version
            || (signed.reaction.version == existing.reaction.version && incoming <= stored)
        {
            return Ok(EventOutcome::Stale);
        }
        self.reactions.insert(key, signed);
        Ok(EventOutcome::Updated)
    }

    pub fn next_reaction_version(
        &self,
        target: &DiscussionTarget,
        author: &Fingerprint,
        emoji: &str,
    ) -> u64 {
        self.reactions.values()
            .filter(|r| r.reaction.target.post_id == target.post_id
                && r.reaction.author.fp.same(author)
                && (r.reaction.emoji == emoji || r.reaction.removed_emoji.as_deref() == Some(emoji)))
            .map(|r| r.reaction.version)
            .max().unwrap_or(0).saturating_add(1)
    }

    pub fn comments_for(&self, post_id: &PostRef) -> Vec<&SignedComment> {
        let mut out: Vec<_> = self.comments.values()
            .filter(|c| c.comment.target.post_id == *post_id).collect();
        out.sort_by(|a, b| a.comment.ts.cmp(&b.comment.ts).then_with(|| a.comment.id.cmp(&b.comment.id)));
        out
    }

    pub fn reactions_for(&self, post_id: &PostRef) -> Vec<&SignedReaction> {
        self.reactions.values().filter(|r| {
            r.reaction.target.post_id == *post_id && r.reaction.removed != Some(true)
        }).collect()
    }

    pub fn snapshot_comments(&self) -> Vec<SignedComment> { self.comments.values().cloned().collect() }
    pub fn snapshot_reactions(&self) -> Vec<SignedReaction> { self.reactions.values().cloned().collect() }
}
