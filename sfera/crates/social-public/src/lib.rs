//! HTTP-витрина публичных каналов.
//!
//! Слой не знает ключей и не расшифровывает ничего: он читает проверенные
//! `PublicFeed` с диска и отдаёт их по HTTP-подобному контракту
//! `(method, path) -> (status, content_type, body)`. Такой контракт можно
//! подключить к любому серверу (axum/hyper/nginx-прокси) без дублирования
//! проверки подписей.
//!
//! Эндпоинты:
//! - `GET /health`
//! - `GET /sfera/public/channels`
//! - `GET /sfera/public/channels/{id}[?limit=N]`
//!
//! Всё остальное — 404, не-GET — 405.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use serde::Serialize;
use social_paid::{is_valid_channel_id, PublicFeed, PublicFeedError, PUBLIC_FEED_MAX_POSTS};
use social_post::SignedPost;

pub mod server;

/// Корень витрины: здесь лежат `<channel-id>.json`.
pub const PUBLIC_ROOT: &str = "sfera/public/channels";
pub const PUBLIC_PREFIX: &str = "/sfera/public/channels";
pub const MAX_LIMIT: usize = 200;

#[derive(Debug)]
pub struct PublicCatalog {
    root: PathBuf,
    feeds: BTreeMap<String, PublicFeed>,
    max_posts: usize,
}

