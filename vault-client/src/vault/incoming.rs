//! Incoming envelope classification — Rust core parity with JS features/incoming.js.
//!
//! `classify` определяет тип конверта после расшифровки (decrypted plaintext JSON):
//! - `Message` (vault=1, поле text)
//! - `Profile` (vault=1, type=profile / name/avatar/bio)
//! - `Presence` (presence=1)
//! - `Call` (vault=1, poll или call_* поля)
//! - `Unknown` (не vault envelope)

use serde::{Deserialize, Serialize};

use super::protocol::VaultMsgType;

/// Classification result for a decrypted incoming plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClassifyKind {
    Message,
    Profile,
    Presence,
    Call,
    KeyExchange,
    Receipt,
    Unknown,
}

/// Result of classifying an incoming envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifyResult {
    pub kind: ClassifyKind,
    pub msg_type: Option<VaultMsgType>,
    pub env_id: Option<String>,       // envelope id (кросс-канальный дедуп)
    pub chat_key: Option<String>,     // 1:1 email или group:<id>
    pub title: Option<String>,        // display title (name/avatar)
}

impl Default for ClassifyResult {
    fn default() -> Self {
        Self {
            kind: ClassifyKind::Unknown,
            msg_type: None,
            env_id: None,
            chat_key: None,
            title: None,
        }
    }
}

/// Parse a decrypted plaintext JSON into classify result (parity JS parseEnvelope).
fn parse_vault_env(plain: &str) -> Option<serde_json::Value> {
    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;
    // message envelope (в приоритете — text доминирует)
    if obj.get("vault").and_then(|v| v.as_i64()) == Some(1) && obj.get("text").is_some() {
        return Some(obj);
    }
    // presence heartbeat (non-vault JSON: presence=1)
    if obj.get("presence").is_some() {
        return Some(obj);
    }
    // profile update: name/avatar/bio без text
    if obj.get("vault").and_then(|v| v.as_i64()) == Some(1)
        && obj.get("text").is_none()
        && (obj.get("type").and_then(|v| v.as_str()) == Some("profile")
            || obj.get("name").is_some()
            || obj.get("avatar").is_some()
            || obj.get("bio").is_some())
    {
        return Some(obj);
    }
    // call/poll signal (без text)
    if obj.get("vault").and_then(|v| v.as_i64()) == Some(1)
        && obj.get("text").is_none()
        && (obj.get("call_id").is_some()
            || obj.get("signal").is_some()
            || obj.get("poll").is_some())
    {
        return Some(obj);
    }
    None
}

/// Classify a decrypted plaintext (core parity with incoming.js classify()).
///
/// - `plain`: decrypted payload JSON (body already fetched)
/// - `from`: sender email (canonicalized upstream)
///
/// Returns `None` если не vault envelope (ignore / не наше письмо).
pub fn classify(plain: &str, from: &str) -> Option<ClassifyResult> {
    let obj = parse_vault_env(plain)?;
    let has_text = obj.get("text").is_some();
    let mut result = ClassifyResult {
        kind: ClassifyKind::Message,
        msg_type: None,
        env_id: object_get_string(&obj, "id"),
        chat_key: Some(from.to_string()),
        title: merge_name(&obj),
    };

    // Presence heartbeat (не message — не требует vault=1)
    if obj.get("presence").is_some() {
        result.kind = ClassifyKind::Presence;
        return Some(result);
    }

    // Message имеет приоритет — text доминирует над name/avatar/profile
    if has_text {
        // дальше не переклассифицируем
        return Some(result);
    }

    // Profile update (не message)
    if obj.get("type").and_then(|v| v.as_str()) == Some("profile")
        || obj.get("name").is_some()
        || obj.get("avatar").is_some()
        || obj.get("bio").is_some()
    {
        result.kind = ClassifyKind::Profile;
    }

    // Call signal (M3): call_id / signal / action поля
    if obj.get("call_id").is_some()
        || obj.get("signal").is_some()
        || obj.get("action").and_then(|v| v.as_str()).is_some()
    {
        result.kind = ClassifyKind::Call;
    }

    // Poll (M1): poll поле
    if obj.get("poll").is_some() {
        result.kind = ClassifyKind::Call; // polling treated as control, like JS
    }

    Some(result)
}

fn object_get_string(obj: &serde_json::Value, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn merge_name(obj: &serde_json::Value) -> Option<String> {
    obj.get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_message() {
        let plain = r#"{"vault":1,"id":"msg-1","text":"привет","name":"Аня","ts":1700000000}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Message);
        assert_eq!(r.env_id.as_deref(), Some("msg-1"));
        assert_eq!(r.chat_key.as_deref(), Some("alice@test.com"));
        assert_eq!(r.title.as_deref(), Some("Аня"));
    }

    #[test]
    fn test_classify_profile() {
        let plain = r#"{"vault":1,"name":"Bob","avatar":"data","bio":"hi","ts":123}"#;
        let r = classify(plain, "bob@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Profile);
    }

    #[test]
    fn test_classify_profile_type() {
        // type=profile БЕЗ text → profile (а не message)
        let plain = r#"{"vault":1,"type":"profile"}"#;
        let r = classify(plain, "x@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Profile);
    }

    #[test]
    fn test_classify_presence() {
        let plain = r#"{"presence":1,"ts":12345}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Presence);
    }

    #[test]
    fn test_classify_call() {
        // call signal без text → Call
        let plain = r#"{"vault":1,"call_id":"c1","signal":"start"}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Call);
    }

    #[test]
    fn test_classify_poll() {
        let plain = r#"{"vault":1,"poll":{"id":"p1"}}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Call);
    }

    #[test]
    fn test_classify_non_vault_returns_none() {
        assert!(classify("plain text", "x@test.com").is_none());
        assert!(classify(r#"{"foo":"bar"}"#, "x@test.com").is_none());
        // profile update (name без text) → Some
        assert!(classify(r#"{"vault":1,"name":"X"}"#, "x@test.com").is_some());
        // vault=1 but no text/name/avatar/bio/profile/call_id/signal/poll → None
        assert!(classify(r#"{"vault":1}"#, "x@test.com").is_none());
    }

    #[test]
    fn test_classify_default() {
        let def = ClassifyResult::default();
        assert_eq!(def.kind, ClassifyKind::Unknown);
        assert!(def.msg_type.is_none());
    }
}
