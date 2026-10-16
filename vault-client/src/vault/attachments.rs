//! File attachment metadata store — перенос из JS send.js / attachments.js.
//!
//! Wire-формат EncryptedEnvelope (cli/commands/attachments.rs):
//!   ---BEGIN VAULT ENCRYPTED---
//!   Type: file
//!   Filename: secret.pdf
//!   Content-Type: application/pdf
//!   <base64 payload>
//!   ---END VAULT ENCRYPTED---
//!
//! Domain logic: store/retrieve attachment metadata (not file contents).
//! I/O (download/decrypt/write) — через Tauri cmd, как messages.rs.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Metadata for a sent/received attachment (VaultMessage.attachments[i]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentMeta {
    pub id: String,               // message_id + idx (envelope.canonical + ":0")
    pub msg_id: String,           // parent message_id
    pub filename: String,
    pub size: u64,                // bytes (original)
    pub mime_type: String,
    pub downloaded: bool,         // file cached locally
    pub local_path: Option<PathBuf>,
}

impl AttachmentMeta {
    pub fn new(msg_id: &str, idx: usize, filename: &str, size: u64, mime: &str) -> Self {
        Self {
            id: format!("{}:{}", msg_id, idx),
            msg_id: msg_id.to_string(),
            filename: filename.to_string(),
            size,
            mime_type: mime.to_string(),
            downloaded: false,
            local_path: None,
        }
    }

    /// Mark downloaded + set local path (called by Tauri download cmd).
    pub fn mark_downloaded(&mut self, path: PathBuf) {
        self.downloaded = true;
        self.local_path = Some(path);
    }
}

/// Attachment store: msg_id → Vec<AttachmentMeta>.
/// JSON persistence (~/.vault/attachments.json).
#[derive(Debug, Default, Clone)]
pub struct AttachmentStore {
    path: PathBuf,
    attachments: HashMap<String, Vec<AttachmentMeta>>,
}

impl AttachmentStore {
    pub fn new() -> Result<Self> {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".vault")
            .join("attachments.json");
        Self::with_path(path)
    }

    pub fn with_path(path: PathBuf) -> Result<Self> {
        let attachments = if path.exists() {
            let data = fs::read_to_string(&path).context("Failed to read attachments")?;
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self { path, attachments })
    }

    /// Save store to disk.
    pub fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.attachments)
            .context("Failed to serialize attachments")?;
        fs::write(&self.path, data).context("Failed to write attachments")?;
        Ok(())
    }

    /// Add attachment metadata (msg_id → attachments list).
    pub fn add(&mut self, meta: AttachmentMeta) {
        self.attachments
            .entry(meta.msg_id.clone())
            .or_default()
            .push(meta);
    }

    /// Get all attachments for a message.
    pub fn attachments_for(&self, msg_id: &str) -> &[AttachmentMeta] {
        self.attachments.get(msg_id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Mark an attachment as downloaded (lookup by id).
    pub fn mark_downloaded(&mut self, attachment_id: &str, path: PathBuf) -> bool {
        for (_msg_id, list) in self.attachments.iter_mut() {
            if let Some(att) = list.iter_mut().find(|a| a.id == attachment_id) {
                att.mark_downloaded(path);
                return true;
            }
        }
        false
    }

    /// Total size of all attachments.
    pub fn total_size(&self) -> u64 {
        self.attachments.values()
            .flatten()
            .map(|a| a.size)
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn temp_store() -> (AttachmentStore, PathBuf) {
        let dir = temp_dir().join(format!(
            "vault_attach_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("attachments.json");
        (AttachmentStore::with_path(path).unwrap(), dir)
    }

    #[test]
    fn test_add_and_retrieve() {
        let (mut store, dir) = temp_store();
        let meta = AttachmentMeta::new("msg1", 0, "hello.png", 1024, "image/png");
        store.add(meta.clone());
        store.save().unwrap();

        assert_eq!(store.attachments_for("msg1").len(), 1);
        assert_eq!(store.attachments_for("msg1")[0].filename, "hello.png");
        assert!(!store.attachments_for("msg1")[0].downloaded);
        assert_eq!(store.attachments_for("unknown").len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mark_downloaded() {
        let (mut store, dir) = temp_store();
        store.add(AttachmentMeta::new("m1", 0, "a.bin", 512, "application/octet-stream"));
        assert!(store.mark_downloaded("m1:0", PathBuf::from("/tmp/a.bin")));
        assert!(store.attachments_for("m1")[0].downloaded);
        assert!(!store.mark_downloaded("notfound", PathBuf::from("/x")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_persistence() {
        let (mut store, dir) = temp_store();
        store.add(AttachmentMeta::new("msg1", 0, "f.txt", 100, "text/plain"));
        store.save().unwrap();

        let path = store.path.clone();
        let store2 = AttachmentStore::with_path(path).unwrap();
        assert_eq!(store2.attachments_for("msg1").len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_total_size() {
        let (mut store, dir) = temp_store();
        store.add(AttachmentMeta::new("m1", 0, "a", 1024, "text/plain"));
        store.add(AttachmentMeta::new("m1", 1, "b", 2048, "image/png"));
        assert_eq!(store.total_size(), 3072);
        let _ = fs::remove_dir_all(&dir);
    }
}

