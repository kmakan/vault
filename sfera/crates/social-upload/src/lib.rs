//! Vault Sfera: загрузка медиа (ADR-006 §5, §7.1).
//!
//! Файл шифруется до записи: провайдер видит только шифротекст `VAULTBLOB1`.
//! Ключ файла НЕ пишется в хранилище — он возвращается вызывающему, чтобы
//! ушёл получателю внутри E2E-конверта. `BlobId` = SHA-256 шифротекста.
//!
//! Никакой классификации MIME в UI: `social-media-kind` решает тип в Rust.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use social_media::{encrypt_blob, generate_file_key, generate_nonce_prefix, DEFAULT_CHUNK_SIZE};
use social_media_kind::MediaKind;
use storage_api::{BlobId, BlobStore, Locator, StorageError};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadResult {
    /// hex SHA-256 всего файла — адрес для провайдера. Адаптеры проверяют
    /// именно его (storage-api §BlobStore).
    pub blob_id: String,
    /// hex SHA-256 шифротекста из заголовка VAULTBLOB1: целостность содержимого
    /// проверяется social_media::verify_integrity, а не хешем файла.
    pub content_id: String,
    /// Секретный ключ файла: caller обязан положить его в E2E-конверт.
    pub file_key_hex: String,
    pub nonce_prefix_hex: String,
    pub mime: String,
    pub kind: MediaKind,
    pub size: u64,
    pub store_id: String,
    pub uri: String,
}

impl std::fmt::Debug for UploadResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadResult")
            .field("blob_id", &self.blob_id)
            .field("file_key_hex", &"<redacted>")
            .field("mime", &self.mime)
            .field("size", &self.size)
            .finish()
    }
}

/// Зашифровать и записать файл. `store_id` нужен только для DTO: сам адаптер
/// уже выбран вызывающим через `storage-factory`.
pub async fn upload_encrypted(
    store: &dyn BlobStore,
    store_id: &str,
    mime: &str,
    plaintext: &[u8],
) -> Result<UploadResult, StorageError> {
    let file_key = generate_file_key();
    let nonce_prefix = generate_nonce_prefix();
    let encrypted = encrypt_blob(plaintext, &file_key, &nonce_prefix, DEFAULT_CHUNK_SIZE)
        .map_err(|e| StorageError::Backend(format!("encrypt: {e}")))?;

    let size = encrypted.bytes.len() as u64;
    let storage_id = BlobId::from_bytes(Sha256::digest(&encrypted.bytes).into());
    let reader = std::io::Cursor::new(encrypted.bytes);
    let loc: Locator = store
        .put(&storage_id, Box::new(reader), size)
        .await?;

    Ok(UploadResult {
        blob_id: storage_id.to_hex(),
        content_id: encrypted.blob_id.to_hex(),
        file_key_hex: hex::encode(file_key),
        nonce_prefix_hex: hex::encode(nonce_prefix),
        mime: mime.to_string(),
        kind: social_media_kind::classify(mime),
        size,
        store_id: store_id.to_string(),
        uri: loc.uri,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage_local::LocalStore;

    #[tokio::test]
    async fn upload_writes_ciphertext_not_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path()).unwrap();
        let plaintext = b"secret photo bytes";
        let r = upload_encrypted(&store, "device", "image/jpeg", plaintext).await.unwrap();

        assert_eq!(r.kind, MediaKind::Image);
        assert_eq!(r.blob_id.len(), 64);
        assert_eq!(r.content_id.len(), 64);
        assert_ne!(r.blob_id, r.content_id, "хеш файла и хеш содержимого разные");
        assert_eq!(r.file_key_hex.len(), 64);
        assert_eq!(r.size, plaintext.len() as u64 + 71 + 16); // header + tag

        let bytes = std::fs::read(&r.uri).unwrap();
        assert!(bytes.starts_with(b"VAULTBLOB1"));
        assert!(!windows(&bytes, plaintext), "plaintext не должен попасть в хранилище");
    }

    fn windows(haystack: &[u8], needle: &[u8]) -> bool {
        if needle.is_empty() || needle.len() > haystack.len() { return false; }
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn debug_hides_file_key() {
        let r = UploadResult {
            blob_id: "ab".repeat(32), content_id: "cd".repeat(32),
            file_key_hex: "cd".repeat(32),
            nonce_prefix_hex: "ef".repeat(16), mime: "video/mp4".into(),
            kind: MediaKind::Video, size: 123, store_id: "device".into(), uri: "/x".into(),
        };
        let dbg = format!("{r:?}");
        assert!(!dbg.contains(&"cd".repeat(32)));
        assert!(dbg.contains("<redacted>"));
    }
}
