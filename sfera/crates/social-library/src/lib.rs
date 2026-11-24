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
use std::str::FromStr;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use social_media_kind::MediaKind;
use storage_api::{BlobId, BlobStore, Locator, Range};
use tokio::io::AsyncReadExt;

pub const FILE: &str = "media_library.json";

/// Потолок для полной расшифровки в UI: большие файлы открываются через
/// Range/стриминг, а не загружаются целиком в память окна.
pub const MAX_OPEN_BYTES: u64 = 64 * 1024 * 1024;
/// Потолок на один Range-ответ: несколько чанков, но не весь файл в память.
pub const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;

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
    /// Миниатюра, если она была сделана при загрузке. Ключ не хранится:
    /// он выводится из ключа файла.
    #[serde(default)]
    pub thumb: Option<ThumbRef>,
}

/// Локация миниатюры в хранилище. Секретов нет: ключ выводится из ключа файла.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThumbRef {
    pub blob_id: String,
    pub store_id: String,
    pub uri: String,
    /// Размер шифрованного блоба миниатюры.
    pub size: u64,
}

/// DTO для UI: без ключа и без локального пути.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryItem {
    pub blob_id: String,
    pub mime: String,
    pub kind: MediaKind,
    pub size: u64,
    pub added_at: u64,
    /// Есть ли готовая миниатюра (ключ и локатор остаются в Rust).
    pub thumb_blob_id: Option<String>,
}

