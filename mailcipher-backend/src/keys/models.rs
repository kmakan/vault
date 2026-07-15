use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct EncryptionKey {
    pub id: Uuid,
    pub user_id: Uuid,
    pub key_type: String,
    pub alpha_key_encrypted: Option<String>,
    pub columnar_key_encrypted: Option<String>,
    pub combined_key_encrypted: Option<String>,
    pub ed25519_secret_key_encrypted: Option<String>,
    pub ed25519_public_key: Option<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateKeyRequest {
    pub key_type: String,
    pub alpha_key: Option<String>,
    pub columnar_key: Option<String>,
    pub combined_key: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct KeyResponse {
    pub id: Uuid,
    pub user_id: Uuid,
    pub key_type: String,
    pub has_alpha_key: bool,
    pub has_columnar_key: bool,
    pub has_combined_key: bool,
    pub has_ed25519_key: bool,
    pub ed25519_public_key: Option<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<EncryptionKey> for KeyResponse {
    fn from(key: EncryptionKey) -> Self {
        KeyResponse {
            id: key.id,
            user_id: key.user_id,
            key_type: key.key_type,
            has_alpha_key: key.alpha_key_encrypted.is_some(),
            has_columnar_key: key.columnar_key_encrypted.is_some(),
            has_combined_key: key.combined_key_encrypted.is_some(),
            has_ed25519_key: key.ed25519_secret_key_encrypted.is_some(),
            ed25519_public_key: key.ed25519_public_key.clone(),
            is_active: key.is_active,
            expires_at: key.expires_at,
            created_at: key.created_at,
            updated_at: key.updated_at,
        }
    }
}