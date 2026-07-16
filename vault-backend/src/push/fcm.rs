use anyhow::{Context, Result};
use reqwest::Client;
use serde::Serialize;

use super::models::{Platform, PushNotification};

const FCM_HTTP_V1_URL: &str = "https://fcm.googleapis.com/v1";

#[derive(Debug, Serialize)]
struct FcmMessage {
    message: FcmMessagePayload,
}

#[derive(Debug, Serialize)]
struct FcmMessagePayload {
    token: String,
    notification: Option<FcmNotification>,
    android: Option<FcmAndroidConfig>,
    apns: Option<FcmApnsConfig>,
    data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct FcmNotification {
    title: String,
    body: String,
}

#[derive(Debug, Serialize)]
struct FcmAndroidConfig {
    priority: String,
    #[serde(rename = "notification")]
    notification_config: FcmAndroidNotification,
}

#[derive(Debug, Serialize)]
struct FcmAndroidNotification {
    title: String,
    body: String,
    tag: String,
}

#[derive(Debug, Serialize)]
struct FcmApnsConfig {
    payload: FcmApnsPayload,
}

#[derive(Debug, Serialize)]
struct FcmApnsPayload {
    #[serde(rename = "aps")]
    aps: FcmAps,
}

#[derive(Debug, Serialize)]
struct FcmAps {
    alert: FcmApsAlert,
    sound: String,
    badge: Option<u32>,
    #[serde(rename = "mutable-content")]
    mutable_content: Option<u32>,
}

#[derive(Debug, Serialize)]
struct FcmApsAlert {
    title: String,
    body: String,
}

pub struct FcmClient {
    client: Client,
    project_id: String,
    service_account_json: Option<String>,
}

impl FcmClient {
    pub fn new() -> Result<Self> {
        let project_id = std::env::var("FCM_PROJECT_ID")
            .context("FCM_PROJECT_ID must be set")?;
        
        let service_account_json = std::env::var("FCM_SERVICE_ACCOUNT_JSON").ok();
        
        Ok(Self {
            client: Client::new(),
            project_id,
            service_account_json,
        })
    }

    pub async fn send_notification(
        &self,
        device_token: &str,
        notification: &PushNotification,
        platform: &Platform,
    ) -> Result<()> {
        let message = self.build_message(device_token, notification, platform)?;
        let url = format!("{}/projects/{}/messages:send", FCM_HTTP_V1_URL, self.project_id);
        
        let access_token = self.get_access_token().await?;
        
        let response = self.client
            .post(&url)
            .bearer_auth(&access_token)
            .json(&message)
            .send()
            .await
            .context("Failed to send FCM request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("FCM request failed with status {}: {}", status, body);
        }

        Ok(())
    }

    fn build_message(
        &self,
        device_token: &str,
        notification: &PushNotification,
        platform: &Platform,
    ) -> Result<FcmMessage> {
        let tag = notification.notification_type.as_str().to_string();
        
        let notification_payload = FcmNotification {
            title: notification.title.clone(),
            body: notification.body.clone(),
        };

        let message = match platform {
            Platform::Android => FcmMessagePayload {
                token: device_token.to_string(),
                notification: Some(notification_payload),
                android: Some(FcmAndroidConfig {
                    priority: "high".to_string(),
                    notification_config: FcmAndroidNotification {
                        title: notification.title.clone(),
                        body: notification.body.clone(),
                        tag,
                    },
                }),
                apns: None,
                data: notification.data.clone(),
            },
            Platform::Ios => FcmMessagePayload {
                token: device_token.to_string(),
                notification: Some(notification_payload),
                android: None,
                apns: Some(FcmApnsConfig {
                    payload: FcmApnsPayload {
                        aps: FcmAps {
                            alert: FcmApsAlert {
                                title: notification.title.clone(),
                                body: notification.body.clone(),
                            },
                            sound: "default".to_string(),
                            badge: Some(1),
                            mutable_content: Some(1),
                        },
                    },
                }),
                data: notification.data.clone(),
            },
            Platform::Web => {
                anyhow::bail!("Use VAPID for web push notifications");
            }
        };

        Ok(FcmMessage { message })
    }

