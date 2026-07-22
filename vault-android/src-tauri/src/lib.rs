mod crypto;
mod storage;

use crypto::KeyPair;

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
fn encrypt_symmetric(plaintext: String, key: String) -> Result<String, String> {
    crypto::encrypt_symmetric_cmd(&plaintext, &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_symmetric(ciphertext: String, key: String) -> Result<String, String> {
    crypto::decrypt_symmetric_cmd(&ciphertext, &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_fingerprint(public_key: String) -> Result<String, String> {
    crypto::fingerprint_cmd(&public_key).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            generate_keypair,
            encrypt_message,
            decrypt_message,
            encrypt_symmetric,
            decrypt_symmetric,
            get_fingerprint,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