impl From<&LibraryEntry> for LibraryItem {
    fn from(e: &LibraryEntry) -> Self {
        Self {
            blob_id: e.blob_id.clone(),
            mime: e.mime.clone(),
            kind: e.kind,
            size: e.size,
            added_at: e.added_at,
            thumb_blob_id: e.thumb.as_ref().map(|t| t.blob_id.clone()),
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
        thumb: uploaded.thumb.as_ref().map(|t| ThumbRef {
            blob_id: t.blob_id.clone(),
            store_id: t.store_id.clone(),
            uri: t.uri.clone(),
            size: t.size,
        }),
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

/// Расшифрованный свой файл для просмотра в UI. `bytes` — plaintext,
/// поэтому `Debug` печатает только размер, а не содержимое.
pub struct Opened {
    pub blob_id: String,
    pub mime: String,
    pub kind: MediaKind,
    pub size: u64,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Opened")
            .field("blob_id", &self.blob_id)
            .field("mime", &self.mime)
            .field("size", &self.size)
            .finish()
    }
}

fn entry_at(keys_dir: &Path, blob_id: &str) -> Result<Option<LibraryEntry>> {
    Ok(load_at(keys_dir)?.into_iter().find(|e| e.blob_id == blob_id))
}

fn file_key(entry: &LibraryEntry) -> Result<[u8; 32]> {
    hex::decode(&entry.file_key_hex)
        .context("file key is not hex")?
        .try_into()
        .map_err(|_| anyhow!("file key must be 32 bytes"))
}

fn locator(entry: &LibraryEntry) -> Result<Locator> {
    Ok(Locator {
        store_id: entry.store_id.clone(),
        uri: entry.uri.clone(),
        blob_id: BlobId::from_str(&entry.blob_id).map_err(|e| anyhow!("bad blob id: {e}"))?,
    })
}

/// Прочитать и расшифровать свой файл для предпросмотра. Ключ не покидает
/// Rust; в UI уходит результат, который интерфейс только показывает.
pub async fn open_at(
    keys_dir: &Path,
    store: &dyn BlobStore,
    blob_id: &str,
) -> Result<Option<Opened>> {
    let Some(entry) = entry_at(keys_dir, blob_id)? else {
        return Ok(None);
    };
    if entry.size > MAX_OPEN_BYTES {
        return Err(anyhow!(
            "file is too large to open in UI: {} bytes (max {MAX_OPEN_BYTES})",
            entry.size
        ));
    }
    let key = file_key(&entry)?;
    let loc = locator(&entry)?;
    let mut reader = store.get(&loc, None).await.context("read blob")?;
    let mut cipher = Vec::new();
    reader.read_to_end(&mut cipher).await.context("read blob body")?;
    let bytes = social_media::decrypt_blob(&cipher, &key).context("decrypt blob")?;
    Ok(Some(Opened {
        blob_id: entry.blob_id,
        mime: entry.mime,
        kind: entry.kind,
        size: bytes.len() as u64,
        bytes,
    }))
}

/// Расшифрованный диапазон своего файла. `start`/`end` — фактические границы
/// после клампа; `size` — полная длина plaintext. Ключ и шифротекст наружу не
/// попадают, `Debug` печатает только размеры.
pub struct OpenedRange {
    pub blob_id: String,
    pub mime: String,
    pub size: u64,
    pub start: u64,
    pub end: u64,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for OpenedRange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenedRange")
            .field("blob_id", &self.blob_id)
            .field("mime", &self.mime)
            .field("size", &self.size)
            .field("start", &self.start)
            .field("end", &self.end)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

/// Прочитать из `BlobStore` только нужные чанки и вернуть plaintext
/// полуоткрытого диапазона `[start, end)`. В отличие от [`open_at`], не
/// загружает весь файл — фундамент для Range-стриминга аудио/видео.
pub async fn open_range_at(
    keys_dir: &Path,
    store: &dyn BlobStore,
    blob_id: &str,
    range: Range,
) -> Result<Option<OpenedRange>> {
    let Some(entry) = entry_at(keys_dir, blob_id)? else {
        return Ok(None);
    };
    let key = file_key(&entry)?;
    let loc = locator(&entry)?;

    // Заголовок читается отдельным запросом: 71 байт вместо всего блоба.
    let head_range = Range::new(0, Some(social_media::HEADER_LEN as u64))
        .context("bad header range")?;
    let mut reader = store.get(&loc, Some(head_range)).await.context("read blob header")?;
    let mut head = Vec::with_capacity(social_media::HEADER_LEN);
    reader.read_to_end(&mut head).await.context("read header bytes")?;
    let header = social_media::parse_header_prefix(&head).context("parse blob header")?;

    let total = header.total;
    let start = range.start.min(total);
    let end = range.end.unwrap_or(total).min(total);
    if end <= start {
        return Ok(Some(OpenedRange {
            blob_id: entry.blob_id,
            mime: entry.mime,
            size: total,
            start,
            end: start,
            bytes: Vec::new(),
        }));
    }
    if end - start > MAX_RANGE_BYTES {
        return Err(anyhow!(
            "range too large: {} bytes (max {MAX_RANGE_BYTES})",
            end - start
        ));
    }

    let cipher = social_media::cipher_range_for(&header, start, end)
        .context("compute cipher range")?;
    let cipher_range = Range::new(cipher.start as u64, Some(cipher.end as u64))
        .context("bad cipher range")?;
    let mut reader = store.get(&loc, Some(cipher_range)).await.context("read blob range")?;
    let mut bytes = Vec::with_capacity(cipher.end - cipher.start);
    reader.read_to_end(&mut bytes).await.context("read cipher bytes")?;

    let first = start / header.chunk_size as u64;
    let last = (end - 1) / header.chunk_size as u64;
    let mut out = Vec::with_capacity((end - start) as usize);
    for i in first..=last {
        let pt = social_media::decrypt_chunk_from(
            &bytes,
            cipher.start as u64,
            &header,
            &key,
            i,
        )
        .context("decrypt range chunk")?;
        let chunk_start = i * header.chunk_size as u64;
        let local_start = start.saturating_sub(chunk_start) as usize;
        let local_end = (end.min(chunk_start + pt.len() as u64) - chunk_start) as usize;
        if local_start < local_end {
            out.extend_from_slice(&pt[local_start..local_end]);
        }
    }
    Ok(Some(OpenedRange {
        blob_id: entry.blob_id,
        mime: entry.mime,
        size: total,
        start,
        end,
        bytes: out,
    }))
}

/// Прочитать и расшифровать миниатюру своего файла. `None` — миниатюры нет
/// (не изображение или файл загружен до её появления). `blob_id` в результате —
/// основной блоб: по нему UI связывает превью с записью каталога.
pub async fn open_thumb_at(
    keys_dir: &Path,
    store: &dyn BlobStore,
    blob_id: &str,
) -> Result<Option<Opened>> {
    let Some(entry) = entry_at(keys_dir, blob_id)? else {
        return Ok(None);
    };
    let Some(thumb) = entry.thumb.as_ref() else {
        return Ok(None);
    };
    let key = file_key(&entry)?;
    let loc = Locator {
        store_id: thumb.store_id.clone(),
        uri: thumb.uri.clone(),
        blob_id: BlobId::from_str(&thumb.blob_id).map_err(|e| anyhow!("bad thumb id: {e}"))?,
    };
    let mut reader = store.get(&loc, None).await.context("read thumb")?;
    let mut cipher = Vec::new();
    reader.read_to_end(&mut cipher).await.context("read thumb body")?;
    let bytes = social_media::decrypt_thumbnail(&cipher, &key).context("decrypt thumb")?;
    Ok(Some(Opened {
        blob_id: entry.blob_id,
        mime: "image/jpeg".into(),
        kind: MediaKind::Image,
        size: bytes.len() as u64,
        bytes,
    }))
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
            thumb: None,
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

    #[tokio::test]
    async fn open_returns_plaintext_and_keeps_key_inside() {
        let dir = tempfile::tempdir().unwrap();
        let store = storage_local::LocalStore::new(dir.path().join("blobs")).unwrap();
        let plaintext = b"real photo bytes";
        let up = social_upload::upload_encrypted(&store, "image/png", plaintext)
            .await
            .unwrap();
        remember_at(dir.path(), &up, 5).unwrap();

        let opened = open_at(dir.path(), &store, &up.blob_id).await.unwrap().unwrap();
        assert_eq!(opened.bytes, plaintext);
        assert_eq!(opened.mime, "image/png");
        assert_eq!(opened.kind, MediaKind::Image);
        assert_eq!(opened.size, plaintext.len() as u64);
        // Debug расшифрованного файла не печатает содержимое.
        assert!(!format!("{opened:?}").contains("real photo"));
    }

    #[tokio::test]
    async fn range_open_reads_only_needed_chunks_and_clamps() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let store = storage_local::LocalStore::new(dir.path().join("blobs")).unwrap();
        let key = [0x11; 32];
        let nonce = [0x22; 16];
        let plaintext: Vec<u8> = (0..25u32).map(|i| (i % 251) as u8).collect();
        let enc = social_media::encrypt_blob(&plaintext, &key, &nonce, 8).unwrap();
        // Идентификатор хранилища — SHA-256 шифротекста, а не content_id из заголовка.
        let storage_id = BlobId::from_bytes(Sha256::digest(&enc.bytes).into());
        let loc = store
            .put(
                &storage_id,
                Box::new(std::io::Cursor::new(enc.bytes.clone())),
                enc.bytes.len() as u64,
            )
            .await
            .unwrap();

        let mut up = uploaded("r", "video/mp4");
        up.blob_id = storage_id.to_hex();
        up.file_key_hex = hex::encode(key);
        up.nonce_prefix_hex = hex::encode(nonce);
        up.size = plaintext.len() as u64;
        up.store_id = loc.store_id;
        up.uri = loc.uri;
        remember_at(dir.path(), &up, 1).unwrap();

        // Диапазон через границы чанков.
        let mid = open_range_at(
            dir.path(), &store, &up.blob_id, Range::new(5, Some(19)).unwrap(),
        ).await.unwrap().unwrap();
        assert_eq!(mid.bytes, plaintext[5..19]);
        assert_eq!((mid.start, mid.end, mid.size), (5, 19, 25));
        assert!(!format!("{mid:?}").contains(&hex::encode(key)), "ключ не должен попадать в Debug");

        // Кламп к концу и открытый конец.
        let tail = open_range_at(
            dir.path(), &store, &up.blob_id, Range::new(20, Some(1000)).unwrap(),
        ).await.unwrap().unwrap();
        assert_eq!(tail.bytes, plaintext[20..25]);
        assert_eq!((tail.start, tail.end), (20, 25));
        let rest = open_range_at(
            dir.path(), &store, &up.blob_id, Range::new(22, None).unwrap(),
        ).await.unwrap().unwrap();
        assert_eq!(rest.bytes, plaintext[22..]);

        // За пределами блоба — пустой диапазон, без ошибки.
        let past = open_range_at(
            dir.path(), &store, &up.blob_id, Range::new(100, Some(200)).unwrap(),
        ).await.unwrap().unwrap();
        assert!(past.bytes.is_empty());
        assert_eq!(past.start, past.end);

        // Неизвестный блоб — None.
        assert!(open_range_at(
            dir.path(), &store, &"0".repeat(64), Range::new(0, Some(1)).unwrap(),
        ).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn open_unknown_blob_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = storage_local::LocalStore::new(dir.path()).unwrap();
        assert!(open_at(dir.path(), &store, &"0".repeat(64)).await.unwrap().is_none());
        assert!(open_thumb_at(dir.path(), &store, &"0".repeat(64)).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn open_thumb_returns_jpeg_for_image() {
        use image::ImageEncoder;
        let dir = tempfile::tempdir().unwrap();
        let store = storage_local::LocalStore::new(dir.path().join("blobs")).unwrap();
        let img = image::RgbImage::from_pixel(800, 600, image::Rgb([10, 20, 30]));
        let mut src = Vec::new();
        image::codecs::png::PngEncoder::new(&mut src)
            .write_image(img.as_raw(), 800, 600, image::ExtendedColorType::Rgb8)
            .unwrap();

        let up = social_upload::upload_encrypted(&store, "image/png", &src)
            .await
            .unwrap();
        assert!(up.thumb.is_some(), "у изображения есть миниатюра");
        remember_at(dir.path(), &up, 1).unwrap();

        let opened = open_thumb_at(dir.path(), &store, &up.blob_id)
            .await
            .unwrap()
            .expect("thumb");
        assert_eq!(opened.mime, "image/jpeg");
        assert_eq!(opened.kind, MediaKind::Image);
        assert_eq!(&opened.bytes[..2], &[0xFF, 0xD8]);
        assert_eq!(opened.blob_id, up.blob_id, "превью связано с основным блобом");

        let item = items_at(dir.path()).unwrap();
        assert_eq!(item[0].thumb_blob_id, up.thumb.map(|t| t.blob_id));
    }

    #[tokio::test]
    async fn open_thumb_without_thumbnail_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = storage_local::LocalStore::new(dir.path()).unwrap();
        remember_at(dir.path(), &uploaded("a", "video/mp4"), 1).unwrap();
        assert!(open_thumb_at(dir.path(), &store, &"a".repeat(32)).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn oversized_file_is_rejected_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let store = storage_local::LocalStore::new(dir.path()).unwrap();
        let mut big = uploaded("a", "video/mp4");
        big.size = MAX_OPEN_BYTES + 1;
        remember_at(dir.path(), &big, 1).unwrap();
        let err = open_at(dir.path(), &store, &big.blob_id).await.unwrap_err();
        assert!(err.to_string().contains("too large"));
    }
    #[test]
    fn avatar_manifest_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 10).unwrap();
        let m = remember_avatar_at(dir.path(), &"a".repeat(32), 30).unwrap();
        assert_eq!(m.blob_id, "a".repeat(32));
        assert_eq!(m.set_at, 30);
        let read = avatar_at(dir.path()).unwrap().expect("манифест есть");
        assert_eq!(read.blob_id, m.blob_id);
        assert_eq!(read.file_key_hex, m.file_key_hex);
    }

    #[test]
    fn avatar_requires_own_blob() {
        // Аватаром нельзя объявить блоб, которого нет в своём каталоге:
        // иначе профиль сошлётся на чужой файл, и получатель не откроет его.
        let dir = tempfile::tempdir().unwrap();
        assert!(remember_avatar_at(dir.path(), &"f".repeat(32), 10).is_err());
        assert!(avatar_at(dir.path()).unwrap().is_none());
    }
}

// --- Манифест аватара (ADR-006 §7.6) --------------------------------------
//
// Профиль ссылается на аватар как на блоб (`AvatarRef`), но по одному
// `blob_id` нельзя ни открыть файл, ни переслать его получателю: нужен ключ,
// локатор и миниатюра. Манифест хранит это ОТДЕЛЬНО от каталога: каталог —
// «что я загрузил», манифест — «какой из этого мой аватар». Так профиль не
// зависит от того, что человек удалил из библиотеки.

/// Имя файла манифеста аватара в каталоге ключей.
pub const AVATAR_FILE: &str = "avatar_manifest.json";

/// Манифест аватара: то, что нужно, чтобы отдать аватар получателю.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AvatarManifest {
    pub blob_id: String,
    pub content_id: String,
    pub file_key_hex: String,
    pub nonce_prefix_hex: String,
    pub mime: String,
    pub size: u64,
    pub store_id: String,
    pub uri: String,
    /// Миниатюра, если сделана при загрузке.
    #[serde(default)]
    pub thumb: Option<ThumbRef>,
    /// Когда аватар поставлен (для «новее побеждает» на стороне получателя).
    pub set_at: u64,
}

impl std::fmt::Debug for AvatarManifest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AvatarManifest")
            .field("blob_id", &self.blob_id)
            .field("file_key_hex", &"<redacted>")
            .field("mime", &self.mime)
            .field("size", &self.size)
            .field("set_at", &self.set_at)
            .finish()
    }
}

