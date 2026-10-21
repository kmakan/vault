//! Call signal model — Rust core parity with JS features/calls.js parseCallSignal.
//!
//! `CallSignal` = decrypted call envelope `{vault:1, type:'call_*', call_id, ts, sdp?, role?, kemct?, sender_ek?}`.
//! Используется M2.3 bridge (Desktop media state machine) + incoming classify (Call kind).

use serde::{Deserialize, Serialize};

/// Parsed call signal envelope.
/// Parity с JS `parseCallSignal` (calls.js:131).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallSignal {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String, // call_request / call_answer / call_cancel / call_offer ...
    pub call_id: String,
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>, // caller/callee
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kemct: Option<String>,          // PQ KEM ciphertext (caller → callee)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_ek: Option<String>,       // ephemeral key handle for hybrid reply
    /// Relay read-токен отправителя (адрес его очереди). JS его читает
    /// (handleCallSignal → relay.memLearn): без поля токен терялся бы, и
    /// собеседник не смог бы слать мгновенные сигналы.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tok: Option<String>,
}

/// Parse a decrypted plaintext into CallSignal (parity JS parseCallSignal).
/// Возвращает None если это не call-signal envelope.
pub fn parse_call_signal(decrypted: &str) -> Option<CallSignal> {
    if decrypted.is_empty() {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(decrypted).ok()?;
    let is_call = obj.get("vault").and_then(|v| v.as_i64()) == Some(1)
        && obj.get("type").and_then(|v| v.as_str()).map(|t| t.starts_with("call_")).unwrap_or(false)
        && obj.get("call_id").and_then(|v| v.as_str()).is_some();
    if !is_call {
        return None;
    }
    let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let call_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let call_id = obj.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ts = obj.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
    Some(CallSignal {
        id,
        call_type,
        call_id,
        ts,
        sdp: obj.get("sdp").and_then(|v| v.as_str()).map(|s| s.to_string()),
        role: obj.get("role").and_then(|v| v.as_str()).map(|s| s.to_string()),
        kemct: obj.get("kemct").and_then(|v| v.as_str()).map(|s| s.to_string()),
        sender_ek: obj.get("sender_ek").and_then(|v| v.as_str()).map(|s| s.to_string()),
        tok: obj.get("tok").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Relay-токен отправителя едет в call-конверте и читается JS
    /// (handleCallSignal → relay.memLearn). Без него переезд разбора в Rust
    /// тихо ломал бы обмен relay-токеном: токен просто не доехал бы.
    #[test]
    fn call_signal_carries_relay_token() {
        let plain = r#"{"vault":1,"type":"call_request","call_id":"c1","ts":123,"tok":"QUEUE-TOKEN"}"#;
        let sig = parse_call_signal(plain).expect("сигнал разобран");
        assert_eq!(sig.tok.as_deref(), Some("QUEUE-TOKEN"));
    }

    /// Конверт без токена — обычное дело (релей выключен): tok пустой, но
    /// разбор не падает.
    #[test]
    fn call_signal_without_token_is_ok() {
        let plain = r#"{"vault":1,"type":"call_request","call_id":"c1","ts":123}"#;
        let sig = parse_call_signal(plain).expect("сигнал разобран");
        assert!(sig.tok.is_none());
    }

    #[test]
    fn test_parse_call_signal_request() {
        let plain = r#"{"vault":1,"id":"c1","type":"call_request","call_id":"call-abc","ts":1700000000,"sdp":"sdp","role":"caller","kemct":"k","sender_ek":"ek"}"#;
        let s = parse_call_signal(plain).unwrap();
        assert_eq!(s.id, "c1");
        assert_eq!(s.call_type, "call_request");
        assert_eq!(s.call_id, "call-abc");
        assert_eq!(s.ts, 1700000000);
        assert_eq!(s.sdp.as_deref(), Some("sdp"));
        assert_eq!(s.role.as_deref(), Some("caller"));
    }

    #[test]
    fn test_parse_call_signal_cancel() {
        let plain = r#"{"vault":1,"id":"c2","type":"call_cancel","call_id":"call-abc","ts":1700000001}"#;
        let s = parse_call_signal(plain).unwrap();
        assert_eq!(s.call_type, "call_cancel");
        assert!(s.sdp.is_none());
    }

    #[test]
    fn test_parse_call_signal_non_call_returns_none() {
        assert!(parse_call_signal(r#"{"vault":1,"text":"hi"}"#).is_none());
        assert!(parse_call_signal(r#"{"presence":1}"#).is_none());
        assert!(parse_call_signal("").is_none());
        assert!(parse_call_signal(r#"{"vault":1,"type":"not_call","call_id":"x"}"#).is_none());
    }
}
