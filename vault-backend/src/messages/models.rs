use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Message {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub chat_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub email_message_id: Option<String>,
    pub email_account_id: Option<Uuid>,
    pub subject: Option<String>,
    pub content_type: Option<String>,
    pub encrypted_content: Option<String>,
    pub signature: Option<String>,
    pub is_read: bool,
    pub is_sent: bool,
    pub sent_at: Option<DateTime<Utc>>,
    pub received_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateMessageRequest {
    pub content: String,
    pub subject: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub chat_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub subject: Option<String>,
    pub content: Option<String>,
    pub content_type: Option<String>,
    pub signature: Option<String>,
    pub is_read: bool,
    pub is_sent: bool,
    pub sent_at: Option<DateTime<Utc>>,
    pub received_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<Message> for MessageResponse {
    fn from(msg: Message) -> Self {
        MessageResponse {
            id: msg.id,
            sender_id: msg.sender_id,
            chat_id: msg.chat_id,
            group_id: msg.group_id,
            subject: msg.subject,
            content: msg.encrypted_content,
            content_type: msg.content_type,
            signature: msg.signature,
            is_read: msg.is_read,
            is_sent: msg.is_sent,
            sent_at: msg.sent_at,
            received_at: msg.received_at,
            created_at: msg.created_at,
        }
    }
}
