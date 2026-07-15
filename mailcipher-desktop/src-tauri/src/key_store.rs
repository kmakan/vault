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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPeerKey {
    pub email: String,
    pub public_key: String,
    pub label: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStoreMetadata {
    pub version: u32,
    pub key_count: usize,
    pub last_modified: String,
}

fn get_keys_dir() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".whisper").join(KEYS_DIR))
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
    let keypair: StoredKeyPair = serde_json::from_str(&data)?;
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
    let mut keys = load_peer_keys()?;
    if let Some(existing) = keys.iter_mut().find(|k| k.email == key.email) {
        existing.public_key = key.public_key;
        existing.label = key.label;
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

    #[test]
    fn test_save_and_load_keypair() {
        let kp = StoredKeyPair {
            public_key: "abcd1234".to_string(),
            private_key: "ef567890".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };
        save_keypair(&kp).unwrap();
        let loaded = load_keypair().unwrap().unwrap();
        assert_eq!(loaded.public_key, kp.public_key);
    }

    #[test]
    fn test_peer_keys_crud() {
        let key = StoredPeerKey {
            email: "test@example.com".to_string(),
            public_key: "aabbccdd".to_string(),
            label: Some("Test User".to_string()),
            added_at: "2024-01-01T00:00:00Z".to_string(),
        };
        add_peer_key(key.clone()).unwrap();
        let keys = load_peer_keys().unwrap();
        assert_eq!(keys.len(), 1);

        let removed = remove_peer_key("test@example.com").unwrap();
        assert!(removed);
        let keys = load_peer_keys().unwrap();
        assert!(keys.is_empty());
    }
}
