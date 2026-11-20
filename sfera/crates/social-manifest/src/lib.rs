//! Vault Sfera: манифест E2E-конверта (ADR-006 §7.1).
//!
//! Конверт несёт локации блобов и ключи, но НЕ само медиа: письмо остаётся
//! маленьким, лимиты почтового провайдера не мешают. Утечка ссылки бесполезна
//! без ключа (§5.2), поэтому `Locator` логируем, а `BlobKey` — нет.
//!
//! Порядок локаций — предпочтение, а не истина (§5.3): клиент пробует по
//! очереди и запоминает рабочую.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use storage_api::{BlobId, Locator};

/// Ключ блоба. `Debug` не показывает material — случайный лог не должен
/// раскрыть содержимое.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobKey {
    pub blob_id: BlobId,
    pub key_hex: String,
}

impl std::fmt::Debug for BlobKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlobKey")
            .field("blob_id", &self.blob_id.to_hex())
            .field("key_hex", &"<redacted>")
            .finish()
    }
}

/// Одна запись манифеста: ключ + упорядоченные локации.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobEntry {
    pub key: BlobKey,
    pub locators: Vec<Locator>,
    pub mime: String,
    pub size: u64,
}

/// Манифест конверта. `v` версионирован: неизвестную версию сохраняем как
/// неподдерживаемую, а не ломаем ленту.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub v: u8,
    pub post_id: String,
    pub entries: Vec<BlobEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManifestError {
    UnsupportedVersion,
    MissingKey,
    EmptyLocators,
    BlobMismatch,
}

impl Manifest {
    pub const VERSION: u8 = 1;

    /// Собрать манифест. Каждый блоб обязан иметь ключ и хотя бы одну локацию.
    pub fn new(post_id: impl Into<String>, entries: Vec<BlobEntry>) -> Self {
        Self { v: Self::VERSION, post_id: post_id.into(), entries }
    }

    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.v != Self::VERSION {
            return Err(ManifestError::UnsupportedVersion);
        }
        for e in &self.entries {
            if e.locators.is_empty() {
                return Err(ManifestError::EmptyLocators);
            }
            if e.key.key_hex.len() != 64 || hex::decode(&e.key.key_hex).is_err() {
                return Err(ManifestError::MissingKey);
            }
            if e.locators.iter().any(|l| l.blob_id != e.key.blob_id) {
                return Err(ManifestError::BlobMismatch);
            }
        }
        Ok(())
    }

    /// Хеш манифеста — для дедупа повторной доставки конверта.
    pub fn hash(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        hex::encode(Sha256::digest(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage_api::BlobId;

    fn id(byte: u8) -> BlobId {
        BlobId::from_bytes([byte; 32])
    }

    fn entry() -> BlobEntry {
        let b = id(1);
        BlobEntry {
            key: BlobKey { blob_id: b, key_hex: "ab".repeat(32) },
            locators: vec![Locator {
                store_id: "device".into(),
                uri: format!("/vault/blobs/{}", b.to_hex()),
                blob_id: b,
            }],
            mime: "image/jpeg".into(),
            size: 1024,
        }
    }

    #[test]
    fn manifest_validates() {
        let m = Manifest::new("post-1", vec![entry()]);
        assert!(m.validate().is_ok());
    }

    #[test]
    fn blob_key_debug_redacts_secret() {
        let e = entry();
        let dbg = format!("{:?}", e.key);
        assert!(!dbg.contains(&"ab".repeat(32)));
        assert!(dbg.contains("<redacted>"));
    }

    #[test]
    fn locator_mismatch_is_rejected() {
        let mut e = entry();
        e.locators[0].blob_id = id(2);
        let m = Manifest::new("post-1", vec![e]);
        assert_eq!(m.validate().unwrap_err(), ManifestError::BlobMismatch);
    }

    #[test]
    fn empty_locators_are_rejected() {
        let mut e = entry();
        e.locators.clear();
        let m = Manifest::new("post-1", vec![e]);
        assert_eq!(m.validate().unwrap_err(), ManifestError::EmptyLocators);
    }

    #[test]
    fn unknown_version_is_not_silently_accepted() {
        let mut m = Manifest::new("post-1", vec![entry()]);
        m.v = 99;
        assert_eq!(m.validate().unwrap_err(), ManifestError::UnsupportedVersion);
    }

    #[test]
    fn hash_is_stable() {
        let a = Manifest::new("post-1", vec![entry()]);
        let b = Manifest::new("post-1", vec![entry()]);
        assert_eq!(a.hash(), b.hash());
        assert_eq!(a.hash().len(), 64);
    }
}
