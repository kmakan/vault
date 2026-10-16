// Rust core logic for message lifecycle — перенос из JS features/messages.js.
// Domain logic ТОЛЬКО (без I/O: crypto/SMTP через Tauri cmd). Persistence — JSON.
// Contract: docs/M0-WIRE-FORMAT-PARITY.md (VaultEnvelope ↔ parseEnvelope).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::protocol::{VaultEnvelope, VaultMsgType};
use super::reactions::ReactionsStore;

/// A decoded Vault message (post-decryption, in app state).
/// Соответствует JS `ctx.messages[i]` объекту.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultMessage {
    pub id: String,                     // message_id (envelope.canonical)
    pub from: String,                   // sender email
    pub to: String,                     // recipient email
    pub ts: i64,                        // unix ms (как JS obj.ts)
    pub text: String,                   // расшифрованный контент (encrypted_payload → text)
    pub name: String,                   // display name (опц.)
    pub avatar: String,                 // avatar url/data (опц.)
    #[serde(default)]
    pub reactions: Vec<String>,         // unique emojis (из reactions_store)
    #[serde(skip)]
    pub edited: bool,                   // UI flag (локальный, не сериализуется в историю)
    #[serde(default)]
    pub replies: Vec<String>,           // child message_ids (threading)
    #[serde(default)]
    pub in_reply_to: Option<String>,    // parent (edit/reply)
    #[serde(default)]
    pub ttl: Option<u64>,               // ephemeral TTL (сек)
}

/// Message store: chat_key → Vec<VaultMessage> (history + incoming merge).
/// Персистентность JSON (~/.vault/messages.json). Инкрементальный: IMAP —
/// только новые после курсора (правило 07.10), история — источник правды.
#[derive(Debug, Default, Clone)]
pub struct MessageStore {
    path: PathBuf,
    /// chat_key → Vec<message>
    messages: HashMap<String, Vec<VaultMessage>>,
    /// message_id → reactions (global, чаты маппятся на inbox).
    reactions: ReactionsStore,
}

