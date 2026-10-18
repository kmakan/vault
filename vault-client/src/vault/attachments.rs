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
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use vault_core::NONCE_LEN;

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

// ── Encrypted envelope (shared: CLI + Desktop) ──────────────────────────
//
// Wire-format (same ASCII-armored envelope that Encryptor::encrypt_file
// produces in vault-client/src/crypto/encryptor.rs):
//   ---BEGIN VAULT ENCRYPTED---
//   Version: 1
//   Type: file
//   Filename: secret.pdf
//   Content-Type: application/pdf
//   ---
//   <base64 payload>      — nonce(24) ‖ ciphertext ‖ enc_key(32)
//   <base64 signature>     — ed25519
//   ---END VAULT ENCRYPTED---

/// ASCII-armored Vault encrypted file envelope wrapper.
pub struct EncryptedEnvelope;

impl EncryptedEnvelope {
    const BEGIN_MARKER: &str = "---BEGIN VAULT ENCRYPTED---";
    const END_MARKER: &str = "---END VAULT ENCRYPTED---";

    /// Build a Vault encrypted envelope from an already-encrypted payload.
    pub fn build(
        filename: &str,
        content_type: &str,
        encrypted_payload_b64: &str,
        signature_b64: &str,
    ) -> String {
        format!(
            "{}\nVersion: 1\nType: file\nFilename: {}\nContent-Type: {}\n---\n{}\n{}\n{}\n",
            Self::BEGIN_MARKER,
            filename,
            content_type,
            encrypted_payload_b64,
            signature_b64,
            Self::END_MARKER,
        )
    }

    /// Parse an encrypted envelope and extract filename, content_type,
    /// payload_b64, and signature_b64.
    pub fn parse(envelope: &str) -> Result<EncryptedEnvelopeData> {
        let envelope = envelope.trim();
        let start = envelope
            .find(Self::BEGIN_MARKER)
            .context("Missing BEGIN marker")?;
        let end = envelope
            .find(Self::END_MARKER)
            .context("Missing END marker")?;
        let block = &envelope[start + Self::BEGIN_MARKER.len()..end];
        let block = block.trim();
        let sep_pos = block
            .find("---")
            .context("Missing header/body separator")?;
        let header = block[..sep_pos].trim();
        let body = block[sep_pos + 3..].trim();

        let mut version = None;
        let mut data_type = None;
        let mut filename = None;
        let mut content_type = None;
        for line in header.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("Version: ") {
                version = Some(v.trim().to_string());
            } else if let Some(t) = line.strip_prefix("Type: ") {
                data_type = Some(t.trim().to_string());
            } else if let Some(f) = line.strip_prefix("Filename: ") {
                filename = Some(f.trim().to_string());
            } else if let Some(ct) = line.strip_prefix("Content-Type: ") {
                content_type = Some(ct.trim().to_string());
            }
        }
        let _version = version.context("Missing Version in header")?;
        let type_str = data_type.context("Missing Type in header")?;
        if type_str != "file" {
            anyhow::bail!("Expected Type: file, got: {}", type_str);
        }
        let lines: Vec<&str> = body.lines().collect();
        if lines.len() < 2 {
            anyhow::bail!("Expected payload and signature in body");
        }
        Ok(EncryptedEnvelopeData {
            filename: filename.unwrap_or_else(|| "unknown".into()),
            content_type: content_type.unwrap_or_else(|| "application/octet-stream".into()),
            payload_b64: lines[0].trim().to_string(),
            signature_b64: lines[1].trim().to_string(),
        })
    }

    /// Check if a string looks like a Vault encrypted file envelope.
    pub fn is_file_envelope(input: &str) -> bool {
        input.contains(Self::BEGIN_MARKER)
            && input.contains(Self::END_MARKER)
            && input.contains("Type: file")
    }
}

/// Parsed data extracted from an encrypted envelope (shared type).
#[derive(Debug, Clone)]
pub struct EncryptedEnvelopeData {
    pub filename: String,
    pub content_type: String,
    pub payload_b64: String,
    pub signature_b64: String,
}

