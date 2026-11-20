//! Vault Sfera — локальная лента (ADR-006 §7).
//!
//! Лента хранит только посты с ВАЛИДНОЙ подписью, дедуплицирует по
//! `post_id = SHA-256(canonical_post)` и отдаёт детерминированный порядок:
//! `ts` по убыванию, при равенстве — `post_id` по возрастанию. Так два
//! устройства показывают одинаковую ленту, не договариваясь о времени
//! получения. Read-state — локальный.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::str::FromStr;

use sha2::{Digest, Sha256};
use social_post::{canonical_post, verify_post, PostV1, SignedPost};

/// Стабильный идентификатор поста: SHA-256 канонического JCS.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PostId([u8; 32]);

impl PostId {
    pub const LEN: usize = 32;

    /// `post_id = SHA-256(canonical_post(post))`.
    pub fn from_post(post: &PostV1) -> Result<Self, FeedError> {
        let canonical = canonical_post(post).map_err(FeedError::Canonical)?;
        Ok(Self(Sha256::digest(&canonical).into()))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl fmt::Display for PostId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for PostId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PostId({})", self.to_hex())
    }
}

impl FromStr for PostId {
    type Err = FeedError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = hex::decode(s.trim())
            .map_err(|_| FeedError::BadPostId("post id is not hex".into()))?;
        let bytes: [u8; 32] = raw.try_into().map_err(|_| {
            FeedError::BadPostId(format!("post id must be {} bytes", Self::LEN))
        })?;
        Ok(Self(bytes))
    }
}

impl serde::Serialize for PostId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> serde::Deserialize<'de> for PostId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(d)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Запись ленты: пост, его id и локальное время получения.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FeedEntry {
    pub id: PostId,
    pub post: SignedPost,
    pub received_at: u64,
}

impl FeedEntry {
    /// Проверить подпись и вычислить id. Невалидный пост в ленту не попадает.
    pub fn new(post: SignedPost, received_at: u64) -> Result<Self, FeedError> {
        if !verify_post(&post) {
            return Err(FeedError::InvalidSignature);
        }
        let id = PostId::from_post(&post.post)?;
        Ok(Self {
            id,
            post,
            received_at,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeedError {
    InvalidSignature,
    Canonical(String),
    BadPostId(String),
    /// При восстановлении id не совпал с хэшем поста.
    IdMismatch,
}

impl fmt::Display for FeedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSignature => f.write_str("post signature is invalid"),
            Self::Canonical(m) => write!(f, "canonical post failed: {m}"),
            Self::BadPostId(m) => write!(f, "invalid post id: {m}"),
            Self::IdMismatch => f.write_str("post id does not match post hash"),
        }
    }
}

impl std::error::Error for FeedError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertOutcome {
    Inserted(PostId),
    /// Такой пост уже есть; повторная доставка не создаёт дубль.
    Duplicate(PostId),
}

/// Локальная лента.
#[derive(Clone, Debug, Default)]
pub struct Feed {
    entries: BTreeMap<PostId, FeedEntry>,
    read: BTreeSet<PostId>,
}

impl Feed {
    pub fn new() -> Self {
        Self::default()
    }

    /// Принять пост. Подпись проверяется, дубликат не добавляется.
    pub fn insert(
        &mut self,
        post: SignedPost,
        received_at: u64,
    ) -> Result<InsertOutcome, FeedError> {
        let entry = FeedEntry::new(post, received_at)?;
        if self.entries.contains_key(&entry.id) {
            return Ok(InsertOutcome::Duplicate(entry.id));
        }
        let id = entry.id;
        self.entries.insert(id, entry);
        Ok(InsertOutcome::Inserted(id))
    }

    pub fn get(&self, id: &PostId) -> Option<&FeedEntry> {
        self.entries.get(id)
    }

    pub fn contains(&self, id: &PostId) -> bool {
        self.entries.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Детерминированный порядок: `ts` по убыванию, затем `post_id` по возрастанию.
    pub fn ordered(&self) -> Vec<&FeedEntry> {
        let mut out: Vec<&FeedEntry> = self.entries.values().collect();
        out.sort_by(|a, b| {
            b.post.post.ts
                .cmp(&a.post.post.ts)
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    /// Отметить прочитанным. `true` — если запись была непрочитанной.
    pub fn mark_read(&mut self, id: &PostId) -> bool {
        self.read.insert(*id)
    }

    pub fn is_read(&self, id: &PostId) -> bool {
        self.read.contains(id)
    }

    pub fn unread_count(&self) -> usize {
        self.entries
            .keys()
            .filter(|id| !self.read.contains(*id))
            .count()
    }

    pub fn remove(&mut self, id: &PostId) -> Option<FeedEntry> {
        self.read.remove(id);
        self.entries.remove(id)
    }

    /// Снимок для сохранения (порядок не важен — он восстанавливается).
    pub fn snapshot(&self) -> Vec<FeedEntry> {
        self.entries.values().cloned().collect()
    }

    pub fn read_ids(&self) -> Vec<PostId> {
        self.read.iter().copied().collect()
    }

    /// Восстановить read-state из сохранения.
    pub fn restore_read(&mut self, ids: impl IntoIterator<Item = PostId>) {
        self.read.extend(ids);
    }

    /// Восстановить ленту из сохранения: каждый пост перепроверяется, id
    /// пересчитывается (нельзя подсунуть чужой id к валидному посту).
    pub fn restore(entries: impl IntoIterator<Item = FeedEntry>) -> Result<Self, FeedError> {
        let mut feed = Feed::new();
        for entry in entries {
            if !verify_post(&entry.post) {
                return Err(FeedError::InvalidSignature);
            }
            let expected = PostId::from_post(&entry.post.post)?;
            if expected != entry.id {
                return Err(FeedError::IdMismatch);
            }
            feed.entries.insert(entry.id, entry);
        }
        Ok(feed)
    }
}