impl MessageStore {
    pub fn new() -> Result<Self> {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".vault")
            .join("messages.json");
        Self::with_path(path)
    }

    pub fn with_path(path: PathBuf) -> Result<Self> {
        let messages = if path.exists() {
            let data = fs::read_to_string(&path).context("Failed to read messages")?;
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self { path, messages, reactions: ReactionsStore::default() })
    }

    /// Save store to disk.
    pub fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.messages)
            .context("Failed to serialize messages")?;
        fs::write(&self.path, data).context("Failed to write messages")?;
        Ok(())
    }

    /// Chat key for 1:1 (email) или group.
    fn chat_key(email: &str, group_id: Option<&str>) -> String {
        match group_id {
            Some(g) => format!("group:{}", g),
            None => email.to_string(),
        }
    }

    /// Get all messages for a chat (в порядке добавления).
    pub fn messages_for(&self, email: &str, group_id: Option<&str>) -> &[VaultMessage] {
        let key = Self::chat_key(email, group_id);
        self.messages.get(&key).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Dedup по message_id: не добавлять дубль (правило 07.10).
    pub fn append_message(&mut self, email: &str, group_id: Option<&str>, msg: VaultMessage) -> bool {
        let key = Self::chat_key(email, group_id);
        let chat = self.messages.entry(key).or_default();
        if chat.iter().any(|m| m.id == msg.id) {
            return false; // дедуп
        }
        // Свежие сверху (по ts): вставляем перед первым элементом, который
        // СТАРШЕ нового (m.ts < msg.ts), иначе — в конец (новое oldest).
        let pos = chat.iter().position(|m| m.ts < msg.ts).unwrap_or(chat.len());
        chat.insert(pos, msg);
        true
    }

    /// Get existing message by id.
    pub fn find(&self, email: &str, group_id: Option<&str>, id: &str) -> Option<&VaultMessage> {
        let key = Self::chat_key(email, group_id);
        self.messages.get(&key).and_then(|v| v.iter().find(|m| m.id == id))
    }

    /// Patch сообщения (локальная мутировка — как ctx.chat.patch).
    pub fn patch(&mut self, email: &str, group_id: Option<&str>, id: &str, f: impl FnOnce(&mut VaultMessage)) -> bool {
        let key = Self::chat_key(email, group_id);
        if let Some(chat) = self.messages.get_mut(&key) {
            if let Some(msg) = chat.iter_mut().find(|m| m.id == id) {
                f(msg);
                return true;
            }
        }
        false
    }

    /// Get unique reactions (читаются из reactions_store, как JS msg.reactions).
    pub fn reactions_for(&self, msg_id: &str) -> Vec<String> {
        let mut reactions: Vec<String> = vec![];
        for msgs in self.reactions.inner().values() {
            if let Some(rs) = msgs.get(msg_id) {
                for r in rs {
                    if !reactions.contains(&r.emoji) { reactions.push(r.emoji.clone()); }
                }
            }
        }
        reactions
    }

    /// Мерж инкрементальных писем: добавить новые (не в history).
    /// `in_hist` — mid уже в истории (не перефетчиваем).
    pub fn merge_incoming(&mut self, email: &str, group_id: Option<&str>, incoming: Vec<VaultMessage>) -> usize {
        let mut added = 0;
        for msg in incoming {
            if self.append_message(email, group_id, msg) { added += 1; }
        }
        added
    }

    /// Parse VaultEnvelope → VaultMessage (app-layer, как JS parseEnvelope).
    /// envelope = core (version/msg_type/from/to/message_id/in_reply_to/timestamp)
    /// payload  = encrypted_payload JSON {id, text, name, avatar, ts, ...}
    pub fn parse_envelope(envelope: &VaultEnvelope, payload: &str) -> Result<VaultMessage> {
        let p: serde_json::Value = serde_json::from_str(payload).context("Invalid payload JSON")?;
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or(&envelope.message_id).to_string();
        let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = p.get("name").and_replace("").to_string();
        let avatar = p.get("avatar").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let ts = p.get("ts").and_then(|v| v.as_i64())
            .unwrap_or_else(|| DateTime::parse_from_rfc3339(&envelope.timestamp).map(|dt| dt.timestamp_millis()).unwrap_or(0));
        let ttl = p.get("ttl").and_then(|v| v.as_u64());
        Ok(VaultMessage {
            id, from: envelope.from.clone(), to: envelope.to.clone(),
            ts, text, name, avatar, edited: false, replies: vec![],
            in_reply_to: envelope.in_reply_to.clone(),
            reactions: vec![],
            ttl,
        })
    }

    /// Apply edit record (из EditManager) — обновить content, выставить edited.
    pub fn apply_edit(&mut self, email: &str, group_id: Option<&str>, msg_id: &str, new_content: &str) -> bool {
        self.patch(email, group_id, msg_id, |msg| {
            msg.text = new_content.to_string();
            msg.edited = true;
        })
    }
}

