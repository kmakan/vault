use serde::{Deserialize, Serialize};

use super::status::MessageStatus;

/// Vault message envelope (outer layer)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEnvelope {
    /// Protocol version
    pub version: String,
    /// Message type
    pub msg_type: VaultMsgType,
    /// Sender email
    pub from: String,
    /// Recipient email
    pub to: String,
    /// Unique message ID
    pub message_id: String,
    /// In-Reply-To message ID (for threading)
    pub in_reply_to: Option<String>,
    /// Timestamp
    pub timestamp: String,
}

/// Message type
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VaultMsgType {
    /// Regular encrypted message
    Message,
    /// Status receipt (sent/delivered/read)
    Receipt,
    /// Key exchange
    KeyExchange,
    /// Key verification request
    KeyVerify,
}

impl VaultMsgType {
    pub fn as_str(&self) -> &str {
        match self {
            VaultMsgType::Message => "message",
            VaultMsgType::Receipt => "receipt",
            VaultMsgType::KeyExchange => "key_exchange",
            VaultMsgType::KeyVerify => "key_verify",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "message" => Some(VaultMsgType::Message),
            "receipt" => Some(VaultMsgType::Receipt),
            "key_exchange" => Some(VaultMsgType::KeyExchange),
            "key_verify" => Some(VaultMsgType::KeyVerify),
            _ => None,
        }
    }
}

/// Encrypted Vault message content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMessage {
    /// Envelope (unencrypted metadata)
    pub envelope: VaultEnvelope,
    /// Encrypted payload (Base64)
    pub encrypted_payload: String,
}

impl VaultMessage {
    /// Create a new message
    pub fn new(from: &str, to: &str, message_id: &str, encrypted: &str) -> Self {
        Self {
            envelope: VaultEnvelope {
                version: "1".to_string(),
                msg_type: VaultMsgType::Message,
                from: from.to_string(),
                to: to.to_string(),
                message_id: message_id.to_string(),
                in_reply_to: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
            },
            encrypted_payload: encrypted.to_string(),
        }
    }

    /// Create a reply to another message
    pub fn reply(from: &str, to: &str, message_id: &str, reply_to: &str, encrypted: &str) -> Self {
        Self {
            envelope: VaultEnvelope {
                version: "1".to_string(),
                msg_type: VaultMsgType::Message,
                from: from.to_string(),
                to: to.to_string(),
                message_id: message_id.to_string(),
                in_reply_to: Some(reply_to.to_string()),
                timestamp: chrono::Utc::now().to_rfc3339(),
            },
            encrypted_payload: encrypted.to_string(),
        }
    }

