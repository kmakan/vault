//! Ключи подписи контактов (ADR-009 §4, шаг 3 миграции).
//!
//! Хранятся отдельно от `peer_keys.json`: у того формат общий для CLI и
//! desktop, и у него 32 конструктора — менять его ради аддитивного поля
//! было бы рискованно. Здесь свой файл `contact_signing.json` (0600),
//! ключ — адрес контакта (email), значение — Ed25519 public hex.
//!
//! Отсутствие записи честно означает «контакт ещё не обновил приложение»:
//! Sfera не импортирует такой контакт как подписанный.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

pub const FILE: &str = "contact_signing.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    v: u8,
    /// Ключ — адрес контакта, значение — Ed25519 public key hex (32 байта).
    contacts: BTreeMap<String, String>,
}

fn path(keys_dir: &Path) -> PathBuf {
    keys_dir.join(FILE)
}

fn valid_hex(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn load_at(keys_dir: &Path) -> Result<BTreeMap<String, String>> {
    let path = path(keys_dir);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let doc: Stored = serde_json::from_str(
        &std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    if doc.v != 1 {
        return Err(anyhow!("{FILE}: unsupported version {}", doc.v));
    }
    for (addr, key) in &doc.contacts {
        if !valid_hex(key) {
            return Err(anyhow!("{FILE}: bad signing key for {addr}"));
        }
    }
    Ok(doc.contacts)
}

/// Добавить/обновить ключ подписи контакта. Атомарная запись, 0600.
pub fn remember_at(keys_dir: &Path, address: &str, public_hex: &str) -> Result<()> {
    if address.trim().is_empty() {
        return Err(anyhow!("contact address required"));
    }
    if !valid_hex(public_hex) {
        return Err(anyhow!("contact signing key must be 32 bytes hex"));
    }
    let mut contacts = load_at(keys_dir)?;
    contacts.insert(address.to_string(), public_hex.to_string());

    let doc = Stored { v: 1, contacts };
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

/// Есть ли ключ подписи у контакта. `false` — граф ещё не перенесён.
pub fn has_signing_key(contacts: &BTreeMap<String, String>, address: &str) -> bool {
    contacts.get(address).is_some_and(|k| valid_hex(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0200000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn empty_registry_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_at(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn remember_is_persistent_and_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        remember_at(dir.path(), "a@example", KEY).unwrap();
        let map = load_at(dir.path()).unwrap();
        assert_eq!(map.get("a@example").map(String::as_str), Some(KEY));
        assert!(has_signing_key(&map, "a@example"));
        assert!(!has_signing_key(&map, "b@example"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn bad_key_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(remember_at(dir.path(), "a@example", "nope").is_err());
        assert!(remember_at(dir.path(), "", KEY).is_err());
    }

    #[test]
    fn broken_file_is_rejected_not_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), r#"{"v":1,"contacts":{"a@example":"nope"}}"#).unwrap();
        assert!(load_at(dir.path()).is_err());
    }
}
