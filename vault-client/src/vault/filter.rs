use crate::api::email::EmailMessage;

/// Vault email protocol markers
pub const VAULT_HEADER: &str = "X-Vault-Encrypted";
pub const VAULT_VERSION: &str = "1";
pub const VAULT_SUBJECT_PREFIX: &str = "[VAULT]";
pub const VAULT_RECEIPT_PREFIX: &str = "[VAULT-RECEIPT]";

/// Filter for identifying Vault emails vs regular emails
pub struct VaultFilter;

impl VaultFilter {
    /// Check if an email is a Vault message (not a receipt)
    pub fn is_vault_message(msg: &EmailMessage) -> bool {
        let subject_has_marker = msg.subject.starts_with(VAULT_SUBJECT_PREFIX);
        let body_has_marker = msg
            .body
            .contains(&format!("{}: {}", VAULT_HEADER, VAULT_VERSION));
        subject_has_marker || body_has_marker
    }

    /// Check if an email is a Vault receipt (status confirmation)
    pub fn is_vault_receipt(msg: &EmailMessage) -> bool {
        msg.subject.starts_with(VAULT_RECEIPT_PREFIX)
    }

    /// Check if an email is any Vault-related message
    pub fn is_vault_any(msg: &EmailMessage) -> bool {
        Self::is_vault_message(msg) || Self::is_vault_receipt(msg)
    }

    /// Check if a subject line indicates a Vault message
    pub fn has_vault_subject(subject: &str) -> bool {
        subject.starts_with(VAULT_SUBJECT_PREFIX) || subject.starts_with(VAULT_RECEIPT_PREFIX)
    }

    /// Strip the Vault prefix from subject for display
    pub fn clean_subject(subject: &str) -> String {
        subject
            .strip_prefix(VAULT_SUBJECT_PREFIX)
            .or_else(|| subject.strip_prefix(VAULT_RECEIPT_PREFIX))
            .unwrap_or(subject)
            .trim()
            .to_string()
    }

    /// Create a Vault subject line
    pub fn make_subject(original: &str) -> String {
        format!("{} {}", VAULT_SUBJECT_PREFIX, original)
    }

    /// Create a Vault receipt subject line
    pub fn make_receipt_subject(original_msg_id: &str) -> String {
        format!("{} {}", VAULT_RECEIPT_PREFIX, original_msg_id)
    }

    /// Add Vault headers to email body
    pub fn wrap_body(body: &str, message_id: &str) -> String {
        format!(
            "{}: {}\nMessage-ID: {}\n\n{}",
            VAULT_HEADER, VAULT_VERSION, message_id, body
        )
    }

    /// Extract Message-ID from Vault body
    pub fn extract_message_id(body: &str) -> Option<String> {
        body.lines()
            .find(|line| line.starts_with("Message-ID:"))
            .and_then(|line| line.splitn(2, ':').nth(1))
            .map(|id| id.trim().to_string())
    }

    /// Filter a list of messages, returning only Vault messages
    pub fn filter_vault_messages(messages: &[EmailMessage]) -> Vec<&EmailMessage> {
        messages
            .iter()
            .filter(|m| Self::is_vault_message(m))
            .collect()
    }

    /// Filter out regular (non-Vault) messages
    pub fn exclude_vault(messages: &[EmailMessage]) -> Vec<&EmailMessage> {
        messages
            .iter()
            .filter(|m| !Self::is_vault_any(m))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_msg(subject: &str, body: &str) -> EmailMessage {
        EmailMessage {
            id: "1".to_string(),
            from: "test@example.com".to_string(),
            to: "me@example.com".to_string(),
            subject: subject.to_string(),
            body: body.to_string(),
            date: "2026-01-01".to_string(),
            is_read: false,
        }
    }

    #[test]
    fn test_is_vault_message_by_subject() {
        let msg = make_msg("[VAULT] Hello", "plain text");
        assert!(VaultFilter::is_vault_message(&msg));
    }

    #[test]
    fn test_is_vault_message_by_body() {
        let msg = make_msg("Re: Hello", "X-Vault-Encrypted: 1\nencrypted data");
        assert!(VaultFilter::is_vault_message(&msg));
    }

    #[test]
    fn test_regular_email_not_vault() {
        let msg = make_msg("Meeting tomorrow", "Hi, let's meet at 3pm");
        assert!(!VaultFilter::is_vault_message(&msg));
        assert!(!VaultFilter::is_vault_any(&msg));
    }

    #[test]
    fn test_is_vault_receipt() {
        let msg = make_msg("[VAULT-RECEIPT] msg-123", "status: delivered");
        assert!(VaultFilter::is_vault_receipt(&msg));
        assert!(VaultFilter::is_vault_any(&msg));
    }

    #[test]
    fn test_clean_subject() {
        assert_eq!(VaultFilter::clean_subject("[VAULT] Hello"), "Hello");
        assert_eq!(
            VaultFilter::clean_subject("[VAULT-RECEIPT] msg-1"),
            "msg-1"
        );
        assert_eq!(VaultFilter::clean_subject("Regular"), "Regular");
    }

    #[test]
    fn test_make_subject() {
        assert_eq!(VaultFilter::make_subject("Hello"), "[VAULT] Hello");
    }

    #[test]
    fn test_wrap_body() {
        let body = VaultFilter::wrap_body("encrypted content", "msg-42");
        assert!(body.contains("X-Vault-Encrypted: 1"));
        assert!(body.contains("Message-ID: msg-42"));
        assert!(body.contains("encrypted content"));
    }

    #[test]
    fn test_extract_message_id() {
        let body = "X-Vault-Encrypted: 1\nMessage-ID: abc-123\n\nencrypted";
        assert_eq!(
            VaultFilter::extract_message_id(body),
            Some("abc-123".to_string())
        );
    }

    #[test]
    fn test_filter_vault_messages() {
        let messages = vec![
            make_msg("[VAULT] Hi", "body"),
            make_msg("Meeting", "body"),
            make_msg("[VAULT] Bye", "body"),
        ];
        let vault_msgs = VaultFilter::filter_vault_messages(&messages);
        assert_eq!(vault_msgs.len(), 2);
    }

    #[test]
    fn test_exclude_vault() {
        let messages = vec![
            make_msg("[VAULT] Hi", "body"),
            make_msg("Meeting", "body"),
            make_msg("[VAULT-RECEIPT] x", "body"),
        ];
        let regular = VaultFilter::exclude_vault(&messages);
        assert_eq!(regular.len(), 1);
        assert_eq!(regular[0].subject, "Meeting");
    }
}
