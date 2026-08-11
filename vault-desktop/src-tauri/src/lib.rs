// Android library entry point — re-exports main.rs for Tauri cdylib
mod crypto;
mod email;
mod key_store;
mod storage;
mod groups;

use crypto::{CryptoState, KeyPair};
use email::{EmailClient, EmailConfig, EmailMessage};
use key_store::{StoredKeyPair, StoredPeerKey, KeyStoreMetadata};
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
        "vendetta" => include_bytes!("../icons/vault_icon_vault-vendetta.png"),
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
    client
        .fetch_messages()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn email_fetch_body(uid: String, state: State<'_, EmailState>) -> Result<String, String> {
    let mut guard = state.0.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    client
        .fetch_message_body(&uid)
        .await
        .map_err(|e| e.to_string())
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
fn groups_leave(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::remove_member(&group_id, &email)
        .map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned().ok_or_else(|| "Group not found".to_string()))
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_get(group_id: String) -> Result<Option<groups::Group>, String> {
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_import(group_id: String, name: String, group_key: String, sender: String) -> Result<groups::Group, String> {
    groups::import_group(&group_id, &name, &group_key, &sender)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_set_key(group_id: String, group_key: String) -> Result<(), String> {
    groups::set_group_key(&group_id, &group_key)
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
            encrypt_symmetric,
            decrypt_symmetric,
            email_connect,
            email_fetch_messages,
            email_fetch_body,
            email_send,
            email_disconnect,
            groups_load,
            groups_create,
            groups_add_member,
            groups_remove_member,
            groups_leave,
            groups_get,
            groups_import,
            groups_set_key,
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
