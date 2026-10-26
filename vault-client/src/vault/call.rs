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

/// Собрать конверт сигнала звонка — обратная сторона `parse_call_signal`.
///
/// Формат здесь, а не в вызывающей стороне: получатель разбирает письмо по
/// тем же правилам, и пока сборка была описана в трёх местах внутри
/// `service_monitor.rs` (два звонковых сигнала и SOS), ни одна из копий не
/// была видна гейтам — тот модуль компилируется только под
/// `cfg(target_os = "android")`, и мутационный прогон с хоста его не
/// компилирует вовсе.
///
/// Порядок полей зафиксирован (`vault`, `id`, `type`, `call_id`, `ts`, затем
/// необязательные) и совпадает с JS-сборкой `sendCallEnvelope`: порядок ключей
/// в JSON разбору не мешает, но обе стороны обязаны писать одно и то же,
/// иначе «одинаковые» конверты перестают сравниваться где-нибудь позже.
pub fn build_call_signal(sig: &CallSignal) -> String {
    #[derive(Serialize)]
    struct Wire<'a> {
        vault: u8,
        id: &'a str,
        #[serde(rename = "type")]
        call_type: &'a str,
        call_id: &'a str,
        ts: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        sdp: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        kemct: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sender_ek: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tok: Option<&'a str>,
    }
    let wire = Wire {
        vault: 1,
        id: &sig.id,
        call_type: &sig.call_type,
        call_id: &sig.call_id,
        ts: sig.ts,
        sdp: sig.sdp.as_deref(),
        role: sig.role.as_deref(),
        kemct: sig.kemct.as_deref(),
        sender_ek: sig.sender_ek.as_deref(),
        tok: sig.tok.as_deref(),
    };
    serde_json::to_string(&wire).unwrap_or_else(|_| "{}".to_string())
}

/// Конверт звонкового сигнала из сервис-процесса (activity нет): идентификатор
/// `{ts}na`. Суффикс — метка источника: получатель её не разбирает, но он
/// видит этот id в письме, и правило «какой id у сервиса» обязано жить с
/// форматом, а не копироваться в каждом вызове.
pub fn build_service_call_signal(call_type: &str, call_id: &str, ts_ms: i64) -> String {
    build_call_signal(&CallSignal {
        id: format!("{ts_ms}na"),
        call_type: call_type.to_string(),
        call_id: call_id.to_string(),
        ts: ts_ms,
        sdp: None,
        role: None,
        kemct: None,
        sender_ek: None,
        tok: None,
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

    // ── Сборка конверта сигнала (26.10) ──────────────────────────────────
    // Правило формата переехало из `service_monitor.rs`, где его нельзя было
    // измерить: модуль компилируется только под `cfg(target_os = "android")`,
    // и мутационный прогон с хоста его не компилирует вовсе. Пробы ниже —
    // единственная защита от «конверт собирается не тот».

    /// Собранный сервисный сигнал разбирается тем же ядром: маркер формата,
    /// тип, звон и время должны доехать. Литералы в проверке намеренные —
    /// сверять сборку с той же константой, которую она использует, значит
    /// измерять себя.
    #[test]
    fn service_call_signal_roundtrips_through_the_parser() {
        let json = build_service_call_signal("call_reject", "c-1", 1_700_000_000_000);
        let sig = parse_call_signal(&json).expect("собранный сигнал узнаётся разборщиком");
        assert_eq!(sig.call_type, "call_reject");
        assert_eq!(sig.call_id, "c-1");
        assert_eq!(sig.ts, 1_700_000_000_000);
        assert_eq!(sig.id, "1700000000000na", "метка сервисного процесса в id");
    }

    /// Конверт без SDP не должен везти `"sdp":null`: получатель отличает
    /// «поля нет» от «поле есть и оно null» (то же правило, что у
    /// `envelope::build`).
    #[test]
    fn service_call_signal_omits_absent_fields() {
        let json = build_service_call_signal("call_accept", "c-2", 10);
        for field in ["sdp", "role", "kemct", "sender_ek", "tok"] {
            assert!(
                !json.contains(&format!("\"{field}\"")),
                "поля `{field}` в конверте быть не должно: {json}"
            );
        }
        assert!(json.contains("\"vault\":1"), "маркер формата: {json}");
        assert!(json.contains("\"type\":\"call_accept\""), "тип под именем type: {json}");
    }

    /// Полный сигнал (offer с SDP и PQ) обязан доехать без потерь — иначе
    /// принимающий не соберёт media_key и звонок не соединится.
    #[test]
    fn full_call_signal_carries_every_optional_field() {
        let sig = CallSignal {
            id: "id-9".to_string(),
            call_type: "call_request".to_string(),
            call_id: "c-9".to_string(),
            ts: 42,
            sdp: Some("sdp-text".to_string()),
            role: Some("caller".to_string()),
            kemct: Some("kem".to_string()),
            sender_ek: Some("ek".to_string()),
            tok: Some("queue-token".to_string()),
        };
        let json = build_call_signal(&sig);
        let back = parse_call_signal(&json).expect("полный сигнал разобран");
        assert_eq!(back, sig, "сборка и разбор — одна модель");
    }
}
