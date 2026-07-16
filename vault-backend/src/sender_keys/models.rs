use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Stored sender key for a group member
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SenderKey {
    pub id: Uuid,
    pub group_id: Uuid,
    pub user_id: Uuid,
    /// The sender's X25519 identity public key (base64)
    pub identity_public_key: String,
    /// Chain key used to derive message keys (encrypted, base64)
    pub chain_key_encrypted: String,
    /// Current signing key derived from chain key (public, base64)
    pub signing_key_public: String,
    /// Current signing key (encrypted, base64)
    pub signing_key_encrypted: String,
    /// Message counter - incremented with each message
    pub message_count: i64,
    /// Ratchet threshold - rotate chain after this many messages
    pub ratchet_threshold: i32,
    /// Key version - incremented on rotation
    pub key_version: i32,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Pending sender key distribution (encrypted for specific recipient)
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SenderKeyDistribution {
    pub id: Uuid,
    pub group_id: Uuid,
    pub sender_id: Uuid,
    pub recipient_id: Uuid,
    /// Encrypted chain key for recipient (encrypted with shared secret)
    pub encrypted_chain_key: String,
    /// Sender's identity public key
    pub sender_identity_key: String,
    /// Key version being distributed
    pub key_version: i32,
    /// Whether recipient has acknowledged receipt
    pub acknowledged: bool,
    pub created_at: DateTime<Utc>,
}

/// Request to send a group message with sender key encryption
#[derive(Debug, Deserialize)]
pub struct SendGroupMessageRequest {
    pub content: String,
    pub subject: Option<String>,
    pub content_type: Option<String>,
}

/// Response with sender key info
#[derive(Debug, Serialize)]
pub struct SenderKeyResponse {
    pub group_id: Uuid,
    pub user_id: Uuid,
    pub identity_public_key: String,
    pub signing_key_public: String,
    pub key_version: i32,
    pub message_count: i64,
}

impl From<SenderKey> for SenderKeyResponse {
    fn from(key: SenderKey) -> Self {
        SenderKeyResponse {
            group_id: key.group_id,
            user_id: key.user_id,
            identity_public_key: key.identity_public_key,
            signing_key_public: key.signing_key_public,
            key_version: key.key_version,
            message_count: key.message_count,
        }
    }
}

/// Request to distribute sender key to a member
#[derive(Debug, Deserialize)]
pub struct DistributeKeyRequest {
    pub recipient_id: Uuid,
}

/// Response for key distribution status
#[derive(Debug, Serialize)]
pub struct DistributionStatus {
    pub group_id: Uuid,
    pub distributions: Vec<DistributionInfo>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DistributionInfo {
    pub recipient_id: Uuid,
    pub acknowledged: bool,
    pub key_version: i32,
    pub distributed_at: DateTime<Utc>,
}
