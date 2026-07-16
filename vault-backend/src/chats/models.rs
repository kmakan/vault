use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Chat {
    pub id: Uuid,
    pub user1_id: Uuid,
    pub user2_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    pub user2_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub id: Uuid,
    pub user1_id: Uuid,
    pub user2_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<Chat> for ChatResponse {
    fn from(chat: Chat) -> Self {
        ChatResponse {
            id: chat.id,
            user1_id: chat.user1_id,
            user2_id: chat.user2_id,
            created_at: chat.created_at,
            updated_at: chat.updated_at,
        }
    }
}
