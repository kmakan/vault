//! M1.9: Bridge between Desktop Tauri cmds and vault-client reusable core.
//!
//! Exposes tauri::commands for the JS frontend (features/incoming.js parity):
//! - vault_classify_incoming: classify a decrypted plaintext envelope
//! - vault_store_incoming_message: persist a classified Message in MessageStore
//! - vault_download_attachment: decrypt an EncryptedEnvelope → native file
//! - vault_save_file: save already-decrypted base64 data → native file
//!
//! State (MessageStore/AttachmentStore) инициализируется лениво и хранится в
//! Tauri State[VaultBridgeState].

use serde::Deserialize;
use std::path::PathBuf;
use vault_client::vault::AttachmentStore;
use vault_client::vault::ClassifyResult;
use vault_client::vault::MessageStore;
// ClassifyKind нужен только тестам (test_classify_kind_display) — в прод-сборке не используется.
#[cfg(test)]
use vault_client::vault::ClassifyKind;

/// Bridge state — singleton via Tauri State.
#[derive(Default)]
pub struct VaultBridgeState {
    messages: std::sync::Mutex<MessageStore>,
}

impl VaultBridgeState {
    pub fn new() -> Self {
        Self {
            messages: std::sync::Mutex::new(MessageStore::new().unwrap_or_default()),
        }
    }

    pub fn messages(&self) -> std::sync::MutexGuard<'_, MessageStore> {
        self.messages.lock().unwrap()
    }

    pub fn attachments(&self) -> AttachmentStore {
        AttachmentStore::new().unwrap_or_default()
    }
}

/// Input for `vault_classify_incoming`.
#[derive(Debug, Deserialize)]
pub struct ClassifyInput {
    /// Sender email (canonicalized).
    pub from: String,
    /// Decrypted plaintext JSON.
    pub decrypted: String,
}

/// Convert ClassifyResult to JSON-safe Value.
fn classify_result_to_json(r: &ClassifyResult) -> serde_json::Value {
    serde_json::json!({
        "kind": r.kind.to_string(),
        "msg_type": r.msg_type.as_ref().and_then(|mt| serde_json::to_value(mt).ok()),
        "env_id": r.env_id,
        "chat_key": r.chat_key,
        "title": r.title,
    })
}

/// Classify an incoming decrypted plaintext via core.
/// Returns JSON {kind, msg_type, env_id, chat_key, title} or null.
#[tauri::command]
pub async fn vault_classify_incoming(input: ClassifyInput) -> Result<Option<serde_json::Value>, String> {
    let store = MessageStore::new().map_err(|e| e.to_string())?;
    match store.classify_incoming(&input.from, &input.decrypted) {
        Some(r) => Ok(Some(classify_result_to_json(&r))),
        None => Ok(None),
    }
}

/// Store an incoming message (after classify confirmed kind=Message).
///
/// JS передаёт `from`, `envId`, `plain` (decrypted payload JSON) + `chatKey`.
/// Rust парсит payload и создаёт VaultMessage via store logic. Это parity
/// с CLI `messages.rs:store_incoming`.
#[tauri::command]
pub async fn vault_store_incoming_message(
    state: tauri::State<'_, VaultBridgeState>,
    from: String,
    chat_key: Option<String>,
    env_id: Option<String>,
    plain: String,
) -> Result<bool, String> {
    let p: serde_json::Value =
        serde_json::from_str(&plain).map_err(|e| format!("payload parse: {}", e))?;
    let id = env_id.as_deref().or_else(|| p.get("id").and_then(|v| v.as_str()))
        .or_else(|| p.get("message_id").and_then(|v| v.as_str()))
        .unwrap_or("").to_string();
    let vm = vault_client::vault::VaultMessage {
        id,
        from,
        to: std::env::var("VAULT_EMAIL").unwrap_or_default(),
        ts: p.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
        text: p.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        name: p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        avatar: p.get("avatar").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        reactions: p.get("reactions").and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        edited: p.get("edited").and_then(|v| v.as_bool()).unwrap_or(false),
        replies: p.get("replies").and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        in_reply_to: p.get("in_reply_to").and_then(|v| v.as_str()).map(|s| s.to_string()),
        ttl: p.get("ttl").and_then(|v| v.as_u64()),
    };
    let mut store = state.messages();
    let from = vm.from.clone();
    let stored = store.store_incoming(&from, chat_key.as_deref(), vm);
    if stored {
        if let Err(e) = store.save() {
            log::warn!("[vault_bridge] MessageStore save failed: {}", e);
        }
    }
    Ok(stored)
}

// ── Attachment download (shared vault-core unpacking path) ──────────────