/// Download (parse + decrypt) an `EncryptedEnvelope` and write the original
/// file to disk.
///
/// This is the **shared unpacking path** used by both the CLI
/// (`attachment download <id>`) and the Desktop Tauri bridge
/// (`vault_download_attachment`).
///
/// The payload format is `nonce(24) ‖ ciphertext ‖ enc_key(32)` — the
/// ephemeral `enc_key` is embedded in the payload itself, so no peer/shared
/// key is required.  Signature verification is **skipped** because the
/// sender's ed25519 public key is not known to the recipient at download time.
///
/// # Arguments
/// - `envelope_text`  — full ASCII-armored envelope (`---BEGIN VAULT --- …`)
/// - `output_dir`     — directory to write into; defaults to `cwd`
/// - `output_name`    — override filename from envelope
///
/// # Returns
/// The path to the written file.
pub fn download_file(
    envelope_text: &str,
    output_dir: Option<&Path>,
    output_name: Option<&str>,
) -> Result<PathBuf> {
    let parsed = EncryptedEnvelope::parse(envelope_text)?;

    // Decode the base64 payload → nonce(24) ‖ ciphertext ‖ enc_key(32)
    let payload = BASE64
        .decode(&parsed.payload_b64)
        .context("Failed to decode payload base64")?;

    if payload.len() < NONCE_LEN + 16 + 32 {
        anyhow::bail!(
            "Encrypted payload too short (got {} bytes, need at least {})",
            payload.len(),
            NONCE_LEN + 16 + 32
        );
    }

    let enc_key_start = payload.len() - 32;
    let nonce = XNonce::from_slice(&payload[..NONCE_LEN]);
    let ciphertext = &payload[NONCE_LEN..enc_key_start];
    let enc_key: [u8; 32] = payload[enc_key_start..]
        .try_into()
        .map_err(|_| anyhow::anyhow!("Failed to extract encryption key from payload tail"))?;

    let cipher = XChaCha20Poly1305::new((&enc_key).into());
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| {
            anyhow::anyhow!("Decryption failed — corrupted data or wrong key: {}", e)
        })?;

    let filename = output_name
        .map(|n| n.to_string())
        .unwrap_or_else(|| parsed.filename.clone());

    let dir = match output_dir {
        Some(d) => d.to_path_buf(),
        None => std::env::current_dir()
            .context("Failed to determine current directory")?,
    };
    let out_path = dir.join(&filename);

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create output directory: {}", parent.display()))?;
    }
    fs::write(&out_path, &plaintext)
        .with_context(|| format!("Failed to write file: {}", out_path.display()))?;

    Ok(out_path)
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

    // ── EncryptedEnvelope + download_file (shared CLI / Desktop) ───────

    #[test]
    fn test_envelope_build_and_parse() {
        let envelope = EncryptedEnvelope::build(
            "secret.pdf",
            "application/pdf",
            "dGVzdHBheWxvYWQ=",
            "dGVzdHNpZ25hdHVyZQ==",
        );
        assert!(envelope.contains("---BEGIN VAULT ENCRYPTED---"));
        assert!(envelope.contains("Type: file"));
        assert!(envelope.contains("Filename: secret.pdf"));
        assert!(envelope.contains("Content-Type: application/pdf"));
        assert!(envelope.contains("---END VAULT ENCRYPTED---"));

        let parsed = EncryptedEnvelope::parse(&envelope).unwrap();
        assert_eq!(parsed.filename, "secret.pdf");
        assert_eq!(parsed.content_type, "application/pdf");
        assert_eq!(parsed.payload_b64, "dGVzdHBheWxvYWQ=");
        assert_eq!(parsed.signature_b64, "dGVzdHNpZ25hdHVyZQ==");
    }

    #[test]
    fn test_is_file_envelope() {
        let env = EncryptedEnvelope::build("doc.txt", "text/plain", "payload", "sig");
        assert!(EncryptedEnvelope::is_file_envelope(&env));
        assert!(!EncryptedEnvelope::is_file_envelope("not an envelope"));
    }

    #[test]
    fn test_parse_missing_begin() {
        let result = EncryptedEnvelope::parse("no markers here");
        assert!(result.is_err());
    }

    #[test]
    fn test_download_file_roundtrip() {
        // Use the Encryptor to produce a real encrypted envelope, then
        // decrypt it via the shared download_file function (no signature
        // verification — key is extracted from the payload).
        use crate::crypto::encryptor::Encryptor;
        let enc = Encryptor::new();
        let original = b"Hello, Vault attachment download!";

        // Write original to a temp file, encrypt it, then download_file
        // should recover the exact bytes.
        let dir = temp_dir().join(format!(
            "vault_dl_roundtrip_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let src = dir.join("original.txt");
        fs::write(&src, original).unwrap();

        let envelope = enc.encrypt_file(&src).unwrap();
        let _ = fs::remove_file(&src); // simulate "received as envelope only"

        let result = download_file(&envelope, Some(&dir), None);
        assert!(result.is_ok());
        let path = result.unwrap();
        let recovered = fs::read(&path).unwrap();
        assert_eq!(recovered, original);

        let _ = fs::remove_dir_all(&dir);
    }
}