    async fn get_access_token(&self) -> Result<String> {
        if let Some(ref service_account_json) = self.service_account_json {
            self.get_access_token_from_service_account(service_account_json).await
        } else {
            // Fallback to ADC (Application Default Credentials)
            self.get_access_token_from_adc().await
        }
    }

    async fn get_access_token_from_service_account(&self, service_account_json: &str) -> Result<String> {
        use jsonwebtoken::{encode, Header, EncodingKey};
        use serde::Deserialize;
        use std::time::{SystemTime, UNIX_EPOCH};

        #[derive(Debug, Deserialize)]
        struct ServiceAccount {
            client_email: String,
            private_key: String,
        }

        let sa: ServiceAccount = serde_json::from_str(service_account_json)
            .context("Invalid service account JSON")?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs() as usize;

        let claims = serde_json::json!({
            "iss": sa.client_email,
            "scope": "https://www.googleapis.com/auth/firebase.messaging",
            "aud": "https://oauth2.googleapis.com/token",
            "iat": now,
            "exp": now + 3600,
        });

        let header = Header::new(jsonwebtoken::Algorithm::RS256);
        let token = encode(&header, &claims, &EncodingKey::from_rsa_pem(sa.private_key.as_bytes())?)
            .context("Failed to encode JWT")?;

        let client = Client::new();
        let response = client
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &token),
            ])
            .send()
            .await
            .context("Failed to get access token")?;

        let token_response: serde_json::Value = response.json().await
            .context("Invalid token response")?;

        token_response["access_token"]
            .as_str()
            .map(|s| s.to_string())
            .context("No access token in response")
    }

    async fn get_access_token_from_adc(&self) -> Result<String> {
        let output = tokio::process::Command::new("gcloud")
            .args(["auth", "print-access-token"])
            .output()
            .await
            .context("Failed to get ADC token")?;

        if output.status.success() {
            Ok(String::from_utf8(output.stdout)?.trim().to_string())
        } else {
            anyhow::bail!("Failed to get ADC token: {}", String::from_utf8_lossy(&output.stderr))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::models::NotificationType;

    #[test]
    fn test_build_android_message() {
        let client = FcmClient {
            client: Client::new(),
            project_id: "test-project".to_string(),
            service_account_json: None,
        };

        let notification = PushNotification {
            title: "New Message".to_string(),
            body: "You have a new message from Alice".to_string(),
            notification_type: NotificationType::NewMessage,
            data: None,
        };

        let msg = client.build_message("test_token", &notification, &Platform::Android).unwrap();
        assert_eq!(msg.message.token, "test_token");
        assert!(msg.message.android.is_some());
        assert!(msg.message.apns.is_none());
    }

    #[test]
    fn test_build_ios_message() {
        let client = FcmClient {
            client: Client::new(),
            project_id: "test-project".to_string(),
            service_account_json: None,
        };

        let notification = PushNotification {
            title: "Key Exchange".to_string(),
            body: "New key exchange request".to_string(),
            notification_type: NotificationType::KeyExchange,
            data: None,
        };

        let msg = client.build_message("test_token", &notification, &Platform::Ios).unwrap();
        assert_eq!(msg.message.token, "test_token");
        assert!(msg.message.android.is_none());
        assert!(msg.message.apns.is_some());
    }

    #[test]
    fn test_build_web_message_fails() {
        let client = FcmClient {
            client: Client::new(),
            project_id: "test-project".to_string(),
            service_account_json: None,
        };

        let notification = PushNotification {
            title: "Test".to_string(),
            body: "Test".to_string(),
            notification_type: NotificationType::NewMessage,
            data: None,
        };

        let result = client.build_message("test_token", &notification, &Platform::Web);
        assert!(result.is_err());
    }
}
