use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};


/// Vault ID format: vault:email>
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultId {
    pub email: String,
}

impl VaultId {
    pub fn new(email: &str) -> Self {
        Self {
            email: email.to_lowercase(),
        }
    }

    pub fn to_string(&self) -> String {
        format!("vault:{}", self.email)
    }

    pub fn from_string(s: &str) -> Option<Self> {
        s.strip_prefix("vault:").map(|email| Self::new(email))
    }

    pub fn is_valid(&self) -> bool {
        self.email.contains('@') && self.email.contains('.')
    }
}

/// Invite status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InviteStatus {
    /// Invite created, waiting for acceptance
    Pending,
    /// Invite accepted, waiting for confirmation
    Accepted,
    /// Invite confirmed, contact added
    Confirmed,
    /// Invite expired
    Expired,
    /// Invite revoked
    Revoked,
}

impl std::fmt::Display for InviteStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InviteStatus::Pending => write!(f, "pending"),
            InviteStatus::Accepted => write!(f, "accepted"),
            InviteStatus::Confirmed => write!(f, "confirmed"),
            InviteStatus::Expired => write!(f, "expired"),
            InviteStatus::Revoked => write!(f, "revoked"),
        }
    }
}

/// A Vault invite
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    /// Unique invite ID
    pub id: String,
    /// Sender email
    pub sender: String,
    /// Recipient email
    pub recipient: String,
    /// Sender's public key (hex)
    pub sender_public_key: String,
    /// Status
    pub status: InviteStatus,
    /// Created at (unix timestamp)
    pub created_at: u64,
    /// Expires at (unix timestamp)
    pub expires_at: u64,
    /// One-time use flag
    pub one_time: bool,
    /// Used flag
    pub used: bool,
    /// Signature for verification
    pub signature: String,
}

impl Invite {
    /// Create a new invite
    pub fn new(
        sender: &str,
        recipient: &str,
        sender_public_key: &str,
        duration_hours: u64,
    ) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let id = generate_invite_id();

        Self {
            id,
            sender: sender.to_lowercase(),
            recipient: recipient.to_lowercase(),
            sender_public_key: sender_public_key.to_string(),
            status: InviteStatus::Pending,
            created_at: now,
            expires_at: now + (duration_hours * 3600),
            one_time: true,
            used: false,
            signature: String::new(), // TODO: sign with private key
        }
    }

    /// Check if invite is valid
    pub fn is_valid(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        self.status == InviteStatus::Pending && !self.used && now < self.expires_at
    }

    /// Get time until expiration (in seconds)
    pub fn time_until_expiry(&self) -> Option<u64> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        if now < self.expires_at {
            Some(self.expires_at - now)
        } else {
            None
        }
    }

    /// Generate invite link
    pub fn to_link(&self) -> String {
        format!("https://vault.chat/invite/{}", base64url_encode(&self.id))
    }

    /// Parse invite from link
    pub fn from_link(link: &str) -> Option<String> {
        link.strip_prefix("https://vault.chat/invite/")
            .map(|id| base64url_decode(id))
            .flatten()
    }

    /// Mark as used
    pub fn mark_used(&mut self) -> Result<()> {
        if self.used {
            anyhow::bail!("Invite already used");
        }
        if !self.is_valid() {
            anyhow::bail!("Invite is not valid");
        }
        self.used = true;
        self.status = InviteStatus::Accepted;
        Ok(())
    }

    /// Confirm invite
    pub fn confirm(&mut self) -> Result<()> {
        if self.status != InviteStatus::Accepted {
            anyhow::bail!("Invite not in accepted state");
        }
        self.status = InviteStatus::Confirmed;
        Ok(())
    }
}

/// Invite manager
pub struct InviteManager {
    /// Invites by ID
    invites: HashMap<String, Invite>,
    /// Path to storage file
    storage_path: Option<String>,
}

impl InviteManager {
    /// Create a new invite manager
    pub fn new() -> Self {
        Self {
            invites: HashMap::new(),
            storage_path: None,
        }
    }

    /// Load from file
    pub fn load(path: &Path) -> Result<Self> {
        let data = std::fs::read_to_string(path).context("Failed to read invite file")?;
        let invites: HashMap<String, Invite> =
            serde_json::from_str(&data).context("Failed to parse invite file")?;

        Ok(Self {
            invites,
            storage_path: Some(path.to_string_lossy().to_string()),
        })
    }

    /// Save to file
    pub fn save(&self) -> Result<()> {
        if let Some(ref path) = self.storage_path {
            let data = serde_json::to_string_pretty(&self.invites)
                .context("Failed to serialize invites")?;
            std::fs::write(path, data).context("Failed to write invite file")?;
        }
        Ok(())
    }

    /// Create an invite
    pub fn create_invite(
        &mut self,
        sender: &str,
        recipient: &str,
        sender_public_key: &str,
        duration_hours: u64,
    ) -> Result<Invite> {
        let invite = Invite::new(sender, recipient, sender_public_key, duration_hours);

        self.invites.insert(invite.id.clone(), invite.clone());
        self.save()?;

        Ok(invite)
    }

    /// Get invite by ID
    pub fn get_invite(&self, id: &str) -> Option<&Invite> {
        self.invites.get(id)
    }