impl PublicCatalog {
    /// Загрузить все витрины из каталога. Каждый файл проверяется целиком
    /// (`PublicFeed::load_from`), имя файла обязано совпадать с id канала.
    /// Нет каталога — пустая витрина.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, CatalogError> {
        Self::open_with_limit(root, PUBLIC_FEED_MAX_POSTS)
    }

    /// Открыть каталог с ограничением размера одной витрины. Для upload это
    /// защита от неограниченного роста тела; чтение использует лимит ядра.
    pub fn open_with_limit(root: impl Into<PathBuf>, max_posts: usize) -> Result<Self, CatalogError> {
        let root = root.into();
        let mut feeds = BTreeMap::new();
        if !root.exists() {
            return Ok(Self { root, feeds, max_posts });
        }
        let entries = std::fs::read_dir(&root).map_err(|e| CatalogError::Io(e.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|e| CatalogError::Io(e.to_string()))?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| CatalogError::BadName(path.display().to_string()))?;
            if !is_valid_channel_id(stem) {
                return Err(CatalogError::BadName(stem.to_string()));
            }
            let feed = PublicFeed::load_from(&path)
                .map_err(CatalogError::Feed)?
                .ok_or_else(|| CatalogError::BadName(path.display().to_string()))?;
            if feed.channel.id != stem {
                return Err(CatalogError::Mismatch {
                    file: stem.to_string(),
                    id: feed.channel.id.clone(),
                });
            }
            if feed.posts.len() > max_posts {
                return Err(CatalogError::TooLarge(max_posts));
            }
            feeds.insert(stem.to_string(), feed);
        }
        Ok(Self { root, feeds, max_posts })
    }

    pub fn get(&self, id: &str) -> Option<&PublicFeed> {
        self.feeds.get(id)
    }

    pub fn len(&self) -> usize {
        self.feeds.len()
    }

    pub fn is_empty(&self) -> bool {
        self.feeds.is_empty()
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.feeds.keys().map(String::as_str)
    }

    /// Добавить пост в витрину своего канала. Если запись на диск не удалась,
    /// память откатывается: витрина не должна расходиться с файлом.
    pub fn publish(&mut self, post: SignedPost) -> Result<bool, CatalogError> {
        let id = post.post.audience.id.clone();
        if !is_valid_channel_id(&id) {
            return Err(CatalogError::BadId(id));
        }
        let path = self.path_for(&id);
        let feed = self
            .feeds
            .get_mut(&id)
            .ok_or_else(|| CatalogError::UnknownChannel(id.clone()))?;
        let before = feed.posts.len();
        let added = feed.publish(post).map_err(CatalogError::Feed)?;
        if added {
            if feed.posts.len() > self.max_posts {
                feed.posts.truncate(before);
                return Err(CatalogError::TooLarge(self.max_posts));
            }
            let updated = feed.clone();
            if let Err(e) = updated.save_to(&path) {
                feed.posts.truncate(before);
                return Err(CatalogError::Feed(e));
            }
            *feed = updated;
        }
        Ok(added)
    }

    /// HTTP-подобный обработчик. Возвращает статус, content-type и тело,
    /// чтобы его мог вызвать любой сервер без второй копии правил.
    #[must_use]
    pub fn handle(&self, method: &str, target: &str) -> PublicResponse {
        if method != "GET" {
            return PublicResponse::json(
                405,
                serde_json::json!({"error": "method_not_allowed"}),
            );
        }
        let (path, query) = match target.split_once('?') {
            Some((path, query)) => (path, query),
            None => (target, ""),
        };
        match path {
            "/health" => PublicResponse::json(
                200,
                serde_json::json!({"ok": true, "channels": self.len()}),
            ),
            PUBLIC_PREFIX => {
                let channels: Vec<ChannelSummary<'_>> = self
                    .feeds
                    .values()
                    .map(ChannelSummary::from_feed)
                    .collect();
                PublicResponse::json(200, serde_json::json!({"channels": channels}))
            }
            _ => {
                let Some(id) = path.strip_prefix(&format!("{PUBLIC_PREFIX}/")) else {
                    return PublicResponse::json(404, serde_json::json!({"error": "not_found"}));
                };
                if !is_valid_channel_id(id) {
                    return PublicResponse::json(404, serde_json::json!({"error": "not_found"}));
                }
                let Some(feed) = self.feeds.get(id) else {
                    return PublicResponse::json(404, serde_json::json!({"error": "not_found"}));
                };
                let body = match limit_from(query) {
                    Some(limit) => {
                        let mut view = feed.clone();
                        view.posts = feed.latest(limit).into_iter().cloned().collect();
                        serde_json::to_vec(&view)
                    }
                    None => serde_json::to_vec(feed),
                };
                match body {
                    Ok(body) => PublicResponse {
                        status: 200,
                        content_type: "application/json; charset=utf-8",
                        body,
                    },
                    Err(_) => {
                        PublicResponse::json(500, serde_json::json!({"error": "serialization"}))
                    }
                }
            }
        }
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SyncReport {
    pub channel: String,
    pub inserted: usize,
    pub duplicates: usize,
    pub posts: usize,
}

impl PublicCatalog {
    /// Слить авторский снимок в серверную витрину.
    ///
    /// Вход проверяется целиком до первой записи. Существующий канал можно
    /// дополнять только тем же создателем; серверные посты не удаляются даже
    /// если клиент прислал старый/неполный снимок. Повторная синхронизация
    /// того же файла идемпотентна.
    pub fn sync_feed(&mut self, incoming: PublicFeed, max_posts: usize) -> Result<SyncReport, CatalogError> {
        incoming.verify().map_err(CatalogError::Feed)?;
        let id = incoming.channel.id.clone();
        if !is_valid_channel_id(&id) {
            return Err(CatalogError::BadId(id));
        }
        if incoming.posts.len() > max_posts {
            return Err(CatalogError::TooLarge(max_posts));
        }
        let existing = self.feeds.get(&id);
        if let Some(existing) = existing {
            if !existing.channel.creator.fp.same(&incoming.channel.creator.fp) {
                return Err(CatalogError::CreatorMismatch);
            }
        }
        let mut merged = match existing {
            Some(existing) => existing.clone(),
            None => PublicFeed::new(incoming.channel.clone())
                .map_err(|error| CatalogError::Feed(social_paid::PublicFeedError::Channel(error)))?,
        };
        let previous_len = merged.posts.len();
        let mut inserted = 0usize;
        let mut duplicates = 0usize;
        for post in incoming.posts {
            if merged.publish(post).map_err(CatalogError::Feed)? {
                inserted += 1;
                if merged.posts.len() > max_posts {
                    return Err(CatalogError::TooLarge(max_posts));
                }
            } else {
                duplicates += 1;
            }
        }
        if inserted > 0 || existing.is_none() {
            merged.save_to(&self.path_for(&id)).map_err(CatalogError::Feed)?;
        }
        let posts = merged.posts.len();
        debug_assert!(posts >= previous_len);
        self.feeds.insert(id.clone(), merged);
        Ok(SyncReport { channel: id, inserted, duplicates, posts })
    }
}

#[derive(Serialize)]
struct ChannelSummary<'a> {
    id: &'a str,
    title: &'a str,
    creator_fp: &'a str,
    created_at: u64,
    posts: usize,
    latest_ts: Option<u64>,
}

