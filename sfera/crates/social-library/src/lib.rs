//! Vault Sfera: локальный каталог своих медиа (ADR-006 §5.2, §7.1).
//!
//! Ключ файла уходит получателям в E2E-конверте, но автору нужен свой
//! повторный доступ к загруженному файлу. Каталог хранит только метаданные
//! и ключ: сам шифротекст лежит в `BlobStore`. Файл каталога — 0600,
//! запись атомарная; `Debug` не печатает ключ.
//!
//! Просмотр чужих файлов идёт через манифест из E2E-конверта, не через
//! этот реестр: здесь только то, что пользователь загрузил сам.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use social_media_kind::MediaKind;

pub const FILE: &str = "media_library.json";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryEntry {
    pub blob_id: String,
    pub content_id: String,
    pub file_key_hex: String,
    pub nonce_prefix_hex: String,
    pub mime: String,
    pub kind: MediaKind,
    pub size: u64,
    pub store_id: String,
    pub uri: String,
    pub added_at: u64,
}

/// DTO для UI: без ключа и без локального пути.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryItem {
    pub blob_id: String,
    pub mime: String,
    pub kind: MediaKind,
    pub size: u64,
    pub added_at: u64,
}

impl From<&LibraryEntry> for LibraryItem {
    fn from(e: &LibraryEntry) -> Self {
        Self {
            blob_id: e.blob_id.clone(),
            mime: e.mime.clone(),
            kind: e.kind,
            size: e.size,
            added_at: e.added_at,
        }
    }
}

impl std::fmt::Debug for LibraryEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibraryEntry")
            .field("blob_id", &self.blob_id)
            .field("file_key_hex", &"<redacted>")
            .field("mime", &self.mime)
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    v: u8,
    entries: Vec<LibraryEntry>,
}

fn path(keys_dir: &Path) -> PathBuf {
    keys_dir.join(FILE)
}

pub fn load_at(keys_dir: &Path) -> Result<Vec<LibraryEntry>> {
    let path = path(keys_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let doc: Stored = serde_json::from_str(
        &std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    if doc.v != 1 {
        return Err(anyhow!("{FILE}: unsupported version {}", doc.v));
    }
    for e in &doc.entries {
        if e.file_key_hex.len() != 64 || hex::decode(&e.file_key_hex).is_err() {
            return Err(anyhow!("{FILE}: bad file key for {}", e.blob_id));
        }
    }
    Ok(doc.entries)
}

fn write_at(keys_dir: &Path, entries: &[LibraryEntry]) -> Result<()> {
    let doc = Stored { v: 1, entries: entries.to_vec() };
    let body = serde_json::to_vec(&doc)?;
    std::fs::create_dir_all(keys_dir)?;
    let path = path(keys_dir);
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&tmp)
        .with_context(|| format!("create {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&body)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

/// Запомнить загруженный файл. Повторная загрузка того же blob_id обновляет
/// запись, а не создаёт дубль.
pub fn remember_at(keys_dir: &Path, uploaded: &social_upload::UploadResult, now: u64) -> Result<()> {
    let mut entries = load_at(keys_dir)?;
    entries.retain(|e| e.blob_id != uploaded.blob_id);
    entries.push(LibraryEntry {
        blob_id: uploaded.blob_id.clone(),
        content_id: uploaded.content_id.clone(),
        file_key_hex: uploaded.file_key_hex.clone(),
        nonce_prefix_hex: uploaded.nonce_prefix_hex.clone(),
        mime: uploaded.mime.clone(),
        kind: uploaded.kind,
        size: uploaded.size,
        store_id: uploaded.store_id.clone(),
        uri: uploaded.uri.clone(),
        added_at: now,
    });
    write_at(keys_dir, &entries)
}

/// Список для UI: newest first, без ключей.
pub fn items_at(keys_dir: &Path) -> Result<Vec<LibraryItem>> {
    let mut entries = load_at(keys_dir)?;
    entries.sort_by(|a, b| b.added_at.cmp(&a.added_at).then_with(|| a.blob_id.cmp(&b.blob_id)));
    Ok(entries.iter().map(LibraryItem::from).collect())
}

pub fn forget_at(keys_dir: &Path, blob_id: &str) -> Result<bool> {
    let mut entries = load_at(keys_dir)?;
    let before = entries.len();
    entries.retain(|e| e.blob_id != blob_id);
    if entries.len() == before {
        return Ok(false);
    }
    write_at(keys_dir, &entries)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uploaded(id: &str, mime: &str) -> social_upload::UploadResult {
        social_upload::UploadResult {
            blob_id: id.repeat(32),
            content_id: "b".repeat(32),
            file_key_hex: "cd".repeat(32),
            nonce_prefix_hex: "ef".repeat(16),
            mime: mime.into(),
            kind: social_media_kind::classify(mime),
            size: 42,
            store_id: "device".into(),
            uri: "/tmp/x.blob".into(),
        }
    }

    #[test]
    fn remember_list_and_forget() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 10).unwrap();
        remember_at(dir.path(), &uploaded("e", "video/mp4"), 20).unwrap();
        let items = items_at(dir.path()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].blob_id, "e".repeat(32), "newest first");
        assert_eq!(items[0].kind, MediaKind::Video);
        assert!(forget_at(dir.path(), &"a".repeat(32)).unwrap());
        assert_eq!(items_at(dir.path()).unwrap().len(), 1);
        assert!(!forget_at(dir.path(), &"a".repeat(32)).unwrap());
    }

    #[test]
    fn duplicate_upload_updates_entry() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 10).unwrap();
        remember_at(dir.path(), &uploaded("a", "image/jpeg"), 11).unwrap();
        let items = items_at(dir.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mime, "image/jpeg");
    }

    #[test]
    fn debug_hides_key() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 1).unwrap();
        let entries = load_at(dir.path()).unwrap();
        let dbg = format!("{:?}", entries[0]);
        assert!(!dbg.contains(&"cd".repeat(32)));
        assert!(dbg.contains("<redacted>"));
    }
}