    /// Get invite by link
    pub fn get_invite_by_link(&self, link: &str) -> Option<&Invite> {
        Invite::from_link(link).and_then(|id| self.invites.get(&id))
    }

    /// Accept an invite (recipient side)
    pub fn accept_invite(&mut self, invite_id: &str, recipient_public_key: &str) -> Result<Invite> {
        let invite = self
            .invites
            .get_mut(invite_id)
            .context("Invite not found")?;

        if !invite.is_valid() {
            anyhow::bail!("Invite is not valid or expired");
        }

        invite.mark_used()?;
        let invite = invite.clone();
        self.save()?;

        Ok(invite)
    }

    /// Confirm an invite (sender side)
    pub fn confirm_invite(&mut self, invite_id: &str) -> Result<Invite> {
        let invite = self
            .invites
            .get_mut(invite_id)
            .context("Invite not found")?;

        invite.confirm()?;
        let invite = invite.clone();
        self.save()?;

        Ok(invite)
    }

    /// Revoke an invite
    pub fn revoke_invite(&mut self, invite_id: &str) -> Result<()> {
        let invite = self
            .invites
            .get_mut(invite_id)
            .context("Invite not found")?;

        invite.status = InviteStatus::Revoked;
        self.save()?;

        Ok(())
    }

    /// Clean up expired invites
    pub fn cleanup_expired(&mut self) {
        self.invites
            .retain(|_, invite| invite.time_until_expiry().is_some());
    }

    /// Get all pending invites
    pub fn pending_invites(&self) -> Vec<&Invite> {
        self.invites
            .values()
            .filter(|i| i.status == InviteStatus::Pending && i.is_valid())
            .collect()
    }

    /// Get all invites for a recipient
    pub fn invites_for(&self, email: &str) -> Vec<&Invite> {
        let email = email.to_lowercase();
        self.invites
            .values()
            .filter(|i| i.recipient == email)
            .collect()
    }
}

/// Generate unique invite ID
fn generate_invite_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    format!("inv_{:016x}", now as u64)
}

/// Base64 URL-safe encoding
fn base64url_encode(data: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    URL_SAFE_NO_PAD.encode(data.as_bytes())
}

/// Base64 URL-safe decoding
fn base64url_decode(data: &str) -> Option<String> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    URL_SAFE_NO_PAD
        .decode(data.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// QR code generation for invite
pub fn generate_invite_qr(invite: &Invite) -> Result<String> {
    let link = invite.to_link();

    // Generate QR code using qrcodegen or similar
    // For now, return the link
    Ok(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_id() {
        let id = VaultId::new("alice@example.com");
        assert_eq!(id.to_string(), "vault:alice@example.com");
        assert!(id.is_valid());

        let parsed = VaultId::from_string("vault:bob@test.com");
        assert!(parsed.is_some());
        assert_eq!(parsed.unwrap().email, "bob@test.com");
    }

    #[test]
    fn test_invite_creation() {
        let invite = Invite::new("alice@example.com", "bob@example.com", "04a1b2c3d4", 24);

        assert!(invite.is_valid());
        assert_eq!(invite.status, InviteStatus::Pending);
        assert!(!invite.used);
        assert!(invite.one_time);
    }

    #[test]
    fn test_invite_link() {
        let invite = Invite::new("alice@example.com", "bob@example.com", "04a1b2c3d4", 24);

        let link = invite.to_link();
        assert!(link.starts_with("https://vault.chat/invite/"));

        let parsed_id = Invite::from_link(&link);
        assert!(parsed_id.is_some());
        assert_eq!(parsed_id.unwrap(), invite.id);
    }

    #[test]
    fn test_invite_manager() {
        let mut manager = InviteManager::new();

        let invite = manager
            .create_invite("alice@example.com", "bob@example.com", "04a1b2c3d4", 24)
            .unwrap();

        assert!(invite.is_valid());

        let retrieved = manager.get_invite(&invite.id);
        assert!(retrieved.is_some());
    }

    #[test]
    fn test_invite_accept() {
        let mut manager = InviteManager::new();

        let invite = manager
            .create_invite("alice@example.com", "bob@example.com", "04a1b2c3d4", 24)
            .unwrap();

        let accepted = manager.accept_invite(&invite.id, "04e5f6g7h8");
        assert!(accepted.is_ok());
    }

    #[test]
    fn test_invite_confirm() {
        let mut manager = InviteManager::new();

        let invite = manager
            .create_invite("alice@example.com", "bob@example.com", "04a1b2c3d4", 24)
            .unwrap();

        manager.accept_invite(&invite.id, "04e5f6g7h8").unwrap();
        let confirmed = manager.confirm_invite(&invite.id);
        assert!(confirmed.is_ok());
    }

    #[test]
    fn test_invite_revoke() {
        let mut manager = InviteManager::new();

        let invite = manager
            .create_invite("alice@example.com", "bob@example.com", "04a1b2c3d4", 24)
            .unwrap();

        manager.revoke_invite(&invite.id).unwrap();
        let retrieved = manager.get_invite(&invite.id).unwrap();
        assert_eq!(retrieved.status, InviteStatus::Revoked);
    }
}
