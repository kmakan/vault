//! Общие типы хранения ключей (единый источник истины).
//!
//! Структуры `StoredKeyPair`, `StoredPeerKey`, `KeyStoreMetadata` были
//! определны в `vault-desktop/src-tauri/src/key_store.rs`; CLI парсил
//! `keypair.json` вручную. Теперь типы общие — сериализация совместима
//! между CLI и desktop, нет риска расхождения форматов.
//! НЕ содержит логики (только типы + serde) — безопасно для импорта в оба
//! бинарника без изменения их API хранения.

use serde::{Deserialize, Serialize};

/// Пара ключей аккаунта: X25519 public/private hex + PQ (ML-KEM-768).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredKeyPair {
    pub public_key: String,
    pub private_key: String,
    pub created_at: String,
    /// Post-quantum: seed ML-KEM-768, hex 64 байта. У старых
    /// keypair.json поля нет → миграция генерирует при load_keypair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_private_key: Option<String>,
    /// Post-quantum: ek ML-KEM-768, base64 1184 байта.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_public_key: Option<String>,
}

/// Публичный ключ контакта с меткой и временем добавления.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPeerKey {
    pub email: String,
    pub public_key: String,
    pub label: Option<String>,
    pub added_at: String,
    /// Post-quantum: ek ML-KEM-768 контакта, base64. Нет — контакт
    /// ещё без PQ (миграция), ему уходит legacy X25519-конверт.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_public_key: Option<String>,
}

/// Метаданные хранилища ключей.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStoreMetadata {
    pub version: u32,
    pub key_count: usize,
    pub last_modified: String,
}
