//! Presence ledger — M2.2 (presence bridge).
//!
//! Хронологический реестр heartbeat `{presence:1, ts}` от пиров.
//! JSON (~/.vault/presence.json): `HashMap<String, Vec<PresenceHeartbeat>>`
//! ключ email, ts monotonic. Персистентность для offline-режима:
//! Desktop видит «был онлайн N мин назад» без IMAP-скана.
//!
//! Parity с JS presence.js ingestSignal (в JS реализовано в ctx.state).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const PRESENCE_FILE: &str = "presence.json";

fn get_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault"))
}

fn get_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("VAULT_PRESENCE_FILE") {
        return Ok(PathBuf::from(p));
    }
    Ok(get_dir()?.join(PRESENCE_FILE))
}

/// One heartbeat record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresenceHeartbeat {
    pub email: String,
    pub ts: i64,        // unix ms (как JS Date.now())
    pub source: String, // email/uid конверта (дедуп heartbeat-спама)
}

pub type PresenceStore = HashMap<String, Vec<PresenceHeartbeat>>;

/// Load full presence ledger.
pub fn load_presence() -> Result<PresenceStore> {
    let path = get_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| anyhow!("read presence: {}", e))?;
    Ok(serde_json::from_str(&data).unwrap_or_default())
}

/// Persist presence ledger.
pub fn save_presence(store: &PresenceStore) -> Result<()> {
    let path = get_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data =
        serde_json::to_string_pretty(store).map_err(|e| anyhow!("serialize presence: {}", e))?;
    fs::write(&path, data).map_err(|e| anyhow!("write presence: {}", e))?;
    Ok(())
}

/// Ingest a heartbeat (idempotent per source envelope).
/// Дедуп и форма ключа — в ядре (`vault::identity`, `vault::presence`): ключ
/// реестра обязан быть нормальной формой адреса, иначе `Bob@X` и `bob@x` —
/// два реестра об одном человеке, а пустой адрес не собеседник.
pub fn ingest_heartbeat(email: &str, ts: i64, source: &str) -> Result<()> {
    let Some(key) = vault_client::vault::identity::ledger_key(email) else {
        return Ok(());
    };
    let mut store = load_presence()?;
    let entry = store.entry(key.clone()).or_default();
    let known = vault_client::vault::presence::heartbeat_known(
        entry.iter().map(|h| (h.source.as_str(), h.ts)),
        source,
        ts,
    );
    if !known {
        entry.push(PresenceHeartbeat {
            email: key,
            ts,
            source: source.to_string(),
        });
    }
    save_presence(&store)
}

/// Last-seen timestamp for a peer (max ts), or None.
pub fn last_seen(email: &str) -> Result<Option<i64>> {
    let store = load_presence()?;
    let key = vault_client::vault::identity::ledger_key(email);
    Ok(key
        .as_deref()
        .and_then(|k| store.get(k))
        .and_then(|v| vault_client::vault::presence::latest_ts(v.iter().map(|h| &h.ts))))
}

