//! Common key-store persistence (dedup of desktop `key_store.rs` RAW helpers
//! и CLI `crypto.rs` keypair I/O).
//!
//! Чисто файловые функции, принимают `keys_dir: &Path` — **без guard/lock**,
//! **без env-var resolution**, **без SQLite**. Вызывающий (desktop) берёт
//! guard (t_12f15e61) и резолвит `keys_dir` через `get_keys_dir_raw`; CLI
//! (single-process REPL) работает напрямую.
//!
//! Типы `StoredKeyPair`/`StoredPeerKey`/`KeyStoreMetadata` живут в
//! `key_store_types` — здесь только I/O + бизнес-правила (PQ-миграция,
//! ADDRESS GATE, SELF-KEY GUARD, DEDUP).

use crate::key_store_types::{KeyStoreMetadata, StoredKeyPair, StoredPeerKey};
use anyhow::{anyhow, Result};
use std::fs;
use std::path::Path;

/// Имя файла keypair аккаунта (X25519+ML-KEM).
pub const KEY_FILE: &str = "keypair.json";
/// Имя файла peer-ключей (контакты). JSON-массив `StoredPeerKey`.
pub const PEER_KEYS_FILE: &str = "peer_keys.json";

/// `mkdir -p keys_dir` с 0700 (best-effort на non-Unix).
fn ensure_keys_dir(keys_dir: &Path) -> Result<()> {
    fs::create_dir_all(keys_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(keys_dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Записать `path` с правами 0600 (best-effort на non-Unix).
fn write_file_0600(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// RAW-ядро сохранения keypair (без guard). Каталог 0700, файл 0600.
pub fn save_keypair_at(keys_dir: &Path, keypair: &StoredKeyPair) -> Result<()> {
    ensure_keys_dir(keys_dir)?;
    let path = keys_dir.join(KEY_FILE);
    let json = serde_json::to_string_pretty(keypair)?;
    write_file_0600(&path, json.as_bytes())?;
    Ok(())
}

/// RAW-ядро загрузки keypair (без guard).
///
/// `auto_migrate`: если `true` и у аккаунта legacy (без ML-KEM-пары),
/// генерирует PQ-пару и **писать** обратно — чтобы конверты v2 шли
/// автоматически. Desktop вызывает с `true` (письмо под guard); CLI — с
/// `false` (только читает свою in-memory `CryptoClient`).
pub fn load_keypair_at(keys_dir: &Path, auto_migrate: bool) -> Result<Option<StoredKeyPair>> {
    let path = keys_dir.join(KEY_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path)?;
    let mut keypair: StoredKeyPair = serde_json::from_str(&data)?;
    // PQ-миграция: у аккаунтов, созданных до post-quantum, нет ML-KEM-пары.
    if auto_migrate && (keypair.pq_private_key.is_none() || keypair.pq_public_key.is_none()) {
        let pq = crate::crypto_pq::pq_generate();
        keypair.pq_private_key = Some(pq.seed_hex);
        keypair.pq_public_key = Some(pq.ek_b64);
        let json = serde_json::to_string_pretty(&keypair)?;
        write_file_0600(&path, json.as_bytes())?;
    }
    Ok(Some(keypair))
}

/// RAW-ядро сохранения peer-ключей (без guard). Каталог 0700, файл 0600.
pub fn save_peer_keys_at(keys_dir: &Path, keys: &[StoredPeerKey]) -> Result<()> {
    ensure_keys_dir(keys_dir)?;
    let path = keys_dir.join(PEER_KEYS_FILE);
    let json = serde_json::to_string_pretty(keys)?;
    write_file_0600(&path, json.as_bytes())?;
    Ok(())
}

/// RAW-ядро загрузки peer-ключей (без guard). Нет файла → пустой вектор.
pub fn load_peer_keys_at(keys_dir: &Path) -> Result<Vec<StoredPeerKey>> {
    let path = keys_dir.join(PEER_KEYS_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)?;
    let keys: Vec<StoredPeerKey> = serde_json::from_str(&data)?;
    Ok(keys)
}

/// RAW-ядро добавления peer-ключа (без guard; вызывается внутри захвата).
/// Адресная проверка + SELF-KEY GUARD + DEDUP — единая точка ВСЕХ записей
/// (invite-accept, contact accept, manual paste). Логика идентична desktop.
pub fn add_peer_key_at(keys_dir: &Path, key: StoredPeerKey) -> Result<()> {
    // ADDRESS GATE: peer_keys индексируется по email — только настоящие
    // адреса. Строки вида fp:<fingerprint> (account-namespace) создавали
    // «контакт-отпечаток» в списке (живой баг 06.10.2026).
    let em = key.email.trim();
    if !em.contains('@') || em.to_lowercase().starts_with("fp:") {
        return Err(anyhow!(
            "peer key address must be an email, got: {}",
            key.email
        ));
    }
    // SELF-KEY GUARD: сохранение своего публичного ключа как peer-ключа
    // молча ломает ECDH в обе стороны. Read-only (auto_migrate=false) —
    // миграция при чтении не должна писать в момент add_peer_key.
    if let Some(kp) = load_keypair_at(keys_dir, false)? {
        if kp.public_key == key.public_key {
            return Err(anyhow!("Refusing to save your own public key as a peer key"));
        }
    }
    let mut keys = load_peer_keys_at(keys_dir)?;
    // DEDUP (IDENTITY = pubkey; EMAIL = транспорт): тот же pubkey под другим
    // email = собеседник сменил почту → переименовываем, а не создаём дубль.
    if let Some(idx) = keys.iter().position(|k| k.public_key == key.public_key) {
        if !keys[idx].email.eq_ignore_ascii_case(&key.email) {
            keys[idx].email = key.email.clone();
            keys[idx].label = key.label;
            // PQ: новый ek обновляет; None НЕ трогает существующий.
            if key.pq_public_key.is_some() {
                keys[idx].pq_public_key = key.pq_public_key;
            }
            save_peer_keys_at(keys_dir, &keys)?;
            return Ok(());
        }
        // email совпадает — падаем через вниз (обновление полей).
    }
    if let Some(existing) = keys.iter_mut().find(|k| k.email == key.email) {
        existing.public_key = key.public_key;
        existing.label = key.label;
        if key.pq_public_key.is_some() {
            existing.pq_public_key = key.pq_public_key;
        }
    } else {
        keys.push(key);
    }
    save_peer_keys_at(keys_dir, &keys)
}

/// RAW-ядро удаления peer-ключа по email (без guard). true, если удалил.
pub fn remove_peer_key_at(keys_dir: &Path, email: &str) -> Result<bool> {
    let mut keys = load_peer_keys_at(keys_dir)?;
    let before = keys.len();
    keys.retain(|k| k.email != email);
    let removed = keys.len() < before;
    if removed {
        save_peer_keys_at(keys_dir, &keys)?;
    }
    Ok(removed)
}

/// RAW-ядро удаления keypair + peer_keys (без guard).
/// `channel_signing.json` удаляет вызывающий (ADR-002 — отдельный файл).
pub fn delete_all_keys_at(keys_dir: &Path) -> Result<()> {
    let _ = fs::remove_file(keys_dir.join(KEY_FILE));
    let _ = fs::remove_file(keys_dir.join(PEER_KEYS_FILE));
    Ok(())
}

/// RAW-ядро удаления только peer_keys (без guard). keypair не трогается
/// («Удалить аккаунт», RuStore §5.4 — ключ владельца жив).
pub fn delete_all_peer_keys_at(keys_dir: &Path) -> Result<()> {
    let _ = fs::remove_file(keys_dir.join(PEER_KEYS_FILE));
    Ok(())
}

/// Метаданные хранилища (version/key_count/last_modified).
pub fn get_store_metadata_at(keys_dir: &Path) -> Result<Option<KeyStoreMetadata>> {
    let key_path = keys_dir.join(KEY_FILE);
    let peer_path = keys_dir.join(PEER_KEYS_FILE);

    if !key_path.exists() && !peer_path.exists() {
        return Ok(None);
    }

    let peers = load_peer_keys_at(keys_dir)?;
    let key_count = if key_path.exists() {
        1 + peers.len()
    } else {
        peers.len()
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

/// Сериализовать keypair + peer_keys в backup-строку (формат Desktop export).
/// PQ-миграция применяется (auto_migrate=true) — экспорт всегда содержит
/// актуальные PQ-ключи.
pub fn export_keys_at(keys_dir: &Path) -> Result<String> {
    let keypair = load_keypair_at(keys_dir, true)?
        .ok_or_else(|| anyhow!("No keypair found"))?;
    let peer_keys = load_peer_keys_at(keys_dir)?;
    let export = serde_json::json!({
        "version": 1,
        "keypair": keypair,
        "peer_keys": peer_keys,
        "exported_at": chrono::Utc::now().to_rfc3339(),
    });
    Ok(serde_json::to_string_pretty(&export)?)
}

/// RAW-ядро импорта backup-строки (формат `export_keys_at`).
/// Перезаписывает keypair и peer_keys (bulk restore после смены/переноса
/// устройства). `last_modified` берётся из файловой метадаты `keypair.json`
/// (или `peer_keys.json`), что сохраняет реальное время последней записи;
/// при отсутствии файлов — `Utc::now`.
pub fn import_keys_at(keys_dir: &Path, json_data: &str) -> Result<KeyStoreMetadata> {
    let data: serde_json::Value = serde_json::from_str(json_data)?;
    let version = data["version"].as_u64().unwrap_or(1) as u32;

    let mut key_count = 0;
    ensure_keys_dir(keys_dir)?;

    if let Some(kp) = data.get("keypair") {
        let keypair: StoredKeyPair = serde_json::from_value(kp.clone())?;
        save_keypair_at(keys_dir, &keypair)?;
        key_count += 1;
    }

    if let Some(peers) = data.get("peer_keys").and_then(|v| v.as_array()) {
        let peer_keys: Vec<StoredPeerKey> = peers
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        save_peer_keys_at(keys_dir, &peer_keys)?;
        key_count += peer_keys.len();
    }

    let key_path = keys_dir.join(KEY_FILE);
    let peer_path = keys_dir.join(PEER_KEYS_FILE);
    let last_modified = fs::metadata(&key_path)
        .or_else(|_| fs::metadata(&peer_path))
        .and_then(|m| m.modified())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

    Ok(KeyStoreMetadata {
        version,
        key_count,
        last_modified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn kp_legacy() -> StoredKeyPair {
        StoredKeyPair {
            public_key: "abcd1234".to_string(),
            private_key: "ef567890".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            pq_private_key: None,
            pq_public_key: None,
        }
    }
    fn peer(email: &str, pubkey: &str) -> StoredPeerKey {
        StoredPeerKey {
            email: email.to_string(),
            public_key: pubkey.to_string(),
            label: None,
            added_at: "2024-01-01T00:00:00Z".to_string(),
            pq_public_key: None,
        }
    }

    #[test]
    fn save_load_migrates_pq() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        let loaded = load_keypair_at(dir.path(), true).unwrap().unwrap();
        assert_eq!(loaded.public_key, "abcd1234");
        assert!(loaded.pq_private_key.is_some());
        assert!(loaded.pq_public_key.is_some());
        let again = load_keypair_at(dir.path(), true).unwrap().unwrap();
        assert_eq!(loaded.pq_private_key, again.pq_private_key);
        assert_eq!(loaded.pq_public_key, again.pq_public_key);
    }
    #[test]
    fn load_false_does_not_migrate() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        assert!(load_keypair_at(dir.path(), false).unwrap().unwrap().pq_private_key.is_none());
    }
    #[test]
    fn load_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        assert!(load_keypair_at(dir.path(), false).unwrap().is_none());
    }

    #[test]
    fn add_peer_rejects_non_email() {
        let dir = TempDir::new().unwrap();
        for bad in ["fp:ab:cd", "not-an-email", ""] {
            let err = add_peer_key_at(dir.path(), peer(bad, "deadbeef")).unwrap_err();
            assert!(err.to_string().contains("must be an email"), "отказ {bad:?}: {err}");
        }
        assert!(load_peer_keys_at(dir.path()).unwrap().is_empty());
    }
    #[test]
    fn add_peer_rejects_own_pubkey() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        let own = StoredPeerKey {
            email: "peer@example.com".into(), public_key: "abcd1234".into(),
            ..peer("peer@example.com", "abcd1234")
        };
        let err = add_peer_key_at(dir.path(), own).unwrap_err();
        assert!(err.to_string().contains("own public key"));
        assert!(load_peer_keys_at(dir.path()).unwrap().is_empty());
    }
    #[test]
    fn add_peer_dedup_pubkey_email_and_pq() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        add_peer_key_at(dir.path(), peer("same@x", "aabbccdd")).unwrap();
        assert_eq!(load_peer_keys_at(dir.path()).unwrap().len(), 1);
        let pq_up = StoredPeerKey {
            email: "same@x".into(), public_key: "aabbccdd".into(),
            pq_public_key: Some("pq-new".into()), ..peer("same@x", "aabbccdd")
        };
        add_peer_key_at(dir.path(), pq_up).unwrap();
        let keys = load_peer_keys_at(dir.path()).unwrap();
        assert_eq!(keys.len(), 1, "no dups");
        assert_eq!(keys[0].pq_public_key.as_deref(), Some("pq-new"));
        add_peer_key_at(dir.path(), peer("same@x", "aabbccdd")).unwrap();
        assert_eq!(load_peer_keys_at(dir.path()).unwrap()[0].pq_public_key.as_deref(), Some("pq-new"));
    }

    #[test]
    fn export_import_roundtrip() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        add_peer_key_at(dir.path(), peer("a@x", "ffff0000")).unwrap();
        let json = export_keys_at(dir.path()).unwrap();

        // Импорт в чистый каталог — обе категории восстанавливаются.
        let dir2 = TempDir::new().unwrap();
        let meta = import_keys_at(dir2.path(), &json).unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.key_count, 2);
        let kp = load_keypair_at(dir2.path(), false).unwrap().unwrap();
        assert_eq!(kp.public_key, "abcd1234");
        let peers = load_peer_keys_at(dir2.path()).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].email, "a@x");
        assert_eq!(peers[0].public_key, "ffff0000");
    }

    #[test]
    fn import_keys_no_keypair_errors_on_count_only() {
        let dir = TempDir::new().unwrap();
        let json = r#"{"version":1,"peer_keys":[{"email":"a@x","public_key":"ffff0000","added_at":"t"}]}"#;
        let meta = import_keys_at(dir.path(), json).unwrap();
        assert_eq!(meta.key_count, 1);
        assert!(load_peer_keys_at(dir.path()).unwrap().len() == 1);
        assert!(load_keypair_at(dir.path(), false).unwrap().is_none());
    }

    #[test]
    fn remove_peer_key() {
        let dir = TempDir::new().unwrap();
        add_peer_key_at(dir.path(), peer("a@x", "ffff0000")).unwrap();
        assert!(remove_peer_key_at(dir.path(), "a@x").unwrap());
        assert!(load_peer_keys_at(dir.path()).unwrap().is_empty());
        assert!(!remove_peer_key_at(dir.path(), "nope@n").unwrap());
    }
    #[test]
    fn delete_keys_isolates_peers_and_keypair() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        add_peer_key_at(dir.path(), peer("a@x", "ffff0000")).unwrap();
        delete_all_peer_keys_at(dir.path()).unwrap();
        assert!(load_keypair_at(dir.path(), false).unwrap().is_some());
        assert!(load_peer_keys_at(dir.path()).unwrap().is_empty());
    }
    #[test]
    fn delete_all_keys_removes_both() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        add_peer_key_at(dir.path(), peer("a@x", "ffff0000")).unwrap();
        delete_all_keys_at(dir.path()).unwrap();
        assert!(load_keypair_at(dir.path(), false).unwrap().is_none());
        assert!(load_peer_keys_at(dir.path()).unwrap().is_empty());
        assert!(delete_all_keys_at(dir.path()).is_ok());
    }
    #[test]
    fn export_roundtrip() {
        let dir = TempDir::new().unwrap();
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        add_peer_key_at(dir.path(), peer("a@x", "ffff0000")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&export_keys_at(dir.path()).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["keypair"]["public_key"], "abcd1234");
        assert!(v["keypair"]["pq_private_key"].is_string());
        assert_eq!(v["peer_keys"][0]["email"], "a@x");
    }
    #[test]
    fn export_no_keypair_errors() {
        let dir = TempDir::new().unwrap();
        assert!(export_keys_at(dir.path()).is_err());
    }
    #[test]
    fn metadata_reflects_count() {
        let dir = TempDir::new().unwrap();
        assert!(get_store_metadata_at(dir.path()).unwrap().is_none());
        save_keypair_at(dir.path(), &kp_legacy()).unwrap();
        add_peer_key_at(dir.path(), peer("a@x", "ffff0000")).unwrap();
        let meta = get_store_metadata_at(dir.path()).unwrap().unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.key_count, 2);
    }

    /// JSON-формат, который `import_keys_at` принимает — тот же, что
    /// выпускает `export_keys_at`. roundtrip: export → import → verify files.
    fn export_json(dir: &Path) -> String {
        save_keypair_at(dir, &kp_legacy()).unwrap();
        add_peer_key_at(dir, peer("a@x", "ffff0000")).unwrap();
        add_peer_key_at(dir, peer("b@x", "00112233")).unwrap();
        export_keys_at(dir).unwrap()
    }

    #[test]
    fn import_keys_roundtrip_from_export() {
        let src = TempDir::new().unwrap();
        let json = export_json(src.path());

        let dst = TempDir::new().unwrap();
        let meta = import_keys_at(dst.path(), &json).unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.key_count, 3); // 1 keypair + 2 peer keys

        // keypair восстановлен.
        let kp = load_keypair_at(dst.path(), false).unwrap().unwrap();
        assert_eq!(kp.public_key, "abcd1234");

        // peer_keys восстановлены и сохраняются в peer_keys.json.
        let peers = load_peer_keys_at(dst.path()).unwrap();
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].email, "a@x");
        assert_eq!(peers[1].email, "b@x");
    }

    #[test]
    fn import_keys_is_idempotent() {
        let src = TempDir::new().unwrap();
        let json = export_json(src.path());

        let dst = TempDir::new().unwrap();
        // Повторный импорт не должен падать и не должен дублировать peer_keys
        // (save_peer_keys_at перезаписывает массив целиком).
        let meta1 = import_keys_at(dst.path(), &json).unwrap();
        let meta2 = import_keys_at(dst.path(), &json).unwrap();
        assert_eq!(meta1.key_count, meta2.key_count);

        let peers = load_peer_keys_at(dst.path()).unwrap();
        assert_eq!(peers.len(), 2); // без дубликатов
    }
}