    /// Create a status receipt
    pub fn receipt(from: &str, to: &str, message_id: &str, status: MessageStatus) -> Self {
        let payload = serde_json::json!({
            "status": status.as_str(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        Self {
            envelope: VaultEnvelope {
                version: "1".to_string(),
                msg_type: VaultMsgType::Receipt,
                from: from.to_string(),
                to: to.to_string(),
                message_id: message_id.to_string(),
                in_reply_to: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
            },
            encrypted_payload: payload.to_string(),
        }
    }

    /// Serialize to Vault email format
    pub fn to_email_body(&self) -> String {
        let envelope_json =
            serde_json::to_string(&self.envelope).expect("Failed to serialize envelope");
        format!(
            "X-Vault-Encrypted: 1\nX-Vault-Type: {}\nX-Vault-ID: {}\nX-Vault-From: {}\nX-Vault-Reply-To: {}\n\n{}\n{}",
            self.envelope.msg_type.as_str(),
            self.envelope.message_id,
            self.envelope.from,
            self.envelope.in_reply_to.as_deref().unwrap_or(""),
            envelope_json,
            self.encrypted_payload,
        )
    }

    /// Parse from email body — обратная к [`Self::to_email_body`].
    ///
    /// Формат: блок X-заголовков, пустая строка, `envelope_json`, перевод
    /// строки, `encrypted_payload` (payload может содержать переводы строк —
    /// поэтому берём остаток целиком, а не первую строку).
    ///
    /// ВАЖНО: это НЕ транспорт shipping-приложения. Desktop и CLI шлют
    /// stealth-письмо: пустая тема, в теле — сам wrapped JSON (`{vault:1,…}`),
    /// без `X-Vault-*` заголовков (см. `vault-desktop/src-tauri/src/lib.rs`,
    /// `recovery_build_escrow_email`, и `features/channels.js`). Этот вариант
    /// конверта оставлен как отдельный, X-header, формат — в проде не
    /// используется; контракт обмена — payload JSON (см. `incoming::classify`).
    pub fn from_email_body(body: &str) -> Option<Self> {
        let (_, rest) = body.split_once("\n\n")?;
        let (envelope_json, encrypted_payload) = rest.split_once('\n')?;
        let envelope: VaultEnvelope = serde_json::from_str(envelope_json).ok()?;

        Some(Self {
            envelope,
            encrypted_payload: encrypted_payload.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_message_new() {
        let msg = VaultMessage::new("alice@test.com", "bob@test.com", "msg-1", "encrypted");
        assert_eq!(msg.envelope.version, "1");
        assert_eq!(msg.envelope.msg_type, VaultMsgType::Message);
        assert_eq!(msg.envelope.from, "alice@test.com");
        assert_eq!(msg.envelope.to, "bob@test.com");
        assert!(msg.envelope.in_reply_to.is_none());
    }

    #[test]
    fn test_vault_message_reply() {
        let msg = VaultMessage::reply(
            "bob@test.com",
            "alice@test.com",
            "msg-2",
            "msg-1",
            "encrypted",
        );
        assert_eq!(msg.envelope.in_reply_to, Some("msg-1".to_string()));
    }

    #[test]
    fn test_vault_receipt() {
        let msg = VaultMessage::receipt(
            "bob@test.com",
            "alice@test.com",
            "msg-1",
            MessageStatus::Delivered,
        );
        assert_eq!(msg.envelope.msg_type, VaultMsgType::Receipt);
    }

    #[test]
    fn test_msg_type_roundtrip() {
        let types = vec![
            VaultMsgType::Message,
            VaultMsgType::Receipt,
            VaultMsgType::KeyExchange,
            VaultMsgType::KeyVerify,
        ];
        for t in types {
            let s = t.as_str();
            assert_eq!(VaultMsgType::from_str(s), Some(t));
        }
    }

    #[test]
    fn test_email_body_format() {
        let msg = VaultMessage::new("a@test.com", "b@test.com", "m1", "payload");
        let body = msg.to_email_body();
        assert!(body.contains("X-Vault-Encrypted: 1"));
        assert!(body.contains("X-Vault-Type: message"));
        assert!(body.contains("X-Vault-ID: m1"));
    }

    /// `from_email_body(to_email_body(m)) == m` — иначе writer и reader
    /// расходятся, и письмо, отправленное одним кодом, не читается другим.
    #[test]
    fn test_email_body_roundtrip() {
        let msg = VaultMessage::new("a@test.com", "b@test.com", "m1", "cGF5bG9hZA==");
        let body = msg.to_email_body();
        let parsed = VaultMessage::from_email_body(&body).expect("roundtrip: body должен разбираться");
        assert_eq!(parsed.envelope.version, msg.envelope.version);
        assert_eq!(parsed.envelope.msg_type, VaultMsgType::Message);
        assert_eq!(parsed.envelope.from, "a@test.com");
        assert_eq!(parsed.envelope.to, "b@test.com");
        assert_eq!(parsed.envelope.message_id, "m1");
        assert_eq!(parsed.encrypted_payload, "cGF5bG9hZA==");
        assert!(parsed.envelope.in_reply_to.is_none());
    }

    /// Roundtrip письма-ответа: in_reply_to должен пережить и пустой
    /// X-Vault-Reply-To (не «null»), и непустой.
    #[test]
    fn test_email_body_roundtrip_reply() {
        let msg = VaultMessage::reply("b@test.com", "a@test.com", "m2", "m1", "cA==");
        let parsed = VaultMessage::from_email_body(&msg.to_email_body()).expect("roundtrip reply");
        assert_eq!(parsed.envelope.in_reply_to, Some("m1".to_string()));
        assert_eq!(parsed.encrypted_payload, "cA==");
    }

    /// Тело без разделителя заголовок/тело — не конверт, а мусор.
    #[test]
    fn test_from_email_body_garbage() {
        assert!(VaultMessage::from_email_body("обычное письмо без конверта").is_none());
    }

    /// Заголовки конверта — ЧАСТЬ ФОРМАТА, а не украшение: по X-Vault-From
    /// получатель знает, кто прислал, по X-Vault-ID — дедуплицирует. Раньше
    /// это не проверялось, и подмена на пустую строку оставалась зелёной.
    #[test]
    fn test_to_email_body_headers() {
        let msg = VaultMessage::new("alice@test.com", "bob@test.com", "msg-7", "payload");
        let body = msg.to_email_body();
        assert!(body.starts_with("X-Vault-Encrypted: 1\n"), "{}", body);
        assert!(body.contains("X-Vault-Type: message\n"), "{}", body);
        assert!(body.contains("X-Vault-ID: msg-7\n"), "{}", body);
        assert!(body.contains("X-Vault-From: alice@test.com\n"), "{}", body);
        assert!(body.contains("X-Vault-Reply-To: \n"), "{}", body);
    }

    /// Конверт БЕЗ payload — не конверт: расшифровывать нечего, и принять
    /// такое — значит потом получить «пустое сообщение» вместо ошибки.
    /// Мутационный гейт Rust-ядра выловил, что этого правила в тестах не было.
    #[test]
    fn test_from_email_body_without_payload_rejects() {
        let msg = VaultMessage::new("a@test.com", "b@test.com", "m4", "payload");
        // Обрезаем всё после envelope_json — остаётся заголовок + json.
        let body = msg.to_email_body();
        let cut = body
            .split_once("\n\n")
            .map(|(_, rest)| rest.split_once('\n').map(|(j, _)| j.to_string()))
            .flatten()
            .unwrap_or_default();
        let with_json_only = format!("X-Vault-Encrypted: 1\n\n{}", cut);
        assert!(
            VaultMessage::from_email_body(&with_json_only).is_none(),
            "конверт без payload приниматься не должен"
        );
    }

    /// Payload может содержать переводы строк (шифротекст base64 разбит на
    /// строки) — поэтому берётся ОСТАТОК целиком, а не первая строка.
    #[test]
    fn test_from_email_body_keeps_multiline_payload() {
        let msg = VaultMessage::new("a@test.com", "b@test.com", "m3", "line1\nline2\nline3");
        let parsed = VaultMessage::from_email_body(&msg.to_email_body()).expect("roundtrip");
        assert_eq!(parsed.encrypted_payload, "line1\nline2\nline3");
    }
}