/// Prune heartbeats older than `cutoff_ms` (unix ms).
pub fn prune_older_than(cutoff_ms: i64) -> Result<usize> {
    let mut store = load_presence()?;
    let mut removed = 0usize;
    for (_email, v) in store.iter_mut() {
        let len_before = v.len();
        v.retain(|h| vault_client::vault::presence::survives_prune(h.ts, cutoff_ms));
        removed += len_before - v.len();
    }
    if removed > 0 {
        save_presence(&store)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Isolate env per-test: redirect VAULT_PRESENCE_FILE, restore после.
    ///
    /// Замок — ЕДИНЫЙ на крейт (`crate::env_test_guard`), а не `ENV_MUTEX`:
    /// тот защищает `set_env_safe` раннера и сериализует только внутри себя,
    /// поэтому редиректы остальных модулей проходили мимо него и перебивали
    /// этот (25.10, мерит `gate:test-isolation`). Внутрь env ходим через
    /// `crate::set_env_safe`: порядок захвата (сначала тестовый замок, потом
    /// `ENV_MUTEX` внутри него) один на весь крейт, рекурсии нет.
    fn with_tmp<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::env_test_guard();
        let path = std::env::temp_dir().join(format!(
            "m22_presence-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let prev = std::env::var("VAULT_PRESENCE_FILE").ok();
        crate::set_env_safe("VAULT_PRESENCE_FILE", &path);
        let result = f();
        let _ = std::fs::remove_file(&path);
        match prev {
            Some(v) => crate::set_env_safe("VAULT_PRESENCE_FILE", &v),
            None => std::env::remove_var("VAULT_PRESENCE_FILE"),
        }
        result
    }

    #[test]
    fn test_ingest_and_last_seen() {
        with_tmp(|| {
            assert!(ingest_heartbeat("bob@x", 1000, "uid1").is_ok());
            assert!(ingest_heartbeat("bob@x", 2000, "uid2").is_ok());
            assert_eq!(last_seen("bob@x").unwrap(), Some(2000));
            // dedup same source+ts — no-op
            assert!(ingest_heartbeat("bob@x", 2000, "uid2").is_ok());
            assert_eq!(load_presence().unwrap().get("bob@x").unwrap().len(), 2);
        });
    }

    #[test]
    fn test_prune_older_than() {
        with_tmp(|| {
            ingest_heartbeat("a@x", 100, "s1").unwrap();
            ingest_heartbeat("b@x", 200, "s2").unwrap();
            // Граница включительная: ts == cutoff остаётся.
            let n = prune_older_than(150).unwrap();
            assert_eq!(n, 1);
            let store = load_presence().unwrap();
            assert!(store.get("a@x").unwrap().is_empty());
            assert_eq!(store.get("b@x").unwrap().len(), 1);
        });
    }

    #[test]
    fn test_case_and_space_variants_share_one_ledger() {
        with_tmp(|| {
            // Дефект до переноса: ключом был raw email, и `Bob@X` заводил
            // второй реестр, в котором `last_seen("bob@x")` ничего не видел.
            ingest_heartbeat("Bob@X ", 1000, "uid1").unwrap();
            ingest_heartbeat("bob@x", 2000, "uid2").unwrap();
            assert_eq!(last_seen("BOB@X").unwrap(), Some(2000));
            assert_eq!(load_presence().unwrap().len(), 1);
            // Пустой адрес не собеседник: heartbeat «ни от кого» не заводит
            // собственную запись.
            ingest_heartbeat("   ", 3000, "uid3").unwrap();
            assert_eq!(load_presence().unwrap().len(), 1);
        });
    }

    /// Форма пути без редиректа сверяется с ЛИТЕРАЛОМ: проба, берущая путь из
    /// тех же констант, не отличит «путь собран правильно» от «константы
    /// переименованы».
    #[test]
    fn path_without_redirect_is_the_vault_layer_file() {
        let _guard = crate::env_test_guard();
        let prev = std::env::var("VAULT_PRESENCE_FILE").ok();
        std::env::remove_var("VAULT_PRESENCE_FILE");
        let home = dirs::home_dir().expect("дом определён");
        let expected = home.join(".vault").join("presence.json");
        let got = get_path();
        match prev {
            Some(v) => crate::set_env_safe("VAULT_PRESENCE_FILE", &v),
            None => std::env::remove_var("VAULT_PRESENCE_FILE"),
        }
        assert_eq!(got.unwrap(), expected, "реестр лежит не в слое .vault");
    }

    #[test]
    fn redirect_points_the_ledger_at_the_exact_file() {
        let _guard = crate::env_test_guard();
        let path = std::env::temp_dir().join(format!("m22_presence-redirect-{}.json", std::process::id()));
        let prev = std::env::var("VAULT_PRESENCE_FILE").ok();
        crate::set_env_safe("VAULT_PRESENCE_FILE", &path);
        let got = get_path();
        match prev {
            Some(v) => crate::set_env_safe("VAULT_PRESENCE_FILE", &v),
            None => std::env::remove_var("VAULT_PRESENCE_FILE"),
        }
        assert_eq!(got.unwrap(), path, "редирект проигнорирован");
    }

    #[test]
    fn absent_ledger_is_an_empty_store_not_an_error() {
        with_tmp(|| {
            let store = load_presence().expect("файла ещё нет — это пустой реестр, не ошибка");
            assert!(store.is_empty());
        });
    }

    #[test]
    fn broken_ledger_reads_as_an_empty_store() {
        with_tmp(|| {
            // Fail-open зафиксирован как контракт: реестр присутствия расходный,
            // а ошибка здесь означала бы сбой синхронизации из-за оборванной
            // записи. Мутация «ожидаем валидный JSON» ловится этой пробой.
            fs::write(get_path().unwrap(), "это не json").unwrap();
            assert!(load_presence().unwrap().is_empty());
            ingest_heartbeat("bob@x", 1000, "uid1").unwrap();
            assert_eq!(last_seen("bob@x").unwrap(), Some(1000));
        });
    }

    #[test]
    fn nested_ledger_directory_is_created() {
        let _guard = crate::env_test_guard();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("m22_presence-deep-{}-{}", std::process::id(), stamp));
        let path = root.join("nest").join("presence.json");
        let prev = std::env::var("VAULT_PRESENCE_FILE").ok();
        crate::set_env_safe("VAULT_PRESENCE_FILE", &path);
        let ingested = ingest_heartbeat("bob@x", 1000, "uid1");
        let written = path.is_file();
        let _ = fs::remove_dir_all(&root);
        match prev {
            Some(v) => crate::set_env_safe("VAULT_PRESENCE_FILE", &v),
            None => std::env::remove_var("VAULT_PRESENCE_FILE"),
        }
        assert!(ingested.is_ok(), "heartbeat в новый каталог не принят: {ingested:?}");
        assert!(written, "реестр не записан по указанному пути");
    }

    #[test]
    fn stored_record_keeps_the_normalized_address() {
        with_tmp(|| {
            ingest_heartbeat("Bob@X ", 1000, "uid1").unwrap();
            let store = load_presence().unwrap();
            let entry = store.get("bob@x").expect("ключ реестра нормализован");
            assert_eq!(entry[0].email, "bob@x", "в записи остался сырой адрес");
        });
    }

    #[test]
    fn same_letter_at_a_later_clock_is_a_new_sighting() {
        with_tmp(|| {
            // Одно письмо может нести два heartbeat с разными часами
            // (ретрансляция). Дедуп по одному лишь источнику съедает
            // «был онлайн позже» и реестр встаёт на первую метку.
            ingest_heartbeat("bob@x", 1000, "uid1").unwrap();
            ingest_heartbeat("bob@x", 2100, "uid1").unwrap();
            assert_eq!(load_presence().unwrap().get("bob@x").unwrap().len(), 2);
            assert_eq!(last_seen("bob@x").unwrap(), Some(2100));
        });
    }
}