impl<'a> ChannelSummary<'a> {
    fn from_feed(feed: &'a PublicFeed) -> Self {
        Self {
            id: &feed.channel.id,
            title: &feed.channel.title,
            creator_fp: feed.channel.creator.fp.as_str(),
            created_at: feed.channel.created_at,
            posts: feed.posts.len(),
            latest_ts: feed.posts.iter().map(|p| p.post.ts).max(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl PublicResponse {
    fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()),
        }
    }
}

#[derive(Debug)]
pub enum CatalogError {
    Io(String),
    Feed(PublicFeedError),
    BadName(String),
    BadId(String),
    Mismatch { file: String, id: String },
    UnknownChannel(String),
    TooLarge(usize),
    CreatorMismatch,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "catalog io: {e}"),
            Self::Feed(e) => write!(f, "catalog feed: {e}"),
            Self::BadName(name) => write!(f, "catalog file name is not a channel id: {name}"),
            Self::BadId(id) => write!(f, "catalog channel id is not a safe slug: {id}"),
            Self::Mismatch { file, id } => {
                write!(f, "catalog file {file}.json declares channel {id}")
            }
            Self::UnknownChannel(id) => write!(f, "catalog has no channel {id}"),
            Self::TooLarge(limit) => write!(f, "public feed exceeds {limit} posts"),
            Self::CreatorMismatch => f.write_str("public channel creator cannot be replaced"),
        }
    }
}

impl std::error::Error for CatalogError {}

impl From<PublicFeedError> for CatalogError {
    fn from(e: PublicFeedError) -> Self {
        Self::Feed(e)
    }
}