fn avatar_path(keys_dir: &Path) -> PathBuf {
    keys_dir.join(AVATAR_FILE)
}

/// Запомнить аватар. Требует, чтобы блоб был СВОИМ: аватаром нельзя объявить
/// файл, которого нет в каталоге, — иначе профиль сошлётся на чужой блоб.
pub fn remember_avatar_at(keys_dir: &Path, blob_id: &str, now: u64) -> Result<AvatarManifest> {
    let entries = load_at(keys_dir)?;
    let entry = entries
        .iter()
        .find(|e| e.blob_id == blob_id)
        .ok_or_else(|| anyhow!("blob {blob_id} is not in the media library"))?;
    let manifest = AvatarManifest {
        blob_id: entry.blob_id.clone(),
        content_id: entry.content_id.clone(),
        file_key_hex: entry.file_key_hex.clone(),
        nonce_prefix_hex: entry.nonce_prefix_hex.clone(),
        mime: entry.mime.clone(),
        size: entry.size,
        store_id: entry.store_id.clone(),
        uri: entry.uri.clone(),
        thumb: entry.thumb.clone(),
        set_at: now,
    };
    write_avatar_at(keys_dir, &manifest)?;
    Ok(manifest)
}

/// Прочитать манифест аватара. `None` — аватар не задан (это нормально).
pub fn avatar_at(keys_dir: &Path) -> Result<Option<AvatarManifest>> {
    let path = avatar_path(keys_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    let manifest: AvatarManifest =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(manifest))
}

