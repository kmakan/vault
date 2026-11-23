//! Vault Sfera: загрузка медиа (ADR-006 §5, §7.1).
//!
//! Файл шифруется до записи: провайдер видит только шифротекст `VAULTBLOB1`.
//! Ключ файла НЕ пишется в хранилище — он возвращается вызывающему, чтобы
//! ушёл получателю внутри E2E-конверта. `BlobId` = SHA-256 шифротекста.
//!
//! Никакой классификации MIME в UI: `social-media-kind` решает тип в Rust.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use social_media::{
    encrypt_blob, encrypt_thumbnail, generate_file_key, generate_nonce_prefix, thumb_key,
    DEFAULT_CHUNK_SIZE,
};
use social_media_kind::MediaKind;
use social_manifest::{BlobEntry, BlobKey, Manifest, ManifestError};
use storage_api::{BlobId, BlobStore, Locator, StorageError};

pub mod thumb;

/// Миниатюра, записанная отдельным блобом. Ключ не хранится: он выводится
/// из ключа файла (`social_media::thumb_key`).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThumbResult {
    pub blob_id: String,
    pub content_id: String,
    pub mime: String,
    /// Размер шифрованного блоба миниатюры.
    pub size: u64,
    pub store_id: String,
    pub uri: String,
}

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
    /// Маленький JPEG для галереи/ленты; `None` — не изображение или битый
    /// файл. Отсутствие миниатюры не мешает открыть полный файл.
    #[serde(default)]
    pub thumb: Option<ThumbResult>,
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

/// Зашифровать и записать файл. Адаптер уже выбран вызывающим через
/// `storage-factory`; идентификатор хранилища берём из `Locator`, который
/// вернул сам адаптер, — иначе DTO и манифест разойдутся с реальной локацией
/// (например, `Local` вместо `local`) и файл не откроется по этому адресу.
pub async fn upload_encrypted(
    store: &dyn BlobStore,
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

    // Миниатюра — отдельный блоб со своим ключом (HKDF от ключа файла).
    // Её отсутствие не ошибка: картинка может быть битой или не image/*.
    let thumb = match thumb::make_thumbnail(plaintext, mime) {
        Some(bytes) => {
            let encrypted_thumb = encrypt_thumbnail(&bytes, &file_key)
                .map_err(|e| StorageError::Backend(format!("thumb encrypt: {e}")))?;
            let thumb_size = encrypted_thumb.bytes.len() as u64;
            let thumb_id = BlobId::from_bytes(Sha256::digest(&encrypted_thumb.bytes).into());
            let thumb_loc = store
                .put(
                    &thumb_id,
                    Box::new(std::io::Cursor::new(encrypted_thumb.bytes)),
                    thumb_size,
                )
                .await?;
            Some(ThumbResult {
                blob_id: thumb_id.to_hex(),
                content_id: encrypted_thumb.blob_id.to_hex(),
                mime: "image/jpeg".into(),
                size: thumb_size,
                store_id: thumb_loc.store_id.clone(),
                uri: thumb_loc.uri,
            })
        }
        None => None,
    };

    Ok(UploadResult {
        blob_id: storage_id.to_hex(),
        content_id: encrypted.blob_id.to_hex(),
        file_key_hex: hex::encode(file_key),
        nonce_prefix_hex: hex::encode(nonce_prefix),
        mime: mime.to_string(),
        kind: social_media_kind::classify(mime),
        size,
        store_id: loc.store_id.clone(),
        uri: loc.uri,
        thumb,
    })
}

