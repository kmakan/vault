use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::status::MessageStatus;

/// Storage file path: ~/.vault/read_receipts.json
fn receipts_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vault")
        .join("read_receipts.json")
}

/// A single read receipt record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadReceiptRecord {
    /// Original message ID
    pub message_id: String,
    /// Who read it (email)
    pub reader: String,
    /// Status at time of receipt
    pub status: MessageStatus,
    /// When it was read
    pub read_at: String,
    /// Original sender of the message
    pub sender: String,
}

/// Persistent store for read receipts, backed by ~/.vault/read_receipts.json
pub struct ReadReceiptStore {
    /// message_id → list of receipts (a message can be read by multiple people in groups)
    receipts: HashMap<String, Vec<ReadReceiptRecord>>,
    /// Path to the JSON file
    path: PathBuf,
}

impl ReadReceiptStore {
    /// Create a new store, loading from disk if available
    pub fn new() -> Self {
        let path = receipts_path();
        let receipts = Self::load_from_disk(&path).unwrap_or_default();
        Self { receipts, path }
    }

    /// Create a store with a custom path (for testing)
    pub fn with_path(path: PathBuf) -> Self {
        let receipts = Self::load_from_disk(&path).unwrap_or_default();
        Self { receipts, path }
    }

    /// Load receipts from disk
    fn load_from_disk(path: &PathBuf) -> Option<HashMap<String, Vec<ReadReceiptRecord>>> {
        let data = fs::read_to_string(path).ok()?;
        serde_json::from_str(&data).ok()
    }

    /// Save receipts to disk
    pub fn save(&self) -> Result<()> {
        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).context("Failed to create .vault directory")?;
        }

        let json =
            serde_json::to_string_pretty(&self.receipts).context("Failed to serialize receipts")?;
        fs::write(&self.path, json).context("Failed to write receipts file")?;
        Ok(())
    }

    /// Record that a message was read
    pub fn record_read(&mut self, message_id: &str, reader: &str, sender: &str) -> Result<()> {
        let record = ReadReceiptRecord {
            message_id: message_id.to_string(),
            reader: reader.to_string(),
            status: MessageStatus::Read,
            read_at: chrono::Utc::now().to_rfc3339(),
            sender: sender.to_string(),
        };

        self.receipts
            .entry(message_id.to_string())
            .or_insert_with(Vec::new)
            .push(record);

        self.save()
    }

    /// Record a delivery receipt
    pub fn record_delivered(&mut self, message_id: &str, reader: &str, sender: &str) -> Result<()> {
        let record = ReadReceiptRecord {
            message_id: message_id.to_string(),
            reader: reader.to_string(),
            status: MessageStatus::Delivered,
            read_at: chrono::Utc::now().to_rfc3339(),
            sender: sender.to_string(),
        };

        self.receipts
            .entry(message_id.to_string())
            .or_insert_with(Vec::new)
            .push(record);

        self.save()
    }

    /// Check if a message has been read by someone
    pub fn is_read(&self, message_id: &str) -> bool {
        self.receipts
            .get(message_id)
            .map(|records| records.iter().any(|r| r.status == MessageStatus::Read))
            .unwrap_or(false)
    }

    /// Check if a message has been delivered
    pub fn is_delivered(&self, message_id: &str) -> bool {
        self.receipts
            .get(message_id)
            .map(|records| records.iter().any(|r| r.status == MessageStatus::Delivered))
            .unwrap_or(false)
    }

    /// Get the latest status for a message
    pub fn get_status(&self, message_id: &str) -> Option<MessageStatus> {
        self.receipts
            .get(message_id)
            .and_then(|records| records.iter().max_by_key(|r| &r.read_at).map(|r| r.status))
    }

    /// Get all receipts for a message
    pub fn get_receipts(&self, message_id: &str) -> Vec<&ReadReceiptRecord> {
        self.receipts
            .get(message_id)
            .map(|records| records.iter().collect())
            .unwrap_or_default()
    }

    /// Get the status icon for a message (for display in inbox)
    pub fn status_icon(&self, message_id: &str, is_outgoing: bool) -> String {
        if !is_outgoing {
            // Incoming messages don't have outgoing receipt status
            return String::new();
        }

        match self.get_status(message_id) {
            Some(MessageStatus::Read) => " ✓✓".to_string(),
            Some(MessageStatus::Delivered) => " ✓✓".to_string(),
            Some(MessageStatus::Sent) => " ✓".to_string(),
            None => String::new(),
        }
    }

    /// Process an incoming receipt email body
    /// Returns (message_id, status, reader_email) if valid
    pub fn parse_receipt_body(body: &str) -> Option<(String, MessageStatus, String)> {
        // Receipt body format: JSON with status, timestamp
        let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
        let status_str = parsed.get("status")?.as_str()?;
        let status = MessageStatus::from_str(status_str)?;
        let reader = parsed.get("from_email")?.as_str()?.to_string();
        // Message ID comes from the envelope, but we can try to extract from body
        let message_id = parsed.get("message_id")?.as_str()?.to_string();
        Some((message_id, status, reader))
    }

    /// Get total count of tracked messages
    pub fn count(&self) -> usize {
        self.receipts.len()
    }

    /// Get total count of receipts across all messages
    pub fn total_receipts(&self) -> usize {
        self.receipts.values().map(|v| v.len()).sum()
    }

    /// Clear all receipts (for testing or reset)
    pub fn clear(&mut self) -> Result<()> {
        self.receipts.clear();
        self.save()
    }
}

