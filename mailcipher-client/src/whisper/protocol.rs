use serde::{Deserialize, Serialize};

use super::status::MessageStatus;

/// Whisper message envelope (outer layer)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperEnvelope {
    /// Protocol version
    pub version: String,
    /// Message type
    pub msg_type: WhisperMsgType,
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
pub enum WhisperMsgType {
    /// Regular encrypted message
    Message,
    /// Status receipt (sent/delivered/read)
    Receipt,
    /// Key exchange
    KeyExchange,
    /// Key verification request
    KeyVerify,
}

impl WhisperMsgType {
    pub fn as_str(&self) -> &str {
        match self {
            WhisperMsgType::Message => "message",
            WhisperMsgType::Receipt => "receipt",
            WhisperMsgType::KeyExchange => "key_exchange",
            WhisperMsgType::KeyVerify => "key_verify",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "message" => Some(WhisperMsgType::Message),
            "receipt" => Some(WhisperMsgType::Receipt),
            "key_exchange" => Some(WhisperMsgType::KeyExchange),
            "key_verify" => Some(WhisperMsgType::KeyVerify),
            _ => None,
        }
    }
}

/// Encrypted Whisper message content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperMessage {
    /// Envelope (unencrypted metadata)
    pub envelope: WhisperEnvelope,
    /// Encrypted payload (Base64)
    pub encrypted_payload: String,
}

impl WhisperMessage {
    /// Create a new message
    pub fn new(from: &str, to: &str, message_id: &str, encrypted: &str) -> Self {
        Self {
            envelope: WhisperEnvelope {
                version: "1".to_string(),
                msg_type: WhisperMsgType::Message,
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
            envelope: WhisperEnvelope {
                version: "1".to_string(),
                msg_type: WhisperMsgType::Message,
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
            envelope: WhisperEnvelope {
                version: "1".to_string(),
                msg_type: WhisperMsgType::Receipt,
                from: from.to_string(),
                to: to.to_string(),
                message_id: message_id.to_string(),
                in_reply_to: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
            },
            encrypted_payload: payload.to_string(),
        }
    }

    /// Serialize to Whisper email format
    pub fn to_email_body(&self) -> String {
        let envelope_json = serde_json::to_string(&self.envelope)
            .expect("Failed to serialize envelope");
        format!(
            "X-Whisper-Encrypted: 1\nX-Whisper-Type: {}\nX-Whisper-ID: {}\nX-Whisper-From: {}\nX-Whisper-Reply-To: {}\n\n{}\n{}",
            self.envelope.msg_type.as_str(),
            self.envelope.message_id,
            self.envelope.from,
            self.envelope.in_reply_to.as_deref().unwrap_or(""),
            envelope_json,
            self.encrypted_payload,
        )
    }

    /// Parse from email body
    pub fn from_email_body(body: &str) -> Option<Self> {
        let parts: Vec<&str> = body.splitn(2, "\n\n").collect();
        if parts.len() < 2 {
            return None;
        }

        let envelope: WhisperEnvelope = serde_json::from_str(parts[1]).ok()?;
        let encrypted_payload = parts[0].to_string();

        Some(Self {
            envelope,
            encrypted_payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whisper_message_new() {
        let msg = WhisperMessage::new("alice@test.com", "bob@test.com", "msg-1", "encrypted");
        assert_eq!(msg.envelope.version, "1");
        assert_eq!(msg.envelope.msg_type, WhisperMsgType::Message);
        assert_eq!(msg.envelope.from, "alice@test.com");
        assert_eq!(msg.envelope.to, "bob@test.com");
        assert!(msg.envelope.in_reply_to.is_none());
    }

    #[test]
    fn test_whisper_message_reply() {
        let msg = WhisperMessage::reply(
            "bob@test.com", "alice@test.com", "msg-2", "msg-1", "encrypted"
        );
        assert_eq!(msg.envelope.in_reply_to, Some("msg-1".to_string()));
    }

    #[test]
    fn test_whisper_receipt() {
        let msg = WhisperMessage::receipt(
            "bob@test.com", "alice@test.com", "msg-1", MessageStatus::Delivered
        );
        assert_eq!(msg.envelope.msg_type, WhisperMsgType::Receipt);
    }

    #[test]
    fn test_msg_type_roundtrip() {
        let types = vec![
            WhisperMsgType::Message,
            WhisperMsgType::Receipt,
            WhisperMsgType::KeyExchange,
            WhisperMsgType::KeyVerify,
        ];
        for t in types {
            let s = t.as_str();
            assert_eq!(WhisperMsgType::from_str(s), Some(t));
        }
    }

    #[test]
    fn test_email_body_format() {
        let msg = WhisperMessage::new("a@test.com", "b@test.com", "m1", "payload");
        let body = msg.to_email_body();
        assert!(body.contains("X-Whisper-Encrypted: 1"));
        assert!(body.contains("X-Whisper-Type: message"));
        assert!(body.contains("X-Whisper-ID: m1"));
    }
}
