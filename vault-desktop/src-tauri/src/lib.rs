// Android library entry point — re-exports main.rs for Tauri cdylib
mod credential_store;
mod crypto;
mod email;
mod key_store;
mod storage;
mod groups;
mod history_store;

use credential_store::StoredCredentials;
use storage::sqlite::Storage;

use crypto::{CryptoState, KeyPair};
use email::{EmailClient, EmailConfig, EmailMessage};
use key_store::{StoredKeyPair, StoredPeerKey, KeyStoreMetadata};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State};
use tokio::sync::Mutex;

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn generate_keypair() -> KeyPair {
    crypto::generate_keypair_cmd()
}

#[tauri::command]
fn encrypt_message(
    plaintext: String,
    private_key: String,
    peer_public_key: Option<String>,
) -> Result<String, String> {
    crypto::encrypt_cmd(&plaintext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_message(
    ciphertext: String,
    private_key: String,
    peer_public_key: Option<String>,
) -> Result<String, String> {
    crypto::decrypt_cmd(&ciphertext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn encrypt_vault_message(
    plaintext: String,
    private_key: String,
    peer_public_key: Option<String>,
) -> Result<String, String> {
    crypto::encrypt_vault_cmd(&plaintext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_vault_message(
    ciphertext: String,
    private_key: String,
    peer_public_key: Option<String>,
) -> Result<String, String> {
    crypto::decrypt_vault_cmd(&ciphertext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, icon_id: String) -> Result<(), String> {
    let png: &[u8] = match icon_id.as_str() {
        "door" => include_bytes!("../icons/vault_icon_vault-door.png"),
        "envelope" => include_bytes!("../icons/vault_icon_vault-envelope.png"),
        "keyhole" => include_bytes!("../icons/vault_icon_vault-keyhole.png"),
        "letter" => include_bytes!("../icons/vault_icon_vault-letter.png"),
        "shield" => include_bytes!("../icons/vault_icon_vault-shield.png"),
        _ => return Err("unknown icon".to_string()),
    };

    let image = tauri::image::Image::from_bytes(png).map_err(|e| e.to_string())?;
    let win = app.get_webview_window("main").ok_or("no window")?;
    win.set_icon(image).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_fingerprint(public_key: String) -> Result<String, String> {
    crypto::fingerprint_cmd(&public_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_my_keypair(public_key: String, private_key: String) -> Result<(), String> {
    let keypair = StoredKeyPair {
        public_key,
        private_key,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    key_store::save_keypair(&keypair).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_my_keypair() -> Result<Option<StoredKeyPair>, String> {
    key_store::load_keypair().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_peer_key(email: String, public_key: String, label: Option<String>) -> Result<(), String> {
    let key = StoredPeerKey {
        email,
        public_key,
        label,
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    key_store::add_peer_key(key).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_peer_keys() -> Result<Vec<StoredPeerKey>, String> {
    key_store::load_peer_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_peer_key(email: String) -> Result<bool, String> {
    key_store::remove_peer_key(&email).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_keys() -> Result<String, String> {
    key_store::export_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn import_keys(json_data: String) -> Result<KeyStoreMetadata, String> {
    key_store::import_keys(&json_data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_key_store_metadata() -> Result<Option<KeyStoreMetadata>, String> {
    key_store::get_store_metadata().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_all_keys() -> Result<(), String> {
    key_store::delete_all_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

// --- Saved mailbox credentials (encrypted on device, auto-login on start) ---

#[tauri::command]
fn save_credentials(
    email: String,
    password: String,
    imap_server: String,
    imap_port: u16,
    smtp_server: String,
    smtp_port: u16,
) -> Result<(), String> {
    let creds = StoredCredentials {
        email,
        password,
        imap_server,
        imap_port,
        smtp_server,
        smtp_port,
        saved_at: chrono::Utc::now().to_rfc3339(),
    };
    credential_store::save_credentials(&creds).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_credentials() -> Result<Option<StoredCredentials>, String> {
    credential_store::load_credentials().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_credentials() -> Result<bool, String> {
    credential_store::delete_credentials().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

#[tauri::command]
fn encrypt_symmetric(plaintext: String, key: String) -> Result<String, String> {
    crypto::encrypt_symmetric_cmd(&plaintext, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_symmetric(ciphertext: String, key: String) -> Result<String, String> {
    crypto::decrypt_symmetric_cmd(&ciphertext, &key).map_err(|e| e.to_string())
}

/// Holds the live IMAP/SMTP session between Tauri command calls.
pub struct EmailState(pub Mutex<Option<EmailClient>>);

/// Результат инкрементального фетча: новые письма + обновлённые курсоры.
#[derive(Serialize)]
pub struct IncrementalFetchResult {
    pub messages: Vec<EmailMessage>,
    pub cursors: HashMap<String, u32>,
}

impl Default for EmailState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[tauri::command]
async fn email_connect(config: EmailConfig, state: State<'_, EmailState>) -> Result<bool, String> {
    // Disconnect any previous session before opening a new one.
    let mut guard = state.0.lock().await;
    if let Some(mut client) = guard.take() {
        client.disconnect();
    }

    let mut client = EmailClient::new(config);
    client
        .connect_imap()
        .await
        .map_err(|e| format!("Failed to connect: {e}"))?;

    *guard = Some(client);
    Ok(true)
}

#[tauri::command]
async fn email_fetch_messages(
    state: State<'_, EmailState>,
) -> Result<Vec<EmailMessage>, String> {
    let mut guard = state.0.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    match client.fetch_messages().await {
        Ok(v) => Ok(v),
        Err(first_err) => {
            // Gmail обрывает idle-соединения — не требуем от UI релогина,
            // а просто переподключаемся и повторяем один раз.
            client
                .reconnect_imap()
                .await
                .map_err(|r| format!("Reconnect failed: {r} (original: {first_err})"))?;
            client.fetch_messages().await.map_err(|e| e.to_string())
        }
    }
}

/// Инкрементальный фетч: только письма новее per-folder UID-курсоров.
/// Возвращает новые письма + обновлённые курсоры; первый запуск (пустые
/// курсоры) — полный скан последних писем + инициализация курсоров.
#[tauri::command]
async fn email_fetch_incremental(
    state: State<'_, EmailState>,
    cursors: HashMap<String, u32>,
) -> Result<IncrementalFetchResult, String> {
    let mut guard = state.0.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    let to_result = |r: anyhow::Result<(Vec<EmailMessage>, HashMap<String, u32>)>| {
        r.map(|(messages, cursors)| IncrementalFetchResult { messages, cursors })
            .map_err(|e| e.to_string())
    };
    match to_result(client.fetch_newer(&cursors).await) {
        Ok(v) => Ok(v),
        Err(first_err) => {
            client
                .reconnect_imap()
                .await
                .map_err(|r| format!("Reconnect failed: {r} (original: {first_err})"))?;
            to_result(client.fetch_newer(&cursors).await)
        }
    }
}

#[tauri::command]
async fn email_fetch_body(
    uid: String,
    folder: Option<String>,
    state: State<'_, EmailState>,
) -> Result<String, String> {
    let folder = folder.unwrap_or_else(|| "INBOX".to_string());
    let mut guard = state.0.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    match client.fetch_message_body(&uid, &folder).await {
        Ok(v) => Ok(v),
        Err(first_err) => {
            client
                .reconnect_imap()
                .await
                .map_err(|r| format!("Reconnect failed: {r} (original: {first_err})"))?;
            client
                .fetch_message_body(&uid, &folder)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
async fn email_fetch_bodies(
    uids: Vec<String>,
    folder: Option<String>,
    state: State<'_, EmailState>,
) -> Result<Vec<(String, String)>, String> {
    let folder = folder.unwrap_or_else(|| "INBOX".to_string());
    let mut guard = state.0.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    match client.fetch_bodies(&uids, &folder).await {
        Ok(v) => Ok(v),
        Err(first_err) => {
            client
                .reconnect_imap()
                .await
                .map_err(|r| format!("Reconnect failed: {r} (original: {first_err})"))?;
            client
                .fetch_bodies(&uids, &folder)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
async fn email_send(
    to: String,
    subject: String,
    body: String,
    state: State<'_, EmailState>,
) -> Result<bool, String> {
    let mut guard = state.0.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    client
        .send_email(&to, &subject, &body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn email_disconnect(state: State<'_, EmailState>) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if let Some(mut client) = guard.take() {
        client.disconnect();
    }
    Ok(())
}

#[tauri::command]
fn groups_load() -> Result<Vec<groups::Group>, String> {
    groups::load_groups()
        .map(|g| g.into_values().collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_create(name: String, creator: String) -> Result<groups::Group, String> {
    groups::create_group(&name, &creator).map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_add_member(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::add_member(&group_id, &email)
        .map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned().ok_or_else(|| "Group not found".to_string()))
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_remove_member(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::remove_member(&group_id, &email)
        .map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned().ok_or_else(|| "Group not found".to_string()))
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_set_member_role(group_id: String, email: String, role: String) -> Result<groups::Group, String> {
    let role = match role.as_str() {
        "Admin" => groups::GroupRole::Admin,
        "Member" => groups::GroupRole::Member,
        // "Moderator" is a legacy role (removed from the model) — cannot be assigned.
        _ => return Err("Unknown role".to_string()),
    };
    groups::set_member_role(&group_id, &email, role)
        .map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned().ok_or_else(|| "Group not found".to_string()))
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_leave(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::remove_member(&group_id, &email)
        .map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned().ok_or_else(|| "Group not found".to_string()))
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_delete(group_id: String) -> Result<(), String> {
    groups::delete_group(&group_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_get(group_id: String) -> Result<Option<groups::Group>, String> {
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_import(
    group_id: String,
    name: String,
    group_key: String,
    sender: String,
    created_by: Option<String>,
    members: Option<Vec<groups::GroupMember>>,
) -> Result<groups::Group, String> {
    groups::import_group(
        &group_id,
        &name,
        &group_key,
        &sender,
        created_by.as_deref(),
        members.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_set_key(group_id: String, group_key: String) -> Result<(), String> {
    groups::set_group_key(&group_id, &group_key)
        .map_err(|e| e.to_string())
}

// --- Local persistence (Delta Chat-style disk DB, replaces
// localStorage/IndexedDB for durable state) ---
// Всё локальное состояние Vault живёт в sqlite (~/.local/share/
// com.vault.vault/vault.db): история чатов, tombstones, IMAP-курсоры,
// кэш тел, key/value. localStorage больше не источник истины — у него
// квота ~5 МБ (body-cache у Gmail-аккаунтов уже 3–7 МБ) и он ненадёжен
// в WebKitGTK. Никакой зависимости от IndexedDB.

fn open_db() -> Result<Storage, String> {
    Storage::open(None).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_history_save(account: String, chat_key: String, messages_json: String) -> Result<(), String> {
    open_db()?
        .save_history(&account, &chat_key, &messages_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_history_load(account: String, chat_key: String) -> Result<Option<String>, String> {
    open_db()?
        .load_history(&account, &chat_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_history_clear(account: String) -> Result<(), String> {
    open_db()?.clear_history(&account).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_tombstone_add(account: String, msg_id: String, mid: String) -> Result<(), String> {
    open_db()?
        .add_tombstone(&account, &msg_id, &mid)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_tombstones_load(account: String) -> Result<Vec<(String, String)>, String> {
    open_db()?
        .load_tombstones(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_tombstones_clear(account: String) -> Result<(), String> {
    open_db()?
        .clear_tombstones(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_cursors_save(account: String, cursors_json: String) -> Result<(), String> {
    open_db()?
        .save_cursors(&account, &cursors_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_cursors_load(account: String) -> Result<HashMap<String, u32>, String> {
    open_db()?
        .load_cursors(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_set(account: String, cache_key: String, body: String) -> Result<(), String> {
    open_db()?
        .body_cache_set(&account, &cache_key, &body)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_get(account: String, cache_key: String) -> Result<Option<String>, String> {
    open_db()?
        .body_cache_get(&account, &cache_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_clear(account: String) -> Result<(), String> {
    open_db()?
        .body_cache_clear(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_kv_set(account: String, key: String, value: String) -> Result<(), String> {
    open_db()?
        .kv_set(&account, &key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_kv_get(account: String, key: String) -> Result<Option<String>, String> {
    open_db()?
        .kv_get(&account, &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_kv_delete(account: String, key: String) -> Result<(), String> {
    open_db()?
        .kv_delete(&account, &key)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CryptoState::default())
        .manage(EmailState::default())
        .invoke_handler(tauri::generate_handler![
            generate_keypair,
            encrypt_message,
            decrypt_message,
            encrypt_vault_message,
            decrypt_vault_message,
            set_app_icon,
            get_fingerprint,
            save_my_keypair,
            load_my_keypair,
            save_peer_key,
            load_peer_keys,
            remove_peer_key,
            export_keys,
            import_keys,
            get_key_store_metadata,
            delete_all_keys,
            set_close_to_tray,
            get_close_to_tray,
            save_credentials,
            load_credentials,
            delete_credentials,
            encrypt_symmetric,
            decrypt_symmetric,
            email_connect,
            email_fetch_messages,
            email_fetch_incremental,
            email_fetch_body,
            email_fetch_bodies,
            email_send,
            email_disconnect,
            groups_load,
            groups_create,
            groups_add_member,
            groups_remove_member,
            groups_set_member_role,
            groups_leave,
            groups_get,
            groups_import,
            groups_set_key,
            groups_delete,
            db_history_save,
            db_history_load,
            db_history_clear,
            db_tombstone_add,
            db_tombstones_load,
            db_tombstones_clear,
            db_cursors_save,
            db_cursors_load,
            db_body_cache_set,
            db_body_cache_get,
            db_body_cache_clear,
            db_kv_set,
            db_kv_get,
            db_kv_delete,
        ])
        .setup(|app| {
            // Try to get the default window icon from bundled resources
            let icon = if let Some(default_icon) = app.default_window_icon() {
                default_icon.clone()
            } else {
                // Fallback: embed icon directly
                let icon_bytes = include_bytes!("../icons/128x128.png");
                tauri::image::Image::from_bytes(icon_bytes)
                    .expect("Failed to parse bundled icon")
            };

            // Set window icon on Linux
            #[cfg(target_os = "linux")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_icon(icon.clone()).ok();
                }
            }

            // Set up system tray
            let _tray_icon = tauri::tray::TrayIconBuilder::new()
                .tooltip("Vault - E2E Encrypted Messenger")
                .icon(icon)
                .build(app)?;

            // Linux: WebKitGTK по умолчанию отклоняет getUserMedia (микрофон) —
            // без явного обработчика разрешений голосовые сообщения не работают
            // ни у кого. Tauri/wry не подключают сигнал permission-request,
            // поэтому подключаем его напрямую к нативному WebView: разрешаем
            // захват аудио/видео (UserMediaPermissionRequest), остальное
            // оставляем дефолтному поведению (отклонение).
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            {
                use webkit2gtk::glib::prelude::ObjectExt;
                use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                if let Some(webview_window) = app.get_webview_window("main") {
                    let _ = webview_window.with_webview(|webview| {
                        let wk = webview.inner();
                        // Включаем медиа-захват в настройках WebKit
                        // (enable-media-stream по умолчанию выключен).
                        if let Some(settings) = wk.settings() {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_mediasource(true);
                        }
                        // Собственно выдача разрешений.
                        wk.connect_permission_request(|_view, request| {
                            if request.is::<webkit2gtk::UserMediaPermissionRequest>() {
                                request.allow();
                                true // обработано
                            } else {
                                false // дефолт WebKit (отклонение)
                            }
                        });
                    });
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    window.hide().unwrap();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