// and_then/and_replace helpers (avoid .and_replace instable API)
trait OptStr {
    fn and_replace(self, d: &str) -> String;
}
impl OptStr for Option<&serde_json::Value> {
    fn and_replace(self, d: &str) -> String {
        self.and_then(|v| v.as_str()).unwrap_or(d).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_envelope() -> VaultEnvelope {
        VaultEnvelope {
            version: "1".to_string(),
            msg_type: VaultMsgType::Message,
            from: "alice@x".to_string(),
            to: "bob@x".to_string(),
            message_id: "msg-1".to_string(),
            in_reply_to: None,
            timestamp: "2026-10-16T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_parse_envelope() {
        let env = sample_envelope();
        let payload = r#"{"id":"msg-1","text":"привет","name":"Аня","avatar":"","ts":1700000000,"ttl":0}"#;
        let msg = MessageStore::parse_envelope(&env, payload).unwrap();
        assert_eq!(msg.id, "msg-1");
        assert_eq!(msg.text, "привет");
        assert_eq!(msg.from, "alice@x");
        assert_eq!(msg.ts, 1700000000);
        assert_eq!(msg.in_reply_to, None);
        assert_eq!(msg.ttl, Some(0));
    }

    #[test]
    fn test_append_dedup() {
        let mut store = MessageStore::default();
        let env = sample_envelope();
        let payload = r#"{"id":"msg-1","text":"hi","name":"","avatar":""}"#;
        let msg = MessageStore::parse_envelope(&env, payload).unwrap();
        assert!(store.append_message("bob@x", None, msg.clone()));
        // дубль — не добавится
        assert!(!store.append_message("bob@x", None, msg));
        assert_eq!(store.messages_for("bob@x", None).len(), 1);
    }

    #[test]
    fn test_append_ordering_recent_first() {
        let mut store = MessageStore::default();
        let msg1 = VaultMessage { id: "m1".into(), from: "a@x".into(), to: "b@x".into(), ts: 1000, text: "old".into(), name: "".into(), avatar: "".into(), edited: false, replies: vec![], in_reply_to: None, reactions: vec![], ttl: None };
        let msg2 = VaultMessage { id: "m2".into(), from: "a@x".into(), to: "b@x".into(), ts: 2000, text: "new".into(), name: "".into(), avatar: "".into(), edited: false, replies: vec![], in_reply_to: None, reactions: vec![], ttl: None };
        store.append_message("b@x", None, msg1);
        store.append_message("b@x", None, msg2); // свежее — должно встать первым
        let msgs = store.messages_for("b@x", None);
        assert_eq!(msgs[0].id, "m2"); // newest first
    }

    #[test]
    fn test_patch_edit() {
        let mut store = MessageStore::default();
        let msg = VaultMessage { id: "m1".into(), from: "a@x".into(), to: "b@x".into(), ts: 1000, text: "orig".into(), name: "".into(), avatar: "".into(), edited: false, replies: vec![], in_reply_to: None, reactions: vec![], ttl: None };
        store.append_message("b@x", None, msg);
        assert!(store.apply_edit("b@x", None, "m1", "edited"));
        let m = store.find("b@x", None, "m1").unwrap();
        assert_eq!(m.text, "edited");
        assert!(m.edited);
    }

    #[test]
    fn test_merge_incoming() {
        let mut store = MessageStore::default();
        let msg = VaultMessage { id: "m1".into(), from: "a@x".into(), to: "b@x".into(), ts: 1000, text: "a".into(), name: "".into(), avatar: "".into(), edited: false, replies: vec![], in_reply_to: None, reactions: vec![], ttl: None };
        store.append_message("b@x", None, msg);
        let incoming = vec![
            VaultMessage { id: "m1".into(), ..store.find("b@x", None, "m1").unwrap().clone() }, // дубль
            VaultMessage { id: "m2".into(), from: "a@x".into(), to: "b@x".into(), ts: 2000, text: "b".into(), name: "".into(), avatar: "".into(), edited: false, replies: vec![], in_reply_to: None, reactions: vec![], ttl: None },
        ];
        let added = store.merge_incoming("b@x", None, incoming);
        assert_eq!(added, 1); // только m2
        assert_eq!(store.messages_for("b@x", None).len(), 2);
    }

    #[test]
    fn test_chat_key_group_vs_chat() {
        assert_eq!(MessageStore::chat_key("bob@x", None), "bob@x");
        assert_eq!(MessageStore::chat_key("x", Some("g1")), "group:g1");
    }

    #[test]
    fn test_reactions_proxy() {
        let mut store = MessageStore::default();
        store.reactions.add_reaction("m1", "👍", "alice@x");
        assert_eq!(store.reactions_for("m1"), vec!["👍".to_string()]);
    }
}
