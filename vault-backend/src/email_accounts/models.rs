use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct EmailAccount {
    pub id: Uuid,
    pub user_id: Uuid,
    pub email: String,
    pub imap_server: String,
    pub imap_port: i32,
    pub smtp_server: String,
    pub smtp_port: i32,
    pub username: String,
    pub password_encrypted: String,
    pub use_tls: bool,
    pub is_active: bool,
    pub is_default: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateEmailAccountRequest {
    pub email: String,
    pub imap_server: String,
    pub imap_port: Option<i32>,
    pub smtp_server: String,
    pub smtp_port: Option<i32>,
    pub username: String,
    pub password_encrypted: String,
    pub use_tls: Option<bool>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct EmailAccountResponse {
    pub id: Uuid,
    pub user_id: Uuid,
    pub email: String,
    pub imap_server: String,
    pub imap_port: i32,
    pub smtp_server: String,
    pub smtp_port: i32,
    pub username: String,
    pub use_tls: bool,
    pub is_active: bool,
    pub is_default: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<EmailAccount> for EmailAccountResponse {
    fn from(account: EmailAccount) -> Self {
        EmailAccountResponse {
            id: account.id,
            user_id: account.user_id,
            email: account.email,
            imap_server: account.imap_server,
            imap_port: account.imap_port,
            smtp_server: account.smtp_server,
            smtp_port: account.smtp_port,
            username: account.username,
            use_tls: account.use_tls,
            is_active: account.is_active,
            is_default: account.is_default,
            last_sync_at: account.last_sync_at,
            created_at: account.created_at,
            updated_at: account.updated_at,
        }
    }
}