/// Собрать E2E-манифест из результата загрузки. Ключ файла едет внутри
/// манифеста (который сам шифруется ключом аудитории), а не в посте и не в
/// хранилище (ADR-006 §5.2, §7.1).
///
/// `blob_id` в ключе должен совпадать с локатором: это адрес хранилища.
/// `content_id` из VAULTBLOB1 проверяется отдельно при расшифровке.
pub fn build_manifest(post_id: &str, uploaded: &UploadResult) -> Result<Manifest, ManifestError> {
    let blob_id = BlobId::from_bytes(
        hex::decode(&uploaded.blob_id)
            .map_err(|_| ManifestError::BlobMismatch)?
            .try_into()
            .map_err(|_| ManifestError::BlobMismatch)?,
    );
    let entry = BlobEntry {
        key: BlobKey { blob_id, key_hex: uploaded.file_key_hex.clone() },
        locators: vec![Locator {
            store_id: uploaded.store_id.clone(),
            uri: uploaded.uri.clone(),
            blob_id,
        }],
        mime: uploaded.mime.clone(),
        size: uploaded.size,
    };
    let mut entries = vec![entry];
    // Миниатюра — отдельный блоб; получателю нужен её ключ (HKDF от ключа
    // файла) и локатор. Ключ едет в манифесте, как и ключ основного файла.
    if let Some(t) = &uploaded.thumb {
        let thumb_blob_id = BlobId::from_bytes(
            hex::decode(&t.blob_id)
                .map_err(|_| ManifestError::BlobMismatch)?
                .try_into()
                .map_err(|_| ManifestError::BlobMismatch)?,
        );
        let file_key: [u8; 32] = hex::decode(&uploaded.file_key_hex)
            .map_err(|_| ManifestError::BlobMismatch)?
            .try_into()
            .map_err(|_| ManifestError::BlobMismatch)?;
        entries.push(BlobEntry {
            key: BlobKey {
                blob_id: thumb_blob_id,
                key_hex: hex::encode(thumb_key(&file_key)),
            },
            locators: vec![Locator {
                store_id: t.store_id.clone(),
                uri: t.uri.clone(),
                blob_id: thumb_blob_id,
            }],
            mime: t.mime.clone(),
            size: t.size,
        });
    }
    let manifest = Manifest::new(post_id, entries);
    manifest.validate()?;
    Ok(manifest)
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
        let r = upload_encrypted(&store, "image/jpeg", plaintext).await.unwrap();

        assert_eq!(r.kind, MediaKind::Image);
        assert_eq!(r.blob_id.len(), 64);
        assert_eq!(r.content_id.len(), 64);
        assert_ne!(r.blob_id, r.content_id, "хеш файла и хеш содержимого разные");
        assert_eq!(r.file_key_hex.len(), 64);
        assert_eq!(r.size, plaintext.len() as u64 + 71 + 16); // header + tag
        // id хранилища — из Locator адаптера, а не из UI-подписи.
        assert_eq!(r.store_id, "local");

        let bytes = std::fs::read(&r.uri).unwrap();
        assert!(bytes.starts_with(b"VAULTBLOB1"));
        assert!(!windows(&bytes, plaintext), "plaintext не должен попасть в хранилище");
    }

    fn windows(haystack: &[u8], needle: &[u8]) -> bool {
        if needle.is_empty() || needle.len() > haystack.len() { return false; }
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[tokio::test]
    async fn manifest_carries_key_and_matches_locator() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path()).unwrap();
        let r = upload_encrypted(&store, "video/mp4", b"video bytes")
            .await.unwrap();
        let m = build_manifest("post-1", &r).unwrap();
        assert_eq!(m.post_id, "post-1");
        assert_eq!(m.entries.len(), 1);
        let e = &m.entries[0];
        assert_eq!(e.key.key_hex, r.file_key_hex);
        assert_eq!(e.locators[0].blob_id, e.key.blob_id);
        assert_eq!(e.mime, "video/mp4");
        // Ключ в сериализованном манифесте есть — но сам манифест едет в E2E.
        assert!(serde_json::to_string(&m).unwrap().contains(&r.file_key_hex));
    }

    #[test]
    fn debug_hides_file_key() {
        let r = UploadResult {
            blob_id: "ab".repeat(32), content_id: "cd".repeat(32),
            file_key_hex: "cd".repeat(32),
            nonce_prefix_hex: "ef".repeat(16), mime: "video/mp4".into(),
            kind: MediaKind::Video, size: 123, store_id: "device".into(), uri: "/x".into(),
            thumb: None,
        };
        let dbg = format!("{r:?}");
        assert!(!dbg.contains(&"cd".repeat(32)));
        assert!(dbg.contains("<redacted>"));
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder;
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([10, 90, 200]));
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    #[tokio::test]
    async fn image_upload_creates_encrypted_thumbnail_and_manifest_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path()).unwrap();
        let src = png(1200, 800);
        let r = upload_encrypted(&store, "image/png", &src).await.unwrap();
        let thumb = r.thumb.as_ref().expect("thumbnail for a real image");
        assert_eq!(thumb.mime, "image/jpeg");
        assert_ne!(thumb.blob_id, r.blob_id);

        let cipher = std::fs::read(&thumb.uri).unwrap();
        assert!(cipher.starts_with(b"VAULTBLOB1"));
        let file_key: [u8; 32] = hex::decode(&r.file_key_hex).unwrap().try_into().unwrap();
        let plain = social_media::decrypt_thumbnail(&cipher, &file_key).unwrap();
        assert_eq!(&plain[..2], &[0xFF, 0xD8], "миниатюра — JPEG");

        let m = build_manifest("post-1", &r).unwrap();
        assert_eq!(m.entries.len(), 2, "файл + миниатюра");
        let entry = m
            .entries
            .iter()
            .find(|e| e.key.blob_id.to_hex() == thumb.blob_id)
            .expect("thumb entry");
        assert_eq!(entry.key.key_hex, hex::encode(thumb_key(&file_key)));
    }
}
