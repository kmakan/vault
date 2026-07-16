use crate::api::email::EmailMessage;

/// Whisper email protocol markers
pub const WHISPER_HEADER: &str = "X-Whisper-Encrypted";
pub const WHISPER_VERSION: &str = "1";
pub const WHISPER_SUBJECT_PREFIX: &str = "[WHISPER]";
pub const WHISPER_RECEIPT_PREFIX: &str = "[WHISPER-RECEIPT]";

/// Filter for identifying Whisper emails vs regular emails
pub struct WhisperFilter;

impl WhisperFilter {
    /// Check if an email is a Whisper message (not a receipt)
    pub fn is_whisper_message(msg: &EmailMessage) -> bool {
        let subject_has_marker = msg.subject.starts_with(WHISPER_SUBJECT_PREFIX);
        let body_has_marker = msg
            .body
            .contains(&format!("{}: {}", WHISPER_HEADER, WHISPER_VERSION));
        subject_has_marker || body_has_marker
    }

    /// Check if an email is a Whisper receipt (status confirmation)
    pub fn is_whisper_receipt(msg: &EmailMessage) -> bool {
        msg.subject.starts_with(WHISPER_RECEIPT_PREFIX)
    }

    /// Check if an email is any Whisper-related message
    pub fn is_whisper_any(msg: &EmailMessage) -> bool {
        Self::is_whisper_message(msg) || Self::is_whisper_receipt(msg)
    }

    /// Check if a subject line indicates a Whisper message
    pub fn has_whisper_subject(subject: &str) -> bool {
        subject.starts_with(WHISPER_SUBJECT_PREFIX) || subject.starts_with(WHISPER_RECEIPT_PREFIX)
    }

    /// Strip the Whisper prefix from subject for display
    pub fn clean_subject(subject: &str) -> String {
        subject
            .strip_prefix(WHISPER_SUBJECT_PREFIX)
            .or_else(|| subject.strip_prefix(WHISPER_RECEIPT_PREFIX))
            .unwrap_or(subject)
            .trim()
            .to_string()
    }

    /// Create a Whisper subject line
    pub fn make_subject(original: &str) -> String {
        format!("{} {}", WHISPER_SUBJECT_PREFIX, original)
    }

    /// Create a Whisper receipt subject line
    pub fn make_receipt_subject(original_msg_id: &str) -> String {
        format!("{} {}", WHISPER_RECEIPT_PREFIX, original_msg_id)
    }

    /// Add Whisper headers to email body
    pub fn wrap_body(body: &str, message_id: &str) -> String {
        format!(
            "{}: {}\nMessage-ID: {}\n\n{}",
            WHISPER_HEADER, WHISPER_VERSION, message_id, body
        )
    }

    /// Extract Message-ID from Whisper body
    pub fn extract_message_id(body: &str) -> Option<String> {
        body.lines()
            .find(|line| line.starts_with("Message-ID:"))
            .and_then(|line| line.splitn(2, ':').nth(1))
            .map(|id| id.trim().to_string())
    }

    /// Filter a list of messages, returning only Whisper messages
    pub fn filter_whisper_messages(messages: &[EmailMessage]) -> Vec<&EmailMessage> {
        messages
            .iter()
            .filter(|m| Self::is_whisper_message(m))
            .collect()
    }

    /// Filter out regular (non-Whisper) messages
    pub fn exclude_whisper(messages: &[EmailMessage]) -> Vec<&EmailMessage> {
        messages
            .iter()
            .filter(|m| !Self::is_whisper_any(m))
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
    fn test_is_whisper_message_by_subject() {
        let msg = make_msg("[WHISPER] Hello", "plain text");
        assert!(WhisperFilter::is_whisper_message(&msg));
    }

    #[test]
    fn test_is_whisper_message_by_body() {
        let msg = make_msg("Re: Hello", "X-Whisper-Encrypted: 1\nencrypted data");
        assert!(WhisperFilter::is_whisper_message(&msg));
    }

    #[test]
    fn test_regular_email_not_whisper() {
        let msg = make_msg("Meeting tomorrow", "Hi, let's meet at 3pm");
        assert!(!WhisperFilter::is_whisper_message(&msg));
        assert!(!WhisperFilter::is_whisper_any(&msg));
    }

    #[test]
    fn test_is_whisper_receipt() {
        let msg = make_msg("[WHISPER-RECEIPT] msg-123", "status: delivered");
        assert!(WhisperFilter::is_whisper_receipt(&msg));
        assert!(WhisperFilter::is_whisper_any(&msg));
    }

    #[test]
    fn test_clean_subject() {
        assert_eq!(WhisperFilter::clean_subject("[WHISPER] Hello"), "Hello");
        assert_eq!(
            WhisperFilter::clean_subject("[WHISPER-RECEIPT] msg-1"),
            "msg-1"
        );
        assert_eq!(WhisperFilter::clean_subject("Regular"), "Regular");
    }

    #[test]
    fn test_make_subject() {
        assert_eq!(WhisperFilter::make_subject("Hello"), "[WHISPER] Hello");
    }

    #[test]
    fn test_wrap_body() {
        let body = WhisperFilter::wrap_body("encrypted content", "msg-42");
        assert!(body.contains("X-Whisper-Encrypted: 1"));
        assert!(body.contains("Message-ID: msg-42"));
        assert!(body.contains("encrypted content"));
    }

    #[test]
    fn test_extract_message_id() {
        let body = "X-Whisper-Encrypted: 1\nMessage-ID: abc-123\n\nencrypted";
        assert_eq!(
            WhisperFilter::extract_message_id(body),
            Some("abc-123".to_string())
        );
    }

    #[test]
    fn test_filter_whisper_messages() {
        let messages = vec![
            make_msg("[WHISPER] Hi", "body"),
            make_msg("Meeting", "body"),
            make_msg("[WHISPER] Bye", "body"),
        ];
        let whisper = WhisperFilter::filter_whisper_messages(&messages);
        assert_eq!(whisper.len(), 2);
    }

    #[test]
    fn test_exclude_whisper() {
        let messages = vec![
            make_msg("[WHISPER] Hi", "body"),
            make_msg("Meeting", "body"),
            make_msg("[WHISPER-RECEIPT] x", "body"),
        ];
        let regular = WhisperFilter::exclude_whisper(&messages);
        assert_eq!(regular.len(), 1);
        assert_eq!(regular[0].subject, "Meeting");
    }
}
