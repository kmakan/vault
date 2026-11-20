//! Vault Sfera — порт хранилища и общие типы (ADR-006 §6).
//!
//! Фичи видят только [`BlobStore`], [`Locator`] и [`BlobId`]; ни один доменный
//! крейт не знает про HTTP-клиент провайдера, OAuth или путь на диске.
//! Адаптер (`storage-local`, `storage-webdav`, …) отвечает за авторизацию,
//! ретраи, квоты и преобразование ошибок в [`StorageError`].

use std::fmt;
use std::str::FromStr;

/// Адрес блоба: SHA-256 шифротекста. Провайдер видит только это значение,
/// поэтому одинаковые plaintext-файлы не совпадают по ID (ADR-006 §5.1).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BlobId([u8; 32]);

impl BlobId {
    pub const LEN: usize = 32;

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl fmt::Display for BlobId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for BlobId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BlobId({})", self.to_hex())
    }
}

impl FromStr for BlobId {
    type Err = StorageError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = hex::decode(s.trim())
            .map_err(|_| StorageError::InvalidLocator("blob id is not hex".into()))?;
        let bytes: [u8; 32] = raw.try_into().map_err(|_| {
            StorageError::InvalidLocator(format!("blob id must be {} bytes", Self::LEN))
        })?;
        Ok(Self(bytes))
    }
}

impl serde::Serialize for BlobId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> serde::Deserialize<'de> for BlobId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Что умеет конкретное хранилище. Решение принимается в Rust, UI только
/// рисует галки и отключает недоступные действия.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StoreCaps {
    pub kind: StoreKind,
    pub auth: AuthKind,
    /// «Любой по ссылке» — Basis capability-доступа (ADR-006 §5.2).
    pub public_link: bool,
    /// Поддержка Range — prerequisite стриминга и видео (ADR-006 §5.1).
    pub range: bool,
    pub max_file_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum StoreKind {
    Local,
    WebDav,
    S3,
    OAuth,
    Vault,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AuthKind {
    None,
    Password,
    Token,
    Keys,
    OAuth,
}

/// Одна точка входа к блобу. Порядок локаций у блоба — предпочтение, а не
/// истина (ADR-006 §5.3): клиент пробует по очереди и запоминает рабочую.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Locator {
    /// Идентификатор пресета: `local`, `nextcloud`, `selectel`, …
    pub store_id: String,
    /// Неугадываемый путь/capability URL. Секретов внутри нет: ключ едет
    /// отдельно в E2E-конверте (ADR-006 §5.2), поэтому `Locator` можно логировать.
    pub uri: String,
    pub blob_id: BlobId,
}

/// Полуоткрытый диапазон байт блоба: `[start, end)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Range {
    pub start: u64,
    /// `None` — до конца.
    pub end: Option<u64>,
}

impl Range {
    pub fn new(start: u64, end: Option<u64>) -> Result<Self, StorageError> {
        if let Some(e) = end {
            if e < start {
                return Err(StorageError::InvalidRange("end < start".into()));
            }
        }
        Ok(Self { start, end })
    }

    pub fn len(&self) -> Option<u64> {
        self.end.map(|e| e - self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == Some(0)
    }

    /// Разбор HTTP-заголовка `Range: bytes=START-END` (WebDAV/S3 range).
    pub fn parse_http(value: &str) -> Result<Self, StorageError> {
        let value = value
            .strip_prefix("bytes=")
            .ok_or_else(|| StorageError::InvalidRange("missing bytes= prefix".into()))?
            .trim();
        let (start, end) = value.split_once('-').ok_or_else(|| {
            StorageError::InvalidRange("expected START-END".into())
        })?;
        let start = start.parse::<u64>().map_err(|_| {
            StorageError::InvalidRange("start is not a number".into())
        })?;
        let end = if end.is_empty() {
            None
        } else {
            Some(end.parse::<u64>().map_err(|_| {
                StorageError::InvalidRange("end is not a number".into())
            })?)
        };
        Self::new(start, end)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BlobStat {
    pub blob_id: BlobId,
    /// Размер зашифрованного блоба (включая заголовок VAULTBLOB1).
    pub size: u64,
    pub modified_unix: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageError {
    InvalidLocator(String),
    InvalidRange(String),
    NotFound,
    Unauthorized,
    QuotaExceeded,
    RangeUnsupported,
    ChecksumMismatch,
    Io(String),
    Auth(String),
    Backend(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLocator(m) => write!(f, "invalid locator: {m}"),
            Self::InvalidRange(m) => write!(f, "invalid range: {m}"),
            Self::NotFound => f.write_str("blob not found"),
            Self::Unauthorized => f.write_str("unauthorized"),
            Self::QuotaExceeded => f.write_str("quota exceeded"),
            Self::RangeUnsupported => f.write_str("store does not support range requests"),
            Self::ChecksumMismatch => f.write_str("blob checksum mismatch"),
            Self::Io(m) => write!(f, "storage io error: {m}"),
            Self::Auth(m) => write!(f, "storage auth error: {m}"),
            Self::Backend(m) => write!(f, "storage backend error: {m}"),
        }
    }
}

impl std::error::Error for StorageError {}

/// Порт хранилища. `AsyncRead` выбран сознательно: Range требует чтения
/// кусками, а не загрузки всего файла в память; `async-trait` сохраняет
/// `dyn`-совместимость, чтобы фичи держали `Arc<dyn BlobStore>`.
#[async_trait::async_trait]
pub trait BlobStore: Send + Sync {
    fn caps(&self) -> StoreCaps;

    async fn put(
        &self,
        id: &BlobId,
        r: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
        size: u64,
    ) -> Result<Locator, StorageError>;

    async fn get(
        &self,
        loc: &Locator,
        range: Option<Range>,
    ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, StorageError>;

    async fn stat(&self, loc: &Locator) -> Result<BlobStat, StorageError>;

    async fn delete(&self, loc: &Locator) -> Result<(), StorageError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_id_hex_roundtrip() {
        let raw = [7u8; 32];
        let id = BlobId::from_bytes(raw);
        assert_eq!(id.to_hex(), "07".repeat(32));
        assert_eq!(BlobId::from_str(&id.to_hex()).unwrap(), id);
        assert!(BlobId::from_str("00").is_err());
        assert!(BlobId::from_str(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn blob_id_serializes_as_string() {
        let id = BlobId::from_bytes([0xab; 32]);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", "ab".repeat(32)));
        assert_eq!(serde_json::from_str::<BlobId>(&json).unwrap(), id);
    }

    #[test]
    fn range_http_header() {
        assert_eq!(
            Range::parse_http("bytes=100-199").unwrap(),
            Range::new(100, Some(199)).unwrap()
        );
        assert_eq!(
            Range::parse_http("bytes=512-").unwrap(),
            Range::new(512, None).unwrap()
        );
        assert!(Range::parse_http("100-199").is_err());
        assert!(Range::new(10, Some(9)).is_err());
        assert_eq!(Range::new(10, Some(10)).unwrap().len(), Some(0));
    }
}
