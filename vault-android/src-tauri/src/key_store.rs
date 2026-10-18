//! Thin wrapper над `vault_core::key_store::*`.
//!
//! Android ранее имел собственный fork I/O — теперь proxy-ит canonical
//! impl из vault-core (получает ADDRESS GATE / SELF-KEY GUARD / DEDUP + pubkey-rename
//! из t_2beb9ee5 / PQ auto_migrate). Единственная Android-специфичность —
//! резолвер `keys_dir` через `VAULT_KEYS_DIR` env (для тестов/перенаправления)
//! и `~/.vault/keys` fallback.
//!
//! Тесты перенесены в `vault-core/src/key_store.rs` (общие fixtures) — здесь
//! только proxy + env-resolution.

pub use vault_core::key_store_types::{
    KeyStoreMetadata, StoredKeyPair, StoredPeerKey,
};

const KEYS_DIR: &str = "keys";
#[allow(dead_code)]
const KEY_FILE: &str = "keypair.json";
#[allow(dead_code)]
const PEER_KEYS_FILE: &str = "peer_keys.json";

/// Резолв директории ключей Android: либо `VAULT_KEYS_DIR` (тесты/перенаправление),
/// либо `~/.vault/keys`. Передаётся как `keys_dir` в `vault_core::key_store`.
fn get_keys_dir() -> anyhow::Result<std::path::PathBuf> {
    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {
        return Ok(std::path::PathBuf::from(p));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault").join(KEYS_DIR))
}

fn dir0() -> anyhow::Result<std::path::PathBuf> {
    let dir = get_keys_dir()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

pub fn save_keypair(keypair: &StoredKeyPair) -> anyhow::Result<()> {
    vault_core::key_store::save_keypair_at(&dir0()?, keypair)
}

pub fn load_keypair() -> anyhow::Result<Option<StoredKeyPair>> {
    vault_core::key_store::load_keypair_at(&get_keys_dir()?, false)
}

pub fn load_peer_keys() -> anyhow::Result<Vec<StoredPeerKey>> {
    vault_core::key_store::load_peer_keys_at(&get_keys_dir()?)
}

pub fn add_peer_key(key: StoredPeerKey) -> anyhow::Result<()> {
    vault_core::key_store::add_peer_key_at(&dir0()?, key)
}

pub fn remove_peer_key(email: &str) -> anyhow::Result<bool> {
    vault_core::key_store::remove_peer_key_at(&get_keys_dir()?, email)
}

pub fn export_keys() -> anyhow::Result<String> {
    vault_core::key_store::export_keys_at(&get_keys_dir()?)
}

/// Lightweight restore (без backup_import журнала). Полноценный транзакционный
/// pipeline с commit-маркером живёт в desktop `import_keys`.
pub fn import_keys(json_data: &str) -> anyhow::Result<KeyStoreMetadata> {
    vault_core::key_store::import_keys_at(&dir0()?, json_data)
}

pub fn get_store_metadata() -> anyhow::Result<Option<KeyStoreMetadata>> {
    vault_core::key_store::get_store_metadata_at(&get_keys_dir()?)
}

pub fn delete_all_keys() -> anyhow::Result<()> {
    vault_core::key_store::delete_all_keys_at(&get_keys_dir()?)
}
