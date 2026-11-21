//! Sfera — оболочка Tauri (десктоп и мобильные). Логика целиком в Rust:
//! оболочка только собирает состояние, регистрирует команды и отдаёт UI.
//!
//! Идентичность не создаётся заново: берётся тот же ключ, что у мессенджера
//! (`~/.vault/keys` или `VAULT_KEYS_DIR`). Если аккаунта на устройстве нет,
//! приложение честно не стартует — новый аккаунт не выдумывается (ADR-006 §1).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use social_app::{Identity, SferaApp};
use social_ffi::SferaState;
use social_sync::{Quota, RetryPolicy};
use storage_local::LocalStore;
use tauri::Manager;

const KEYS_DIR: &str = "keys";
/// MVP-квота outbox: 60 секунд, 10 МБ, 60 элементов. Серверные лимиты
/// придут отдельным контрактом, клиент их себе не поднимает.
const QUOTA_WINDOW_SECS: u64 = 60;
const QUOTA_BYTES: u64 = 10 * 1024 * 1024;
const QUOTA_ITEMS: u64 = 60;

fn keys_dir() -> Result<PathBuf, std::io::Error> {
    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {
        return Ok(PathBuf::from(p));
    }
    dirs::home_dir()
        .map(|home| home.join(".vault").join(KEYS_DIR))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "cannot determine home directory"))
}

/// Seed подписи: `SFERA_SEED` для разработки, иначе общий key store Vault.
fn seed() -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(seed) = std::env::var("SFERA_SEED") {
        return Ok(seed);
    }
    let keypair = vault_core::key_store::load_keypair_at(&keys_dir()?, false)?
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no Vault account on this device: sign in to the messenger first",
            )
        })?;
    Ok(keypair.private_key)
}

fn build_state<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<SferaState, Box<dyn std::error::Error>> {
    let identity = Identity::from_seed(seed()?)?;
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
    if social_ffi_bridge::handles(&command) {
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
    fn keys_dir_honours_env_override() {
        std::env::set_var("VAULT_KEYS_DIR", "/tmp/sfera-test-keys");
        assert_eq!(keys_dir().unwrap(), PathBuf::from("/tmp/sfera-test-keys"));
        std::env::remove_var("VAULT_KEYS_DIR");
    }
}