/// Download (decrypt) an `EncryptedEnvelope` and write the original file to
/// the user's downloads directory.
///
/// Uses `vault_client::vault::download_file` so that the CLI and Desktop share
/// the **same** unpacking logic (envelope parse + XChaCha20-Poly1305 decrypt).
///
/// JS passes the full ASCII-armored envelope text.  Returns the absolute path
/// to the saved file, or an `Err` string on failure.
#[tauri::command]
pub async fn vault_download_attachment(
    envelope_text: String,
    #[allow(unused_variables)] output_dir: Option<PathBuf>,
    output_name: Option<String>,
) -> Result<String, String> {
    let dir: PathBuf = match &output_dir {
        Some(d) => d.clone(),
        None => dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir),
    };
    let path = vault_client::vault::download_file(
        &envelope_text,
        Some(&dir),
        output_name.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Decode base64 and write it to `dir/filename`, creating `dir` if needed.
///
/// Pure filesystem helper (no HOME/download-dir lookup) so the real code path
/// is unit-testable with an explicit temp dir.
pub fn save_base64_file(
    base64_data: &str,
    filename: &str,
    dir: &std::path::Path,
) -> Result<PathBuf, String> {
    use base64::Engine as _;
    let binary = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("base64 decode error: {}", e))?;

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    std::fs::write(&path, &binary).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Save already-decrypted base64 file data to the downloads directory.
///
/// Used by the Desktop "Download" button on attachment cards and the
/// full-size image viewer.  Falls back to the browser `<a download>`
/// mechanism if the Tauri command fails.
#[tauri::command]
pub async fn vault_save_file(
    base64_data: String,
    filename: String,
    mime_type: String,
) -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let path = save_base64_file(&base64_data, &filename, &dir)?;
    let _ = mime_type; // reserved for future MIME-aware handling
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_kind_display() {
        assert_eq!(ClassifyKind::Message.to_string(), "message");
        assert_eq!(ClassifyKind::Presence.to_string(), "presence");
        assert_eq!(ClassifyKind::Profile.to_string(), "profile");
        assert_eq!(ClassifyKind::Call.to_string(), "call");
        assert_eq!(ClassifyKind::Unknown.to_string(), "unknown");
    }

    #[test]
    fn test_classify_result_to_json() {
        let r = ClassifyResult {
            kind: ClassifyKind::Message,
            msg_type: None,
            env_id: Some("m1".to_string()),
            chat_key: Some("alice@x".to_string()),
            title: Some("Alice".to_string()),
        };
        let v = classify_result_to_json(&r);
        assert_eq!(v["kind"], "message");
        assert_eq!(v["env_id"], "m1");
        assert_eq!(v["chat_key"], "alice@x");
    }

    #[test]
    fn test_vault_bridge_state_new() {
        let state = VaultBridgeState::new();
        {
            let _g = state.messages();
        }
        let _ = state.attachments();
    }

    #[test]
    fn test_store_incoming_persists() {
        let tmp = std::env::temp_dir().join("m19_test_store_incoming.json");
        let _ = std::fs::remove_file(&tmp);
        let mut store = vault_client::vault::MessageStore::with_path(tmp.clone()).unwrap();
        let vm = vault_client::vault::VaultMessage {
            id: "m1".to_string(),
            from: "alice@x".to_string(),
            to: "me@x".to_string(),
            ts: 1700000000,
            text: "hello".to_string(),
            name: "Alice".to_string(),
            avatar: "".to_string(),
            reactions: vec![],
            edited: false,
            replies: vec![],
            in_reply_to: None,
            ttl: Some(0),
        };
        let from = vm.from.clone();
        assert!(store.store_incoming(&from, None, vm));
        assert!(store.save().is_ok());
        // persisted → reload
        let loaded = vault_client::vault::MessageStore::with_path(tmp).unwrap();
        assert_eq!(loaded.messages_for("alice@x", None).len(), 1);
        let _ = std::fs::remove_file(std::env::temp_dir().join("m19_test_store_incoming.json"));
    }

    #[test]
    fn test_download_attachment_roundtrip() {
        use vault_client::crypto::Encryptor;
        let enc = Encryptor::new();
        let temp = std::env::temp_dir().join("vault_bridge_dl_test");
        std::fs::create_dir_all(&temp).unwrap();
        let src = temp.join("test.txt");
        std::fs::write(&src, b"bridge test data").unwrap();
        let envelope = enc.encrypt_file(&src).unwrap();
        let _ = std::fs::remove_file(&src);

        let result = vault_client::vault::download_file(
            &envelope,
            Some(&temp),
            None,
        );
        assert!(result.is_ok());
        let recovered = std::fs::read(result.unwrap()).unwrap();
        assert_eq!(recovered, b"bridge test data");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_save_file_roundtrip() {
        use base64::Engine as _;
        // Явный temp-dir: тест не зависит от $HOME/dirs::download_dir() и не
        // гоняется с env-тестами, которые временно подменяют HOME.
        let dir = std::env::temp_dir().join(format!("vault_bridge_save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let original = b"save file test";
        let b64 = base64::engine::general_purpose::STANDARD.encode(original);

        // Реальный путь сохранения (тот же код, что зовёт Tauri-команда).
        let path = save_base64_file(&b64, "vault_test_save_file.bin", &dir).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        // Кривой base64 → Err, а не panic.
        assert!(save_base64_file("!!!not-base64!!!", "x.bin", &dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

