use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const KEYS_DIR: &str = "keys";
const KEY_FILE: &str = "keypair.json";
const PEER_KEYS_FILE: &str = "peer_keys.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredKeyPair {
    pub public_key: String,
    pub private_key: String,
    pub created_at: String,
    /// Post-quantum (30.08): seed ML-KEM-768, hex 64 байта. У старых
    /// keypair.json поля нет → миграция генерирует при load_keypair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_private_key: Option<String>,
    /// Post-quantum: ek ML-KEM-768, base64 1184 байта.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPeerKey {
    pub email: String,
    pub public_key: String,
    pub label: Option<String>,
    pub added_at: String,
    /// Post-quantum (30.08): ek ML-KEM-768 контакта, base64. Нет — контакт
    /// ещё без PQ (миграция), ему уходит legacy X25519-конверт.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStoreMetadata {
    pub version: u32,
    pub key_count: usize,
    pub last_modified: String,
}

fn get_keys_dir() -> anyhow::Result<PathBuf> {
    // Tests (and power users) can redirect the storage dir; keeps the real
    // `~/.vault/keys` untouched.
    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault").join(KEYS_DIR))
}

fn ensure_keys_dir() -> anyhow::Result<PathBuf> {
    let dir = get_keys_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn save_keypair(keypair: &StoredKeyPair) -> anyhow::Result<()> {
    let dir = ensure_keys_dir()?;
    let path = dir.join(KEY_FILE);
    let json = serde_json::to_string_pretty(keypair)?;
    fs::write(&path, json)?;
    Ok(())
}

pub fn load_keypair() -> anyhow::Result<Option<StoredKeyPair>> {
    let dir = get_keys_dir()?;
    let path = dir.join(KEY_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path)?;
    let mut keypair: StoredKeyPair = serde_json::from_str(&data)?;
    // PQ-миграция (30.08): у аккаунтов, созданных до post-quantum, нет
    // ML-KEM-пары. Генерируем при первой загрузке и сразу сохраняем —
    // конверты v2 начнут уходить автоматически (PQ-3/PQ-4).
    if keypair.pq_private_key.is_none() || keypair.pq_public_key.is_none() {
        let pq = crate::crypto_pq::pq_generate();
        keypair.pq_private_key = Some(pq.seed_hex);
        keypair.pq_public_key = Some(pq.ek_b64);
        let json = serde_json::to_string_pretty(&keypair)?;
        fs::write(&path, json)?;
    }
    Ok(Some(keypair))
}

pub fn save_peer_keys(keys: &[StoredPeerKey]) -> anyhow::Result<()> {
    let dir = ensure_keys_dir()?;
    let path = dir.join(PEER_KEYS_FILE);
    let json = serde_json::to_string_pretty(keys)?;
    fs::write(&path, json)?;
    Ok(())
}

pub fn load_peer_keys() -> anyhow::Result<Vec<StoredPeerKey>> {
    let dir = get_keys_dir()?;
    let path = dir.join(PEER_KEYS_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)?;
    let keys: Vec<StoredPeerKey> = serde_json::from_str(&data)?;
    Ok(keys)
}

pub fn add_peer_key(key: StoredPeerKey) -> anyhow::Result<()> {
    // SELF-KEY GUARD: saving one's own public key as a peer's key silently
    // breaks ECDH in BOTH directions (encrypt-to-self / decrypt mismatch).
    // Root cause of the 15.08 "messages don't work both ways" incident: a
    // stale invite sent from a shared-HOME instance carried the sender's own
    // keypair as "their" public key, and the acceptor stored it. Reject at
    // the single choke point all peer-key writes go through (contact invite
    // accept, contact accept, manual paste).
    if let Some(kp) = load_keypair()? {
        if kp.public_key == key.public_key {
            anyhow::bail!("Refusing to save your own public key as a peer key");
        }
    }
    let mut keys = load_peer_keys()?;
    if let Some(existing) = keys.iter_mut().find(|k| k.email == key.email) {
        existing.public_key = key.public_key;
        existing.label = key.label;
        // PQ: новый ключ затирает старый; None НЕ трогает существующий
        // (контакт без PQ остаётся с PQ-ключом, полученным позже из конверта).
        if key.pq_public_key.is_some() {
            existing.pq_public_key = key.pq_public_key;
        }
    } else {
        keys.push(key);
    }
    save_peer_keys(&keys)
}

pub fn remove_peer_key(email: &str) -> anyhow::Result<bool> {
    let mut keys = load_peer_keys()?;
    let before = keys.len();
    keys.retain(|k| k.email != email);
    let removed = keys.len() < before;
    if removed {
        save_peer_keys(&keys)?;
    }
    Ok(removed)
}

pub fn export_keys() -> anyhow::Result<String> {
    let keypair = load_keypair()?.ok_or_else(|| anyhow::anyhow!("No keypair found"))?;
    let peer_keys = load_peer_keys()?;
    let export = serde_json::json!({
        "version": 1,
        "keypair": keypair,
        "peer_keys": peer_keys,
        "exported_at": chrono::Utc::now().to_rfc3339(),
    });
    Ok(serde_json::to_string_pretty(&export)?)
}

pub fn import_keys(json_data: &str) -> anyhow::Result<KeyStoreMetadata> {
    let data: serde_json::Value = serde_json::from_str(json_data)?;
    let version = data["version"].as_u64().unwrap_or(1) as u32;

    let mut key_count = 0;

    if let Some(kp) = data.get("keypair") {
        let keypair: StoredKeyPair = serde_json::from_value(kp.clone())?;
        save_keypair(&keypair)?;
        key_count += 1;
    }

    if let Some(peers) = data.get("peer_keys").and_then(|v| v.as_array()) {
        let peer_keys: Vec<StoredPeerKey> = peers
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        save_peer_keys(&peer_keys)?;
        key_count += peer_keys.len();
    }

    Ok(KeyStoreMetadata {
        version,
        key_count,
        last_modified: chrono::Utc::now().to_rfc3339(),
    })
}

pub fn get_store_metadata() -> anyhow::Result<Option<KeyStoreMetadata>> {
    let dir = get_keys_dir()?;
    let key_path = dir.join(KEY_FILE);
    let peer_path = dir.join(PEER_KEYS_FILE);

    if !key_path.exists() && !peer_path.exists() {
        return Ok(None);
    }

    let key_count = if key_path.exists() {
        1 + load_peer_keys().map(|k| k.len()).unwrap_or(0)
    } else {
        load_peer_keys().map(|k| k.len()).unwrap_or(0)
    };

    let last_modified = fs::metadata(&key_path)
        .or_else(|_| fs::metadata(&peer_path))
        .and_then(|m| m.modified())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

    Ok(Some(KeyStoreMetadata {
        version: 1,
        key_count,
        last_modified,
    }))
}

pub fn delete_all_keys() -> anyhow::Result<()> {
    let dir = get_keys_dir()?;
    let _ = fs::remove_file(dir.join(KEY_FILE));
    let _ = fs::remove_file(dir.join(PEER_KEYS_FILE));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    /// Env vars are process-global, so tests that redirect VAULT_KEYS_DIR
    /// must run one at a time (cargo runs tests in parallel by default).
    static TMP_LOCK: Mutex<()> = Mutex::new(());

    /// Point VAULT_KEYS_DIR at a fresh temp dir so tests never touch the
    /// real `~/.vault/keys`.
    fn with_tmp_keys<T>(f: impl FnOnce() -> T) -> T {
        let _guard = TMP_LOCK.lock().unwrap();
        let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("vault-keys-test-{}-{}", std::process::id(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("VAULT_KEYS_DIR", &dir);
        let result = f();
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("VAULT_KEYS_DIR");
        result
    }

    #[test]
    fn test_save_and_load_keypair() {
        with_tmp_keys(|| {
            let kp = StoredKeyPair {
                public_key: "abcd1234".to_string(),
                private_key: "ef567890".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                pq_private_key: None,
                pq_public_key: None,
            };
            save_keypair(&kp).unwrap();
            let loaded = load_keypair().unwrap().unwrap();
            assert_eq!(loaded.public_key, kp.public_key);
            // PQ-миграция: load сгенерировал ML-KEM-пару и сохранил
            assert!(loaded.pq_private_key.is_some());
            assert!(loaded.pq_public_key.is_some());
            // Повторная загрузка НЕ рероллит PQ-пару (стабильный идентификатор)
            let again = load_keypair().unwrap().unwrap();
            assert_eq!(loaded.pq_public_key, again.pq_public_key);
        });
    }

    #[test]
    fn test_peer_keys_crud() {
        with_tmp_keys(|| {
            let key = StoredPeerKey {
                email: "test@example.com".to_string(),
                public_key: "aabbccdd".to_string(),
                label: Some("Test User".to_string()),
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(key.clone()).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys.len(), 1);

            let removed = remove_peer_key("test@example.com").unwrap();
            assert!(removed);
            let keys = load_peer_keys().unwrap();
            assert!(keys.is_empty());
        });
    }

    #[test]
    fn test_add_peer_key_rejects_own_public_key() {
        // SELF-KEY GUARD: saving one's own public key as a peer's key breaks
        // ECDH silently in both directions — must be rejected at the store.
        with_tmp_keys(|| {
            let kp = StoredKeyPair {
                public_key: "abcd1234".to_string(),
                private_key: "ef567890".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                pq_private_key: None,
                pq_public_key: None,
            };
            save_keypair(&kp).unwrap();

            let own_as_peer = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: kp.public_key.clone(),
                label: None,
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            let err = add_peer_key(own_as_peer).unwrap_err();
            assert!(err.to_string().contains("own public key"));
            assert!(load_peer_keys().unwrap().is_empty());

            // A genuinely different key still saves fine.
            let real_peer = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: Some("fakepq".to_string()),
            };
            add_peer_key(real_peer).unwrap();
            assert_eq!(load_peer_keys().unwrap().len(), 1);

            // PQ-семантика add_peer_key: None не трогает существующий PQ,
            // валидный новый — обновляет.
            let no_pq_update = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-02T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(no_pq_update).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("fakepq"));

            let new_pq = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-03T00:00:00Z".to_string(),
                pq_public_key: Some("newpq".to_string()),
            };
            add_peer_key(new_pq).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("newpq"));
        });
    }
}
