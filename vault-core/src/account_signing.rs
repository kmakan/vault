//! Ключ подписи аккаунта (ADR-009).
//!
//! Идентичность аккаунта — отпечаток Ed25519-ключа подписи. X25519 остаётся
//! ключом шифрования и подключом. Ключ создаётся при первом использовании и
//! лежит рядом с остальными ключами (`account_signing.json`, права 0600).
//!
//! Здесь только хранение и вывод публичного ключа. Подпись конкретных
//! объектов (пост, профиль, сертификат устройства, bundle связывания) —
//! доменно-разделённая, в своих крейтах; один ключ не подменяет другой.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// Имя файла в каталоге ключей. Секрет: в логи и QR не попадает.
pub const FILE: &str = "account_signing.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    v: u8,
    seed: String,
}

fn path(keys_dir: &Path) -> PathBuf {
    keys_dir.join(FILE)
}

fn valid_seed(seed: &str) -> bool {
    seed.len() == 64 && seed.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_seed(seed: &str) -> Result<[u8; 32]> {
    if !valid_seed(seed) {
        return Err(anyhow!("account signing seed must be 32 bytes hex"));
    }
    let raw = hex::decode(seed).context("account signing seed is not hex")?;
    raw.as_slice()
        .try_into()
        .map_err(|_| anyhow!("account signing seed must be 32 bytes"))
}

/// Прочитать ключ подписи, если он уже создан.
pub fn load_at(keys_dir: &Path) -> Result<Option<String>> {
    let path = path(keys_dir);
    if !path.exists() {
        return Ok(None);
    }
    let doc: Stored = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    if doc.v != 1 || !valid_seed(&doc.seed) {
        return Err(anyhow!("account_signing.json: unsupported version or bad seed"));
    }
    Ok(Some(doc.seed))
}

/// Прочитать ключ или создать его при первом использовании.
///
/// Запись атомарная (tmp → rename) и только для владельца (0600 на Unix):
/// недописанный файл не должен выглядеть как валидный ключ.
pub fn load_or_create_at(keys_dir: &Path) -> Result<String> {
    if let Some(seed) = load_at(keys_dir)? {
        return Ok(seed);
    }
    std::fs::create_dir_all(keys_dir)
        .with_context(|| format!("create {}", keys_dir.display()))?;

    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let doc = Stored { v: 1, seed: hex::encode(seed) };
    let body = serde_json::to_vec(&doc)?;

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
    Ok(doc.seed)
}

/// Публичный ключ подписи (hex, 32 байта) — можно показывать и передавать.
pub fn public_key_hex(seed_hex: &str) -> Result<String> {
    let seed = parse_seed(seed_hex)?;
    let key = SigningKey::from_bytes(&seed);
    Ok(hex::encode(key.verifying_key().to_bytes()))
}

/// Отпечаток аккаунта — первые 8 байт публичного ключа, форма `xx:…:****`.
pub fn fingerprint(seed_hex: &str) -> Result<String> {
    let public = public_key_hex(seed_hex)?;
    crate::identity::fingerprint_from_public_key(&public)
        .map_err(|e| anyhow!("fingerprint: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_at(dir.path()).unwrap();
        assert!(valid_seed(&first));
        let second = load_or_create_at(dir.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(load_at(dir.path()).unwrap().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn public_key_and_fingerprint_are_stable() {
        let seed = "0100000000000000000000000000000000000000000000000000000000000000";
        let pub_a = public_key_hex(seed).unwrap();
        let pub_b = public_key_hex(seed).unwrap();
        assert_eq!(pub_a, pub_b);
        assert_eq!(pub_a.len(), 64);
        let fp = fingerprint(seed).unwrap();
        assert!(fp.ends_with(":****"));
        assert!(fp.len() <= 64);
    }

    #[test]
    fn different_seeds_give_different_identities() {
        let a = fingerprint("0100000000000000000000000000000000000000000000000000000000000000").unwrap();
        let b = fingerprint("0200000000000000000000000000000000000000000000000000000000000000").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn broken_seed_is_rejected() {
        assert!(public_key_hex("not-hex").is_err());
        assert!(public_key_hex("00").is_err());
    }

    #[test]
    fn broken_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), r#"{"v":1,"seed":"nope"}"#).unwrap();
        assert!(load_at(dir.path()).is_err());
        assert!(load_or_create_at(dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create_at(dir.path()).unwrap();
        let mode = std::fs::metadata(dir.path().join(FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
