// Android library entry point — re-exports main.rs for Tauri cdylib
mod crypto;
mod key_store;

use crypto::{CryptoState, KeyPair};
use key_store::{StoredKeyPair, StoredPeerKey, KeyStoreMetadata};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CryptoState::default())
        .invoke_handler(tauri::generate_handler![
            generate_keypair,
            encrypt_message,
            decrypt_message,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
