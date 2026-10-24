// Rust core logic for message lifecycle — перенос из JS features/messages.js.
// Domain logic ТОЛЬКО (без I/O: crypto/SMTP через Tauri cmd). Persistence — JSON.
// Contract: docs/M0-WIRE-FORMAT-PARITY.md (VaultEnvelope ↔ parseEnvelope).

use anyhow::{Context, Result};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::protocol::VaultEnvelope;
// VaultMsgType нужен только тестам (sample_envelope) — в прод-сборке не используется.
#[cfg(test)]
use super::protocol::VaultMsgType;
use super::reactions::ReactionsStore;
use super::attachments::{AttachmentStore, AttachmentMeta};

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

/// Payload расшифрованного конверта → `VaultMessage` (контракт с JS).
///
/// Вынесено из моста (ADR-005 §W4, `t_502b6c90`): имена полей — это
/// `JSON.stringify(cls.msg)` из `features/incoming.js`, то есть формат
/// протокола, а не деталь команды. `id` берётся по цепочке: `env_id` из JS
/// (кросс-канальный дедуп relay-копии и email-копии) → `id` payload → legacy
/// `message_id` → пусто. Не-JSON — ошибка: сообщение не должно сохраниться
/// «молча с пустым id».
pub fn message_from_payload(
    from: &str,
    to: &str,
    env_id: Option<&str>,
    plain: &str,
) -> Result<VaultMessage, String> {
    let p: serde_json::Value =
        serde_json::from_str(plain).map_err(|e| format!("payload parse: {}", e))?;
    let id = env_id
        .or_else(|| p.get("id").and_then(|v| v.as_str()))
        .or_else(|| p.get("message_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    Ok(VaultMessage {
        id,
        from: from.to_string(),
        to: to.to_string(),
        ts: p.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
        text: p
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        name: p
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        avatar: p
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        reactions: p
            .get("reactions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        edited: p.get("edited").and_then(|v| v.as_bool()).unwrap_or(false),
        replies: p
            .get("replies")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        in_reply_to: p
            .get("in_reply_to")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        ttl: p.get("ttl").and_then(|v| v.as_u64()),
    })
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
    /// attachment metadata store.
    attachments: AttachmentStore,
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
        Ok(Self { path, messages, reactions: ReactionsStore::default(), attachments: AttachmentStore::default() })
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

    /// Classify an incoming decrypted plaintext and route to store.
    ///
    /// Parity с JS incoming.js classify(): определяем тип конверта (Message/Profile/
    /// Presence/Call) и роутим в store ТОЛЬКО сообщения (Message). Presence/Profile/
    /// Call/Poll — domain-events, I/O (saveProfile/handleCallSignal/notify) остаётся
    /// в Tauri cmd (как send.js → api.sendMessage).
    ///
    /// Возвращает ClassifyResult с чат-ключом для дальнейшей обработки наружными слоями.
    pub fn classify_incoming(
        &self,
        from: &str,
        decrypted_plaintext: &str,
    ) -> Option<super::incoming::ClassifyResult> {
        super::incoming::classify(decrypted_plaintext, from)
    }

    /// Store an incoming message (after classify confirmed kind=Message).
    /// Используется Tauri cmd для роутинга classified events.
    pub fn store_incoming(&mut self, email: &str, group_id: Option<&str>, msg: VaultMessage) -> bool {
        self.append_message(email, group_id, msg)
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

    /// Get all attachments for a message (proxy to AttachmentStore).
    pub fn attachments_for(&self, msg_id: &str) -> &[AttachmentMeta] {
        self.attachments.attachments_for(msg_id)
    }

    /// Register attachment metadata for a message.
    pub fn add_attachment(&mut self, msg_id: &str, idx: usize, filename: &str, size: u64, mime: &str) {
        let meta = AttachmentMeta::new(msg_id, idx, filename, size, mime);
        self.attachments.add(meta);
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
    fn test_classify_incoming_message() {
        let store = MessageStore::with_path(std::path::PathBuf::from("/tmp/__nonexistent_vault_messages.json")).unwrap();
        let plain = r#"{"vault":1,"id":"m1","text":"hi","name":"A"}"#;
        let r = store.classify_incoming("alice@x", plain).unwrap();
        assert_eq!(r.kind, crate::vault::ClassifyKind::Message);
        assert_eq!(r.env_id.as_deref(), Some("m1"));
    }

    #[test]
    fn test_classify_incoming_presence() {
        let store = MessageStore::with_path(std::path::PathBuf::from("/tmp/__nonexistent_vault_messages2.json")).unwrap();
        let plain = r#"{"presence":1,"ts":123}"#;
        let r = store.classify_incoming("alice@x", plain).unwrap();
        assert_eq!(r.kind, crate::vault::ClassifyKind::Presence);
    }

    #[test]
    fn test_classify_incoming_profile() {
        let store = MessageStore::with_path(std::path::PathBuf::from("/tmp/__nonexistent_vault_messages3.json")).unwrap();
        // Как в features/profiles.js: письмо профиля несёт text:""
        // (без `text` строкой это не vault-конверт — см. incoming.rs).
        let plain = r#"{"vault":1,"type":"profile","text":"","name":"Bob","avatar":"x"}"#;
        let r = store.classify_incoming("bob@x", plain).unwrap();
        assert_eq!(r.kind, crate::vault::ClassifyKind::Profile);
    }

    #[test]
    fn test_storage_incoming_message() {
        let mut store = MessageStore::with_path(std::path::PathBuf::from("/tmp/__nonexistent_vault_messages4.json")).unwrap();
        let env = sample_envelope();
        let payload = r#"{"id":"msg-2","text":"hello"}"#;
        let msg = MessageStore::parse_envelope(&env, payload).unwrap();
        assert!(store.store_incoming("bob@x", None, msg));
        assert_eq!(store.messages_for("bob@x", None).len(), 1);
    }

    /// store_incoming ОБЯЗАН вернуть false для дубля: вызывающий (Tauri cmd
    /// store_incoming_message) по этому признаку знает, что письмо новое, и
    /// только у нового шлёт событие о непрочитанном. Если результат всегда
    /// true, уведомление о новом письме приходит на КАЖДУЮ переотправку.
    /// Мутационный гейт Rust-ядра выловил отсутствие этой проверки.
    #[test]
    fn test_store_incoming_reports_duplicate() {
        let mut store = MessageStore::default();
        let env = sample_envelope();
        let payload = r#"{"id":"msg-dup","text":"hi","name":"","avatar":""}"#;
        let msg = MessageStore::parse_envelope(&env, payload).unwrap();
        assert!(store.store_incoming("bob@x", None, msg.clone()));
        assert!(!store.store_incoming("bob@x", None, msg));
        assert_eq!(store.messages_for("bob@x", None).len(), 1);
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

    /// Порядок решает ВРЕМЯ, а не порядок вставки: два сообщения идут по
    /// возрастанию ts — и наивное «новое всегда первым» даёт тот же результат.
    /// Третье, самое старое, добавлено последним — оно обязано остаться внизу.
    #[test]
    fn test_append_ordering_recent_first() {
        let mut store = MessageStore::default();
        let make = |id: &str, ts: i64| VaultMessage { id: id.into(), from: "a@x".into(), to: "b@x".into(), ts, text: id.into(), name: "".into(), avatar: "".into(), edited: false, replies: vec![], in_reply_to: None, reactions: vec![], ttl: None };
        store.append_message("b@x", None, make("m1", 1000));
        store.append_message("b@x", None, make("m2", 2000)); // свежее — должно встать первым
        store.append_message("b@x", None, make("m0", 500)); // самое старое — пришло последним
        let msgs = store.messages_for("b@x", None);
        let ids: Vec<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m2", "m1", "m0"], "порядок задает ts, а не вставка");
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

    // ── Контракт payload → VaultMessage ──────────────────────────────────
    // Имена полей — это `JSON.stringify(cls.msg)` из `features/incoming.js`:
    // переименование на JS-стороне иначе прошло бы молча — сообщения
    // писались бы с пустыми id/ts.

    #[test]
    fn test_message_from_payload_full() {
        let plain = r#"{"vault":1,"id":"msg-1","text":"привет","name":"Аня",
            "avatar":"data:image/png;base64,AAA","ts":1700000000,
            "reactions":["👍","❤"],"edited":true,"replies":["m0"],
            "in_reply_to":"m0","ttl":86400}"#;
        let vm = message_from_payload("alice@x", "me@x", Some("msg-1"), plain).unwrap();
        assert_eq!(vm.id, "msg-1");
        assert_eq!(vm.from, "alice@x");
        assert_eq!(vm.to, "me@x");
        assert_eq!(vm.ts, 1700000000);
        assert_eq!(vm.text, "привет");
        assert_eq!(vm.name, "Аня");
        assert!(vm.avatar.starts_with("data:image/png"));
        assert_eq!(vm.reactions, vec!["👍".to_string(), "❤".to_string()]);
        assert!(vm.edited);
        assert_eq!(vm.replies, vec!["m0".to_string()]);
        assert_eq!(vm.in_reply_to.as_deref(), Some("m0"));
        assert_eq!(vm.ttl, Some(86400));
    }

    /// Минимум, который реально шлёт `features/incoming.js` (текст/имя/
    /// аватар пустые). Маппинг обязан принять его и не выдумать данные.
    #[test]
    fn test_message_from_payload_incoming_js_stub() {
        let plain = r#"{"id":"uid-1|INBOX","from":"alice@x","to":"me@x",
            "ts":1700000123456,"text":"","name":"","avatar":"",
            "reactions":[],"edited":false,"replies":[],"in_reply_to":null,"ttl":null}"#;
        let vm = message_from_payload("alice@x", "me@x", Some("uid-1|INBOX"), plain).unwrap();
        assert_eq!(vm.id, "uid-1|INBOX");
        assert_eq!(vm.ts, 1700000123456);
        assert_eq!(vm.text, "");
        assert_eq!(vm.name, "");
        assert_eq!(vm.reactions.len(), 0);
        assert!(!vm.edited);
        assert_eq!(vm.in_reply_to, None);
        assert_eq!(vm.ttl, None);
    }

    /// Цепочка id: envId из JS важнее `payload.id` (дедуп relay-копии и
    /// email-копии одного сообщения), затем legacy `message_id`, иначе пусто.
    #[test]
    fn test_message_from_payload_id_chain() {
        let with_both = r#"{"id":"from-payload"}"#;
        assert_eq!(
            message_from_payload("a@x", "m@x", Some("from-js"), with_both)
                .unwrap()
                .id,
            "from-js"
        );
        assert_eq!(
            message_from_payload("a@x", "m@x", None, with_both)
                .unwrap()
                .id,
            "from-payload"
        );
        let legacy = r#"{"message_id":"legacy-1"}"#;
        assert_eq!(
            message_from_payload("a@x", "m@x", None, legacy).unwrap().id,
            "legacy-1"
        );
        assert_eq!(
            message_from_payload("a@x", "m@x", None, "{}").unwrap().id,
            ""
        );
    }

    /// Пустой payload: обязательные поля получают нейтральные значения, а не
    /// выдуманные (`edited = true` или `ts = now` сделали бы «письмо без
    /// данных» похожим на настоящее).
    #[test]
    fn test_message_from_payload_defaults() {
        let vm = message_from_payload("a@x", "m@x", None, "{}").unwrap();
        assert_eq!(vm.ts, 0);
        assert_eq!(vm.text, "");
        assert_eq!(vm.name, "");
        assert_eq!(vm.avatar, "");
        assert!(!vm.edited);
        assert!(vm.reactions.is_empty());
        assert!(vm.replies.is_empty());
        assert_eq!(vm.in_reply_to, None);
        assert_eq!(vm.ttl, None);
    }

    /// Не-JSON — ошибка: сообщение не должно сохраниться «молча с пустым id».
    #[test]
    fn test_message_from_payload_rejects_non_json() {
        let err = message_from_payload("a@x", "m@x", None, "просто текст").unwrap_err();
        assert!(
            err.starts_with("payload parse:"),
            "неожиданная ошибка: {err}"
        );
    }
}