fn limit_from(query: &str) -> Option<usize> {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("limit="))
        .and_then(|value| value.parse::<usize>().ok())
        .map(|n| n.min(MAX_LIMIT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use social_paid::{PublicChannel, PublicFeed};
    use social_post::PostAudience;
    use social_rights::Audience;

    const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000001";

    fn channel() -> PublicChannel {
        PublicChannel::create("pub-1", SEED, "Публичный", "Описание", 100).unwrap()
    }

    fn post(ts: u64, body: &str) -> SignedPost {
        social_post::compose(
            SEED,
            ts,
            body,
            PostAudience {
                id: "pub-1".into(),
                epoch: 1,
                spec: Audience::Public,
            },
            vec![],
        )
        .unwrap()
    }

    fn seeded() -> (tempfile::TempDir, PublicCatalog) {
        let dir = tempfile::tempdir().unwrap();
        let mut feed = PublicFeed::new(channel()).unwrap();
        feed.publish(post(100, "первый")).unwrap();
        feed.publish(post(200, "второй")).unwrap();
        feed.save_to(&dir.path().join("pub-1.json")).unwrap();
        let catalog = PublicCatalog::open(dir.path()).unwrap();
        (dir, catalog)
    }

    #[test]
    fn loads_verifies_and_lists_channels() {
        let (_dir, catalog) = seeded();
        assert_eq!(catalog.len(), 1);
        assert!(catalog.get("pub-1").is_some());
        let body = catalog.handle("GET", "/sfera/public/channels");
        assert_eq!(body.status, 200);
        let text = String::from_utf8(body.body).unwrap();
        assert!(text.contains("\"id\":\"pub-1\""));
    }

    #[test]
    fn serves_detail_and_limit() {
        let (_dir, catalog) = seeded();
        let full = catalog.handle("GET", "/sfera/public/channels/pub-1");
        assert_eq!(full.status, 200);
        let full = String::from_utf8(full.body).unwrap();
        assert!(full.contains("первый") && full.contains("второй"));

        let one = catalog.handle("GET", "/sfera/public/channels/pub-1?limit=1");
        assert_eq!(one.status, 200);
        let one = String::from_utf8(one.body).unwrap();
        assert!(one.contains("второй"));
        assert!(!one.contains("первый"), "limit отдаёт только свежий пост");
    }

    #[test]
    fn health_404_and_method_contract() {
        let (_dir, catalog) = seeded();
        assert_eq!(catalog.handle("GET", "/health").status, 200);
        assert_eq!(
            catalog.handle("GET", "/sfera/public/channels/nope").status,
            404
        );
        assert_eq!(
            catalog.handle("GET", "/sfera/public/channels/../pub-1").status,
            404
        );
        assert_eq!(catalog.handle("POST", "/health").status, 405);
    }

    #[test]
    fn publish_persists_and_rejects_unknown_channel() {
        let (dir, mut catalog) = seeded();
        assert!(catalog.publish(post(300, "третий")).unwrap());
        assert!(!catalog.publish(post(300, "третий")).unwrap());

        let reopened = PublicCatalog::open(dir.path()).unwrap();
        assert_eq!(reopened.get("pub-1").unwrap().posts.len(), 3);

        let foreign = social_post::compose(
            SEED,
            400,
            "чужой",
            PostAudience {
                id: "nope".into(),
                epoch: 1,
                spec: Audience::Public,
            },
            vec![],
        )
        .unwrap();
        assert!(matches!(
            catalog.publish(foreign),
            Err(CatalogError::UnknownChannel(_))
        ));
    }

    #[test]
    fn rejects_file_name_that_does_not_match_channel() {
        let dir = tempfile::tempdir().unwrap();
        let feed = PublicFeed::new(channel()).unwrap();
        feed.save_to(&dir.path().join("other.json")).unwrap();
        assert!(matches!(
            PublicCatalog::open(dir.path()),
            Err(CatalogError::Mismatch { .. })
        ));
    }

    #[test]
    fn sync_merges_without_rollback_and_is_idempotent() {
        let (dir, mut catalog) = seeded();
        let mut incoming = PublicFeed::new(channel()).unwrap();
        incoming.publish(post(200, "второй")).unwrap();
        incoming.publish(post(300, "третий")).unwrap();
        let report = catalog.sync_feed(incoming.clone(), 1000).unwrap();
        assert_eq!(report.inserted, 1);
        assert_eq!(report.duplicates, 1);
        assert_eq!(report.posts, 3);

        let repeated = catalog.sync_feed(incoming, 1000).unwrap();
        assert_eq!(repeated.inserted, 0);
        assert_eq!(repeated.duplicates, 2);
        assert_eq!(repeated.posts, 3);

        let reopened = PublicCatalog::open(dir.path()).unwrap();
        assert_eq!(reopened.get("pub-1").unwrap().posts.len(), 3);
    }

    #[test]
    fn sync_rejects_foreign_creator_and_tampering_without_writing() {
        let (_dir, mut catalog) = seeded();
        let foreign = PublicFeed::new(
            PublicChannel::create("pub-1", "02".repeat(32).as_str(), "Чужой", "", 100).unwrap(),
        ).unwrap();
        assert!(matches!(catalog.sync_feed(foreign, 1000), Err(CatalogError::CreatorMismatch)));
        assert_eq!(catalog.get("pub-1").unwrap().channel.title, "Публичный");

        let mut incoming = PublicFeed::new(channel()).unwrap();
        incoming.publish(post(300, "подписанный")).unwrap();
        incoming.posts[0].post.body = "подмена".into();
        assert!(catalog.sync_feed(incoming, 1000).is_err());
        assert_eq!(catalog.get("pub-1").unwrap().posts.len(), 2);
    }

    #[test]
    fn sync_respects_post_limit() {
        let (_dir, mut catalog) = seeded();
        let mut incoming = PublicFeed::new(channel()).unwrap();
        incoming.publish(post(300, "лишний")).unwrap();
        assert!(matches!(catalog.sync_feed(incoming, 2), Err(CatalogError::TooLarge(2))));
        assert_eq!(catalog.get("pub-1").unwrap().posts.len(), 2);
    }
}
