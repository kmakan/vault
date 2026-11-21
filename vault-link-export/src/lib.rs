//! Vault: экспорт подписанного bundle для связывания Sfera (ADR-009 §4).
//!
//! Мессенджер — владелец ключа подписи аккаунта. Он создаёт bundle,
//! подписанный этим ключом, и отдаёт его в QR/файле. Sfera получает только
//! публичный bundle и свой ключ устройства: приватный ключ аккаунта не
//! копируется (ADR-006 §8, ADR-009 §2).
//!
//! Каталог ключей — тот же, что у мессенджера (`VAULT_KEYS_DIR` или
//! `~/.vault/keys`), чтобы `account_signing.json` был одним источником.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use social_link::LinkBundle;
use social_model::Author;

/// Откуда брать ключ подписи. Передаётся явно: тесты используют tempdir.
pub fn keys_dir_from_env() -> PathBuf {
    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vault")
        .join("keys")
}

/// Собрать bundle для Sfera.
///
/// `device_pub_key` — публичный Ed25519-ключ устройства Sfera (hex, 32 байта),
/// `seq` — монотонный номер (новый bundle отзывает предыдущий). Контакты и
/// сферы пока пустые: перенос графа — этап 3 ADR-009, до него Sfera честно
/// работает как самостоятельный продукт.
pub fn export_bundle(
    keys_dir: &Path,
    device_pub_key: &str,
    seq: u64,
) -> Result<LinkBundle> {
    let seed = vault_core::account_signing::load_or_create_at(keys_dir)
        .context("account signing key")?;
    let public = vault_core::account_signing::public_key_hex(&seed)
        .context("account public key")?;
    let account = Author::from_public_key_hex(&public)
        .map_err(|e| anyhow::anyhow!("account author: {e}"))?;

    let cert = social_device::DeviceCert::issue(&seed, account.fp.clone(), device_pub_key, seq)
        .map_err(|e| anyhow::anyhow!("device cert: {e}"))?;

    LinkBundle::create(&seed, account, cert, Vec::new(), Vec::new(), seq)
        .map_err(|e| anyhow::anyhow!("link bundle: {e}"))
}

/// QR-ссылка для экрана «Связать Sfera».
pub fn export_uri(keys_dir: &Path, device_pub_key: &str, seq: u64) -> Result<String> {
    let bundle = export_bundle(keys_dir, device_pub_key, seq)?;
    social_link::to_uri(&bundle).map_err(|e| anyhow::anyhow!("link uri: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: &str = "0200000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn bundle_is_signed_by_account_key_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = export_bundle(dir.path(), DEVICE, 1).unwrap();
        assert!(bundle.verify(0).is_ok());
        assert_eq!(bundle.payload.device_cert.device_pub_key(), DEVICE);
        assert!(bundle.payload.contacts.is_empty(), "граф переносится на этапе 3");
    }

    #[test]
    fn uri_roundtrip_from_messenger() {
        let dir = tempfile::tempdir().unwrap();
        let uri = export_uri(dir.path(), DEVICE, 1).unwrap();
        let back = social_link::from_uri(&uri).unwrap();
        assert!(back.verify(0).is_ok());
    }

    #[test]
    fn account_seed_is_not_in_uri() {
        let dir = tempfile::tempdir().unwrap();
        let seed = vault_core::account_signing::load_or_create_at(dir.path()).unwrap();
        let uri = export_uri(dir.path(), DEVICE, 1).unwrap();
        assert!(!uri.contains(&seed));
    }
}
