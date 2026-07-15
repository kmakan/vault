use anyhow::{Context, Result};
use sqlx::PgPool;
use uuid::Uuid;

use super::fcm::FcmClient;
use super::models::{Platform, PushNotification, PushToken, NotificationType};
use super::vapid::VapidClient;

pub struct PushService {
    pool: PgPool,
    fcm_client: Option<FcmClient>,
    vapid_client: Option<VapidClient>,
}

impl PushService {
    pub fn new(pool: PgPool) -> Result<Self> {
        let fcm_client = FcmClient::new().ok();
        let vapid_client = VapidClient::new().ok();

        Ok(Self {
            pool,
            fcm_client,
            vapid_client,
        })
    }

    pub async fn register_token(
        &self,
        user_id: Uuid,
        device_token: &str,
        platform: &Platform,
    ) -> Result<()> {
        let platform_str = platform.as_str();

        sqlx::query(
            r#"
            INSERT INTO push_tokens (user_id, device_token, platform)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, device_token, platform)
            DO UPDATE SET updated_at = NOW()
            "#,
        )
        .bind(user_id)
        .bind(device_token)
        .bind(platform_str)
        .execute(&self.pool)
        .await
        .context("Failed to register push token")?;

        tracing::info!("Registered push token for user {} on {}", user_id, platform_str);
        Ok(())
    }

    pub async fn unregister_token(&self, user_id: Uuid, device_token: &str) -> Result<()> {
        sqlx::query("DELETE FROM push_tokens WHERE user_id = $1 AND device_token = $2")
            .bind(user_id)
            .bind(device_token)
            .execute(&self.pool)
            .await
            .context("Failed to unregister push token")?;

        Ok(())
    }

    pub async fn get_tokens_by_user(&self, user_id: Uuid) -> Result<Vec<PushToken>> {
        let tokens = sqlx::query_as::<_, PushToken>(
            "SELECT * FROM push_tokens WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .context("Failed to fetch push tokens")?;

        Ok(tokens)
    }

    pub async fn send_to_user(
        &self,
        user_id: Uuid,
        notification: &PushNotification,
    ) -> Result<()> {
        let tokens = self.get_tokens_by_user(user_id).await?;

        if tokens.is_empty() {
            tracing::debug!("No push tokens for user {}", user_id);
            return Ok(());
        }

        let mut errors = Vec::new();

        for token in &tokens {
            let platform = Platform::from_str(&token.platform).unwrap_or(Platform::Android);

            let result = match platform {
                Platform::Android | Platform::Ios => {
                    if let Some(ref fcm) = self.fcm_client {
                        fcm.send_notification(&token.device_token, notification, &platform)
                            .await
                    } else {
                        tracing::warn!(
                            "FCM client not configured, skipping push to {}",
                            platform.as_str()
                        );
                        Ok(())
                    }
                }
                Platform::Web => {
                    // Web push requires separate subscription info (endpoint, p256dh, auth)
                    // which should be stored in a separate web_push_subscriptions table
                    tracing::debug!("Web push not yet implemented for this token");
                    Ok(())
                }
            };

            if let Err(e) = result {
                tracing::error!("Failed to send push to token {}: {}", token.id, e);
                errors.push(token.id);
            }
        }

        // Clean up invalid tokens
        if !errors.is_empty() {
            for token_id in &errors {
                let _ = sqlx::query("DELETE FROM push_tokens WHERE id = $1")
                    .bind(token_id)
                    .execute(&self.pool)
                    .await;
            }
        }

        Ok(())
    }

    pub async fn notify_new_message(
        &self,
        recipient_id: Uuid,
        sender_username: &str,
    ) -> Result<()> {
        let notification = PushNotification {
            title: "New Message".to_string(),
            body: format!("{} sent you a message", sender_username),
            notification_type: NotificationType::NewMessage,
            data: None,
        };

        self.send_to_user(recipient_id, &notification).await
    }

    pub async fn notify_key_exchange(
        &self,
        recipient_id: Uuid,
        sender_username: &str,
    ) -> Result<()> {
        let notification = PushNotification {
            title: "Key Exchange".to_string(),
            body: format!("{} wants to exchange keys", sender_username),
            notification_type: NotificationType::KeyExchange,
            data: None,
        };

        self.send_to_user(recipient_id, &notification).await
    }

    pub async fn notify_contact_request(
        &self,
        recipient_id: Uuid,
        sender_username: &str,
    ) -> Result<()> {
        let notification = PushNotification {
            title: "Contact Request".to_string(),
            body: format!("{} wants to add you as a contact", sender_username),
            notification_type: NotificationType::ContactRequest,
            data: None,
        };

        self.send_to_user(recipient_id, &notification).await
    }

    pub async fn notify_group_invite(
        &self,
        recipient_id: Uuid,
        sender_username: &str,
        group_name: &str,
    ) -> Result<()> {
        let notification = PushNotification {
            title: "Group Invitation".to_string(),
            body: format!("{} invited you to group {}", sender_username, group_name),
            notification_type: NotificationType::GroupInvite,
            data: None,
        };

        self.send_to_user(recipient_id, &notification).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notification_types() {
        assert_eq!(NotificationType::NewMessage.as_str(), "new_message");
        assert_eq!(NotificationType::KeyExchange.as_str(), "key_exchange");
        assert_eq!(NotificationType::ContactRequest.as_str(), "contact_request");
        assert_eq!(NotificationType::GroupInvite.as_str(), "group_invite");
    }

    #[test]
    fn test_platform_from_str() {
        assert_eq!(Platform::from_str("android"), Some(Platform::Android));
        assert_eq!(Platform::from_str("ios"), Some(Platform::Ios));
        assert_eq!(Platform::from_str("web"), Some(Platform::Web));
        assert_eq!(Platform::from_str("unknown"), None);
    }
}
