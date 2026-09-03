use serde::{Deserialize, Serialize};

/// Message delivery status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageStatus {
    /// Message was sent (SMTP accepted)
    Sent,
    /// Message was delivered (IMAP fetch confirmed by recipient)
    Delivered,
    /// Message was read (recipient opened it)
    Read,
}

impl MessageStatus {
    /// Display icon for status
    pub fn icon(&self) -> &str {
        match self {
            MessageStatus::Sent => "✓",
            MessageStatus::Delivered => "✓✓",
            MessageStatus::Read => "✓✓",
        }
    }

    /// Color name for terminal display
    pub fn color(&self) -> &str {
        match self {
            MessageStatus::Sent => "gray",
            MessageStatus::Delivered => "white",
            MessageStatus::Read => "blue",
        }
    }

    /// Parse from string
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "sent" => Some(MessageStatus::Sent),
            "delivered" => Some(MessageStatus::Delivered),
            "read" => Some(MessageStatus::Read),
            _ => None,
        }
    }

    /// Convert to string
    pub fn as_str(&self) -> &str {
        match self {
            MessageStatus::Sent => "sent",
            MessageStatus::Delivered => "delivered",
            MessageStatus::Read => "read",
        }
    }
}

impl std::fmt::Display for MessageStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.icon())
    }
}

/// Encrypted status receipt
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusReceipt {
    /// Original message ID this receipt is for
    pub message_id: String,
    /// New status
    pub status: MessageStatus,
    /// Timestamp of status change
    pub timestamp: String,
    /// Email of the person reporting status
    pub from_email: String,
}

impl StatusReceipt {
    pub fn new(message_id: &str, status: MessageStatus, from_email: &str) -> Self {
        Self {
            message_id: message_id.to_string(),
            status,
            timestamp: chrono::Utc::now().to_rfc3339(),
            from_email: from_email.to_string(),
        }
    }

    /// Serialize to encrypted payload
    pub fn to_payload(&self) -> String {
        serde_json::to_string(self).expect("Failed to serialize receipt")
    }

    /// Deserialize from payload
    pub fn from_payload(payload: &str) -> Option<Self> {
        serde_json::from_str(payload).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_icons() {
        assert_eq!(MessageStatus::Sent.icon(), "✓");
        assert_eq!(MessageStatus::Delivered.icon(), "✓✓");
        assert_eq!(MessageStatus::Read.icon(), "✓✓");
    }

    #[test]
    fn test_status_display() {
        assert_eq!(format!("{}", MessageStatus::Sent), "✓");
        assert_eq!(format!("{}", MessageStatus::Delivered), "✓✓");
        assert_eq!(format!("{}", MessageStatus::Read), "✓✓");
    }

    #[test]
    fn test_status_from_str() {
        assert_eq!(MessageStatus::from_str("sent"), Some(MessageStatus::Sent));
        assert_eq!(
            MessageStatus::from_str("DELIVERED"),
            Some(MessageStatus::Delivered)
        );
        assert_eq!(MessageStatus::from_str("read"), Some(MessageStatus::Read));
        assert_eq!(MessageStatus::from_str("unknown"), None);
    }

    #[test]
    fn test_receipt_roundtrip() {
        let receipt = StatusReceipt::new("msg-42", MessageStatus::Delivered, "alice@example.com");
        let payload = receipt.to_payload();
        let parsed = StatusReceipt::from_payload(&payload).unwrap();
        assert_eq!(parsed.message_id, "msg-42");
        assert_eq!(parsed.status, MessageStatus::Delivered);
        assert_eq!(parsed.from_email, "alice@example.com");
    }
}
