//! M1.9: Bridge between Desktop Tauri cmds and vault-client reusable core.
//!
//! Exposes tauri::commands for the JS frontend (features/incoming.js parity):
//! - vault_classify_incoming: classify a decrypted plaintext envelope
//! - vault_store_incoming_message: persist a classified Message in MessageStore
//!
//! State (MessageStore/AttachmentStore) инициализируется лениво и хранится в
//! Tauri State[VaultBridgeState].

use serde::Deserialize;
use vault_client::vault::AttachmentStore;
use vault_client::vault::ClassifyKind;
use vault_client::vault::ClassifyResult;
use vault_client::vault::MessageStore;

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

/// Store an incoming VaultMessage (after classify confirmed kind=Message).
///
/// JS передаёт распарсенный VaultMessage JSON. Мы десериализуем в `VaultMessage`
/// и вызываем `MessageStore::store_incoming`. `chat_key` = `msg.chat_key` (опц.),
/// если нет — выводится из from/to (store default).
#[tauri::command]
pub async fn vault_store_incoming_message(
    state: tauri::State<'_, VaultBridgeState>,
    chat_key: Option<String>,
    msg: serde_json::Value,
) -> Result<bool, String> {
    let vm: vault_client::vault::VaultMessage =
        serde_json::from_value(msg).map_err(|e| format!("VaultMessage parse: {}", e))?;
    let from = vm.from.clone();
    let mut store = state.messages();
    Ok(store.store_incoming(&from, chat_key.as_deref(), vm))
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
}

