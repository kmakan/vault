//! Адаптер «папка устройства» — честный дефолт без настройки, работает офлайн
//! (ADR-006 §6, очередь 1). На Android тот же порт будет поверх SAF.

use std::io::{ErrorKind, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};
use storage_api::{
    BlobId, BlobStat, BlobStore, Locator, Range, StorageError, StoreCaps, StoreKind,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};

const STORE_ID: &str = "local";

/// Хранилище в каталоге: один блоб — один файл `<blob_id>.blob`.
/// Имя файла выводится ТОЛЬКО из `blob_id`, а не из `Locator.uri`, поэтому
/// подделанный `uri` не даёт выйти за пределы каталога.
pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    pub fn new(root: impl AsRef<Path>) -> std::io::Result<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn path_for(&self, id: &BlobId) -> PathBuf {
        self.root.join(format!("{}.blob", id.to_hex()))
    }

    fn checked_path(&self, loc: &Locator) -> Result<PathBuf, StorageError> {
        if loc.store_id != STORE_ID {
            return Err(StorageError::InvalidLocator(format!(
                "expected store_id '{STORE_ID}', got '{}'",
                loc.store_id
            )));
        }
        Ok(self.path_for(&loc.blob_id))
    }
}

fn map_io(e: std::io::Error) -> StorageError {
    match e.kind() {
        ErrorKind::NotFound => StorageError::NotFound,
        ErrorKind::PermissionDenied => StorageError::Unauthorized,
        _ => StorageError::Io(e.to_string()),
    }
}

#[async_trait::async_trait]
impl BlobStore for LocalStore {
    fn caps(&self) -> StoreCaps {
        StoreCaps {
            kind: StoreKind::Local,
            auth: storage_api::AuthKind::None,
            // Локальная папка — не «anyone with link»: ссылку наружу не отдаём.
            public_link: false,
            range: true,
            max_file_bytes: u64::MAX,
        }
    }

    async fn put(
        &self,
        id: &BlobId,
        mut r: Box<dyn AsyncRead + Unpin + Send>,
        size: u64,
    ) -> Result<Locator, StorageError> {
        let mut buf = Vec::with_capacity(size.min(1 << 20) as usize);
        r.read_to_end(&mut buf)
            .await
            .map_err(|e| StorageError::Io(e.to_string()))?;
        if buf.len() as u64 != size {
            return Err(StorageError::Io(format!(
                "size mismatch: expected {size}, read {}",
                buf.len()
            )));
        }
        // Защита от подмены: id обязан быть SHA-256 содержимого.
        let digest: [u8; 32] = Sha256::digest(&buf).into();
        if BlobId::from_bytes(digest) != *id {
            return Err(StorageError::ChecksumMismatch);
        }

        let path = self.path_for(id);
        let tmp = path.with_extension("blob.tmp");
        tokio::fs::write(&tmp, &buf).await.map_err(map_io)?;
        // Атомарная публикация: читатель не увидит недописанный файл.
        tokio::fs::rename(&tmp, &path).await.map_err(map_io)?;

        Ok(Locator {
            store_id: STORE_ID.to_string(),
            uri: path.display().to_string(),
            blob_id: *id,
        })
    }

    async fn get(
        &self,
        loc: &Locator,
        range: Option<Range>,
    ) -> Result<Box<dyn AsyncRead + Unpin + Send>, StorageError> {
        let path = self.checked_path(loc)?;
        let mut file = tokio::fs::File::open(&path).await.map_err(map_io)?;
        match range {
            None => Ok(Box::new(file)),
            Some(r) => {
                let len = file.metadata().await.map_err(map_io)?.len();
                let start = r.start.min(len);
                let end = r.end.unwrap_or(len).min(len);
                if end < start {
                    return Err(StorageError::InvalidRange(format!(
                        "end {end} < start {start}"
                    )));
                }
                file.seek(SeekFrom::Start(start)).await.map_err(map_io)?;
                Ok(Box::new(file.take(end - start)))
            }
        }
    }

    async fn stat(&self, loc: &Locator) -> Result<BlobStat, StorageError> {
        let path = self.checked_path(loc)?;
        let meta = tokio::fs::metadata(&path).await.map_err(map_io)?;
        let modified_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        Ok(BlobStat {
            blob_id: loc.blob_id,
            size: meta.len(),
            modified_unix,
        })
    }

    async fn delete(&self, loc: &Locator) -> Result<(), StorageError> {
        let path = self.checked_path(loc)?;
        tokio::fs::remove_file(&path).await.map_err(map_io)
    }
}