/// Записать манифест атомарно и с правами 0600: в нём ключ файла.
pub fn write_avatar_at(keys_dir: &Path, manifest: &AvatarManifest) -> Result<()> {
    std::fs::create_dir_all(keys_dir)
        .with_context(|| format!("create {}", keys_dir.display()))?;
    let path = avatar_path(keys_dir);
    let body = serde_json::to_string_pretty(manifest).context("serialize avatar manifest")?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(body.as_bytes())
            .with_context(|| format!("write {}", tmp.display()))?;
        f.sync_all().with_context(|| format!("sync {}", tmp.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&tmp, perms)?;
    }
    std::fs::rename(&tmp, &path).with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

/// Снять аватар: профиль останется без аватара, блоб в библиотеке не трогаем.
pub fn forget_avatar_at(keys_dir: &Path) -> Result<bool> {
    let path = avatar_path(keys_dir);
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod avatar_tests {
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
            thumb: None,
        }
    }

    #[test]
    fn avatar_manifest_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 10).unwrap();
        let m = remember_avatar_at(dir.path(), &"a".repeat(32), 30).unwrap();
        assert_eq!(m.blob_id, "a".repeat(32));
        assert_eq!(m.set_at, 30);
        let read = avatar_at(dir.path()).unwrap().expect("манифест есть");
        assert_eq!(read.blob_id, m.blob_id);
        assert_eq!(read.file_key_hex, m.file_key_hex);
    }

    #[test]
    fn avatar_requires_own_blob() {
        // Аватаром нельзя объявить блоб, которого нет в своём каталоге:
        // иначе профиль сошлётся на чужой файл, и получатель не откроет его.
        let dir = tempfile::tempdir().unwrap();
        assert!(remember_avatar_at(dir.path(), &"f".repeat(32), 10).is_err());
        assert!(avatar_at(dir.path()).unwrap().is_none());
    }

    #[test]
    fn avatar_absent_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(avatar_at(dir.path()).unwrap().is_none());
        assert!(!forget_avatar_at(dir.path()).unwrap(), "снимать нечего");
    }

    #[test]
    fn avatar_debug_hides_file_key() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 10).unwrap();
        let m = remember_avatar_at(dir.path(), &"a".repeat(32), 30).unwrap();
        let dbg = format!("{m:?}");
        assert!(dbg.contains("<redacted>"), "{dbg}");
        assert!(!dbg.contains(&m.file_key_hex), "ключ файла утёк в Debug");
    }

    #[test]
    fn forget_avatar_keeps_library_entry() {
        // Снятие аватара не удаляет файл из библиотеки: человек мог загрузить
        // картинку не только ради аватара.
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), &uploaded("a", "image/png"), 10).unwrap();
        remember_avatar_at(dir.path(), &"a".repeat(32), 30).unwrap();
        assert!(forget_avatar_at(dir.path()).unwrap());
        assert_eq!(items_at(dir.path()).unwrap().len(), 1, "файл остался в каталоге");
        assert!(avatar_at(dir.path()).unwrap().is_none());
    }
}
