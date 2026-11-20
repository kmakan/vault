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

/// Память рабочей локации: ключ `blob_id` → `store_id`, который сработал.
/// Порядок в манифесте — предпочтение, а не истина (§5.3): запомненный
/// рабочий провайдер пробуется первым, но при отказе остальные не теряются.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocatorMemory {
    working: std::collections::BTreeMap<String, String>,
}

impl LocatorMemory {
    fn key(blob: &BlobId) -> String {
        blob.to_hex()
    }

    /// Упорядочить локации: сначала запомненная рабочая, затем остальные
    /// в исходном порядке манифеста (детерминированно).
    pub fn ordered<'a>(&self, blob: &BlobId, locators: &'a [Locator]) -> Vec<&'a Locator> {
        let preferred = self.working.get(&Self::key(blob));
        let mut out: Vec<&Locator> = locators.iter().collect();
        if let Some(store) = preferred {
            out.sort_by_key(|l| if l.store_id == *store { 0 } else { 1 });
        }
        out
    }

    /// Запомнить рабочую локацию после успешного чтения.
    pub fn remember(&mut self, blob: &BlobId, store_id: &str) {
        self.working.insert(Self::key(blob), store_id.to_string());
    }

    pub fn forget(&mut self, blob: &BlobId) {
        self.working.remove(&Self::key(blob));
    }

    pub fn known(&self, blob: &BlobId) -> Option<&str> {
        self.working.get(&Self::key(blob)).map(String::as_str)
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

    fn two_locators() -> Vec<Locator> {
        let b = id(1);
        vec![
            Locator { store_id: "device".into(), uri: "/a".into(), blob_id: b },
            Locator { store_id: "nextcloud".into(), uri: "/b".into(), blob_id: b },
        ]
    }

    #[test]
    fn memory_puts_working_locator_first() {
        let b = id(1);
        let locs = two_locators();
        let mut mem = LocatorMemory::default();
        assert_eq!(mem.ordered(&b, &locs)[0].store_id, "device");
        mem.remember(&b, "nextcloud");
        assert_eq!(mem.ordered(&b, &locs)[0].store_id, "nextcloud");
        assert_eq!(mem.known(&b), Some("nextcloud"));
    }

    #[test]
    fn forgetting_returns_to_manifest_order() {
        let b = id(1);
        let locs = two_locators();
        let mut mem = LocatorMemory::default();
        mem.remember(&b, "nextcloud");
        mem.forget(&b);
        assert_eq!(mem.ordered(&b, &locs)[0].store_id, "device");
        assert!(mem.known(&b).is_none());
    }

    #[test]
    fn hash_is_stable() {
        let a = Manifest::new("post-1", vec![entry()]);
        let b = Manifest::new("post-1", vec![entry()]);
        assert_eq!(a.hash(), b.hash());
        assert_eq!(a.hash().len(), 64);
    }
}
