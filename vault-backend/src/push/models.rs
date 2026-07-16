use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PushToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub device_token: String,
    pub platform: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Android,
    Ios,
    Web,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::Android => "android",
            Platform::Ios => "ios",
            Platform::Web => "web",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "android" => Some(Platform::Android),
            "ios" => Some(Platform::Ios),
            "web" => Some(Platform::Web),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationType {
    NewMessage,
    KeyExchange,
    ContactRequest,
    GroupInvite,
}

impl NotificationType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NotificationType::NewMessage => "new_message",
            NotificationType::KeyExchange => "key_exchange",
            NotificationType::ContactRequest => "contact_request",
            NotificationType::GroupInvite => "group_invite",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RegisterTokenRequest {
    pub device_token: String,
    pub platform: Platform,
}

#[derive(Debug, Deserialize)]
pub struct UnregisterTokenRequest {
    pub device_token: String,
}

#[derive(Debug, Serialize)]
pub struct PushNotification {
    pub title: String,
    pub body: String,
    pub notification_type: NotificationType,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct VapidKeyResponse {
    pub public_key: String,
}

#[derive(Debug, Serialize)]
pub struct PushTokenResponse {
    pub id: Uuid,
    pub platform: String,
    pub created_at: DateTime<Utc>,
}

/// Web push subscription info for a specific device
#[derive(Debug, Clone, Deserialize)]
pub struct WebPushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}
