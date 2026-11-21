//! Sfera — оболочка Tauri (десктоп и мобильные). Логика целиком в Rust:
//! оболочка только собирает состояние, регистрирует команды и отдаёт UI.
//!
//! Идентичность — **ключ устройства Sfera**, а не копия ключа мессенджера:
//! ADR-006 §8 запрещает копировать приватный ключ аккаунта. Устройство
//! создаёт свой Ed25519-ключ при первом запуске и хранит его в app data с
//! правами 0600. Связывание с аккаунтом (сертификат устройства) — отдельный
//! протокол `vault://link-sfera`; до него интерфейс честно показывает
//! «не связан».

use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use social_app::{Identity, SferaApp};
use social_ffi::SferaState;
use social_sync::{Quota, RetryPolicy};
use storage_local::LocalStore;
use tauri::Manager;

const IDENTITY_FILE: &str = "identity.json";
/// Принятый bundle связывания (ADR-009 §4). Только публичные данные.
const LINK_FILE: &str = "sfera_link.json";
/// MVP-квота outbox: 60 секунд, 10 МБ, 60 элементов. Серверные лимиты
/// придут отдельным контрактом, клиент их себе не поднимает.
const QUOTA_WINDOW_SECS: u64 = 60;
const QUOTA_BYTES: u64 = 10 * 1024 * 1024;
const QUOTA_ITEMS: u64 = 60;

#[derive(Serialize, Deserialize)]
struct IdentityFile {
    v: u8,
    seed: String,
}

/// Состояние связывания с аккаунтом (ADR-006 §8, ADR-009 §4).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LinkStatus {
    pub linked: bool,
    /// Канонический ID аккаунта — отпечаток Ed25519-ключа подписи.
    pub account_fp: Option<String>,
    /// X25519-отпечаток остаётся в деталях как ключ шифрования.
    pub encryption_fp: Option<String>,
    pub seq: Option<u64>,
}

fn link_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    Ok(app.path().app_data_dir()?.join(LINK_FILE))
}

#[tauri::command]
fn social_link_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<LinkStatus, String> {
    let path = link_path(&app).map_err(|e| format!("link path: {e}"))?;
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(LinkStatus { linked: false, account_fp: None, encryption_fp: None, seq: None });
    };
    let bundle: social_link::LinkBundle =
        serde_json::from_str(&text).map_err(|e| format!("link file: {e}"))?;
    // Проверяем цепочку при каждом чтении: подменённый файл не станет «связанным».
    bundle.verify(0).map_err(|e| format!("link verify: {e:?}"))?;
    Ok(LinkStatus {
        linked: true,
        account_fp: Some(bundle.payload.account.fp.as_str().to_string()),
        encryption_fp: Some(bundle.payload.device_cert.device_pub_key().to_string()),
        seq: Some(bundle.payload.seq),
    })
}

/// Принять QR/bundle из мессенджера. Сохраняем только после проверки цепочки.
#[tauri::command]
fn social_link_accept<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    uri: String,
) -> Result<LinkStatus, String> {
    let bundle = social_link::from_uri(&uri).map_err(|e| format!("link uri: {e:?}"))?;
    bundle.verify(0).map_err(|e| format!("link verify: {e:?}"))?;
    let path = link_path(&app).map_err(|e| format!("link path: {e}"))?;
    std::fs::write(&path, serde_json::to_vec(&bundle).map_err(|e| e.to_string())?)
        .map_err(|e| format!("link write: {e}"))?;
    social_link_status(app)
}

fn shell_commands_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![social_link_status, social_link_accept]
}

fn invalid(msg: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg.into())
}

fn is_seed_hex(seed: &str) -> bool {
    seed.len() == 64 && seed.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Прочитать ключ устройства или создать его при первом запуске.
/// Файл пишется атомарно (tmp → rename) и только для владельца (0600).
fn seed_at(dir: &Path) -> Result<String, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(IDENTITY_FILE);
    if path.exists() {
        let doc: IdentityFile = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        if doc.v != 1 || !is_seed_hex(&doc.seed) {
            return Err(invalid("identity.json: unsupported version or bad seed").into());
        }
        return Ok(doc.seed);
    }

    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    let doc = IdentityFile { v: 1, seed: hex::encode(seed) };
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(&doc)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(doc.seed)
}

/// Seed устройства: `SFERA_SEED` для разработки, иначе файл в app data.
fn seed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(seed) = std::env::var("SFERA_SEED") {
        return Ok(seed);
    }
    Ok(seed_at(&app.path().app_data_dir()?)?)
}

fn build_state<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<SferaState, Box<dyn std::error::Error>> {
    let identity = Identity::from_seed(seed(app)?)?;
    let store = LocalStore::new(app.path().app_data_dir()?.join("blobs"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let core = SferaApp::new(
        identity,
        Arc::new(store),
        RetryPolicy::default(),
        Quota::new(QUOTA_WINDOW_SECS, QUOTA_BYTES, QUOTA_ITEMS, now),
    );
    Ok(SferaState::new(core, None))
}

/// Один `invoke_handler` на приложение: Tauri допускает только один, поэтому
/// команда маршрутизируется в свой крейт по списку, который живёт рядом с
/// самими командами (`handles`).
fn dispatch<R: tauri::Runtime>(invoke: tauri::ipc::Invoke<R>) -> bool {
    let command = invoke.message.command().to_string();
    if command == "social_link_status" {
        shell_commands_handler()(invoke)
    } else if social_ffi_bridge::handles(&command) {
        social_ffi_bridge::social_bridge_commands_handler()(invoke)
    } else if social_ffi_extra::handles(&command) {
        social_ffi_extra::social_extra_commands_handler()(invoke)
    } else {
        social_ffi::social_commands_handler()(invoke)
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = build_state(app.handle())
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(dispatch)
        .run(tauri::generate_context!())
        .expect("error while running Sfera");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = seed_at(dir.path()).unwrap();
        assert!(is_seed_hex(&first));
        let second = seed_at(dir.path()).unwrap();
        assert_eq!(first, second);
        assert!(dir.path().join(IDENTITY_FILE).exists());
    }

    #[test]
    fn broken_identity_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(IDENTITY_FILE),
            r#"{"v":1,"seed":"not-a-seed"}"#,
        )
        .unwrap();
        assert!(seed_at(dir.path()).is_err());
    }

    #[test]
    fn unknown_version_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(IDENTITY_FILE),
            format!(r#"{{"v":2,"seed":"{}"}}"#, "00".repeat(32)),
        )
        .unwrap();
        assert!(seed_at(dir.path()).is_err());
    }
}
