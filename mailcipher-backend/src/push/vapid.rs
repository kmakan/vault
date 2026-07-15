use anyhow::{Context, Result};
use std::io::Cursor;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder,
    WebPushClient, WebPushMessageBuilder,
};

use super::models::PushNotification;

pub struct VapidClient {
    client: IsahcWebPushClient,
    public_key: String,
    private_key_pem: String,
}

impl VapidClient {
    pub fn new() -> Result<Self> {
        let public_key_b64 =
            std::env::var("VAPID_PUBLIC_KEY").context("VAPID_PUBLIC_KEY must be set")?;
        let private_key_pem = std::env::var("VAPID_PRIVATE_KEY_PEM")
            .context("VAPID_PRIVATE_KEY_PEM must be set (PEM format)")?;

        Ok(Self {
            client: IsahcWebPushClient::new()
                .context("Failed to create WebPushClient")?,
            public_key: public_key_b64,
            private_key_pem,
        })
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    pub async fn send_notification(
        &self,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        notification: &PushNotification,
    ) -> Result<()> {
        let subscription = SubscriptionInfo::new(endpoint, p256dh, auth);

        let mut builder = WebPushMessageBuilder::new(&subscription);

        let payload = serde_json::json!({
            "title": notification.title,
            "body": notification.body,
            "type": notification.notification_type.as_str(),
            "data": notification.data,
        });

        let payload_bytes = serde_json::to_vec(&payload)?;
        builder.set_payload(ContentEncoding::Aes128Gcm, &payload_bytes);

        let pem_cursor = Cursor::new(self.private_key_pem.as_bytes());
        let mut sig_builder = VapidSignatureBuilder::from_pem(pem_cursor, &subscription)
            .context("Failed to create VAPID signature builder")?;
        sig_builder.add_claim("sub", "mailto:push@vault.chat");
        let signature = sig_builder
            .build()
            .context("Failed to build VAPID signature")?;
        builder.set_vapid_signature(signature);

        let message = builder
            .build()
            .context("Failed to build WebPush message")?;

        self.client
            .send(message)
            .await
            .context("Failed to send WebPush notification")?;

        Ok(())
    }
}

/// Generate VAPID keypair using openssl CLI.
/// Returns (public_key_base64_urlsafe, private_key_pem).
pub fn generate_vapid_pem_keypair() -> Result<(String, String)> {
    use std::process::Command;

    let priv_output = Command::new("openssl")
        .args(["ecparam", "-name", "prime256v1", "-genkey", "-noout"])
        .output()
        .context("Failed to generate EC key")?;

    if !priv_output.status.success() {
        return Err(anyhow::anyhow!(
            "openssl genkey failed: {}",
            String::from_utf8_lossy(&priv_output.stderr)
        ));
    }

    let private_pem = String::from_utf8(priv_output.stdout)?;

    // Derive uncompressed public key point (65 bytes)
    let pub_output = Command::new("openssl")
        .args(["ec", "-pubout", "-outform", "DER"])
        .output()
        .context("Failed to derive public key")?;

    if !pub_output.status.success() {
        return Err(anyhow::anyhow!(
            "openssl pubout failed: {}",
            String::from_utf8_lossy(&pub_output.stderr)
        ));
    }

    let der = pub_output.stdout;
    if der.len() < 65 {
        return Err(anyhow::anyhow!("Public key DER too short: {}", der.len()));
    }
    let point = &der[der.len() - 65..];
    use base64::Engine;
    let public_key_b64 =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point);

    Ok((public_key_b64, private_pem))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_subscription_info_creation() {
        let sub = SubscriptionInfo::new(
            "https://example.com/push",
            "test-p256dh-key",
            "test-auth-secret",
        );
        assert_eq!(sub.endpoint, "https://example.com/push");
        assert_eq!(sub.keys.p256dh, "test-p256dh-key");
        assert_eq!(sub.keys.auth, "test-auth-secret");
    }

    #[test]
    fn test_vapid_client_requires_env() {
        std::env::remove_var("VAPID_PUBLIC_KEY");
        std::env::remove_var("VAPID_PRIVATE_KEY_PEM");
        let result = VapidClient::new();
        assert!(result.is_err());
    }
}