impl Default for ReadReceiptStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vault_test_{}", uuid::Uuid::new_v4()));
        dir.join("read_receipts.json")
    }

    #[test]
    fn test_new_store_is_empty() {
        let path = temp_path();
        let store = ReadReceiptStore::with_path(path);
        assert_eq!(store.count(), 0);
        assert_eq!(store.total_receipts(), 0);
    }

    #[test]
    fn test_record_read() {
        let path = temp_path();
        let mut store = ReadReceiptStore::with_path(path.clone());
        store
            .record_read("msg-1", "alice@test.com", "bob@test.com")
            .unwrap();

        assert!(store.is_read("msg-1"));
        assert!(!store.is_read("msg-999"));
        assert_eq!(store.count(), 1);
        assert_eq!(store.total_receipts(), 1);

        // Cleanup
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_record_delivered() {
        let path = temp_path();
        let mut store = ReadReceiptStore::with_path(path.clone());
        store
            .record_delivered("msg-1", "alice@test.com", "bob@test.com")
            .unwrap();

        assert!(!store.is_read("msg-1"));
        assert!(store.is_delivered("msg-1"));
        assert_eq!(store.get_status("msg-1"), Some(MessageStatus::Delivered));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_multiple_receipts() {
        let path = temp_path();
        let mut store = ReadReceiptStore::with_path(path.clone());

        store
            .record_read("msg-1", "alice@test.com", "bob@test.com")
            .unwrap();
        store
            .record_read("msg-1", "carol@test.com", "bob@test.com")
            .unwrap();
        store
            .record_read("msg-2", "alice@test.com", "dave@test.com")
            .unwrap();

        assert_eq!(store.count(), 2);
        assert_eq!(store.total_receipts(), 3);

        let receipts = store.get_receipts("msg-1");
        assert_eq!(receipts.len(), 2);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_status_icon() {
        let path = temp_path();
        let mut store = ReadReceiptStore::with_path(path.clone());

        // No receipt → empty
        assert_eq!(store.status_icon("msg-1", true), "");

        // Incoming message → always empty
        store
            .record_read("msg-1", "alice@test.com", "bob@test.com")
            .unwrap();
        assert_eq!(store.status_icon("msg-1", false), "");

        // Outgoing with read → ✓✓
        assert_eq!(store.status_icon("msg-1", true), " ✓✓");

        // Outgoing with no receipt → empty
        assert_eq!(store.status_icon("msg-999", true), "");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_persistence() {
        let path = temp_path();
        {
            let mut store = ReadReceiptStore::with_path(path.clone());
            store
                .record_read("msg-1", "alice@test.com", "bob@test.com")
                .unwrap();
        }

        // Reload from disk
        let store = ReadReceiptStore::with_path(path.clone());
        assert!(store.is_read("msg-1"));
        assert_eq!(store.count(), 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_clear() {
        let path = temp_path();
        let mut store = ReadReceiptStore::with_path(path.clone());
        store
            .record_read("msg-1", "alice@test.com", "bob@test.com")
            .unwrap();
        store.clear().unwrap();
        assert_eq!(store.count(), 0);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_parse_receipt_body() {
        let body = serde_json::json!({
            "status": "read",
            "timestamp": "2026-07-15T12:00:00Z",
            "from_email": "alice@test.com",
            "message_id": "msg-42"
        });
        let result = ReadReceiptStore::parse_receipt_body(&body.to_string());
        assert!(result.is_some());
        let (msg_id, status, reader) = result.unwrap();
        assert_eq!(msg_id, "msg-42");
        assert_eq!(status, MessageStatus::Read);
        assert_eq!(reader, "alice@test.com");
    }

    #[test]
    fn test_parse_receipt_body_invalid() {
        assert!(ReadReceiptStore::parse_receipt_body("not json").is_none());
        assert!(ReadReceiptStore::parse_receipt_body("{}").is_none());
    }

    #[test]
    fn test_empty_path_no_panic() {
        // Non-existent path should just return empty store
        let path = PathBuf::from("/tmp/nonexistent_vault_test_dir/read_receipts.json");
        let store = ReadReceiptStore::with_path(path);
        assert_eq!(store.count(), 0);
    }
}
