use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use sqlx::PgPool;
use uuid::Uuid;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use rand::RngCore;

use super::models::SenderKey;
use crate::crypto::CryptoError;

const CHAIN_KEY_LEN: usize = 32;
const MESSAGE_KEY_LEN: usize = 32;
const DEFAULT_RATCHET_THRESHOLD: i32 = 100;

pub struct SenderKeyManager;

impl SenderKeyManager {
    /// Generate a new X25519 keypair for a user
    pub fn generate_identity_keypair() -> (StaticSecret, PublicKey) {
        let mut rng = rand::thread_rng();
        let secret = StaticSecret::random_from_rng(&mut rng);
        let public = PublicKey::from(&secret);
        (secret, public)
    }

    /// Generate a random chain key
    pub fn generate_chain_key() -> [u8; CHAIN_KEY_LEN] {
        let mut key = [0u8; CHAIN_KEY_LEN];
        rand::thread_rng().fill_bytes(&mut key);
        key
    }

    /// Derive message key from chain key using HKDF
    pub fn derive_message_key(chain_key: &[u8; CHAIN_KEY_LEN], message_number: u32) -> [u8; MESSAGE_KEY_LEN] {
        let hk = Hkdf::<Sha256>::new(Some(b"vault-sender-key"), chain_key);
        let mut key = [0u8; MESSAGE_KEY_LEN];
        let info = format!("msg-{}", message_number);
        hk.expand(info.as_bytes(), &mut key)
            .expect("HKDF expansion should not fail");
        key
    }

    /// Advance chain key: chain_key_new = HMAC(chain_key, 0x01)
    pub fn advance_chain_key(chain_key: &[u8; CHAIN_KEY_LEN]) -> [u8; CHAIN_KEY_LEN] {
        let hk = Hkdf::<Sha256>::new(Some(b"vault-chain-ratchet"), chain_key);
        let mut new_key = [0u8; CHAIN_KEY_LEN];
        hk.expand(b"chain-advance", &mut new_key)
            .expect("HKDF expansion should not fail");
        new_key
    }

    /// Encrypt sender key chain for storage (using user's master key)
    pub fn encrypt_chain_key(
        chain_key: &[u8; CHAIN_KEY_LEN],
        master_key: &[u8; 32],
    ) -> Result<String, CryptoError> {
        let cipher = XChaCha20Poly1305::new(master_key.into());
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, chain_key.as_ref())
            .map_err(|_| CryptoError::from("Failed to encrypt chain key"))?;

        let mut output = Vec::with_capacity(24 + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&output))
    }

    /// Decrypt sender key chain from storage
    pub fn decrypt_chain_key(
        encrypted: &str,
        master_key: &[u8; 32],
    ) -> Result<[u8; CHAIN_KEY_LEN], CryptoError> {
        let data = BASE64
            .decode(encrypted)
            .map_err(|_| CryptoError::from("Invalid Base64 in chain key"))?;

        if data.len() < 24 {
            return Err(CryptoError::from("Encrypted chain key too short"));
        }

        let (nonce_bytes, ciphertext) = data.split_at(24);
        let cipher = XChaCha20Poly1305::new(master_key.into());
        let nonce = XNonce::from_slice(nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| CryptoError::from("Failed to decrypt chain key"))?;

        if plaintext.len() != CHAIN_KEY_LEN {
            return Err(CryptoError::from("Invalid chain key length"));
        }

        let mut key = [0u8; CHAIN_KEY_LEN];
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    /// Encrypt chain key for distribution to a specific recipient
    pub fn encrypt_for_recipient(
        chain_key: &[u8; CHAIN_KEY_LEN],
        sender_secret: &StaticSecret,
        recipient_public: &PublicKey,
    ) -> Result<String, CryptoError> {
        let shared_secret = sender_secret.diffie_hellman(recipient_public);
        let shared_bytes = shared_secret.as_bytes();

        // Derive encryption key from shared secret
        let hk = Hkdf::<Sha256>::new(Some(b"vault-key-distribution"), shared_bytes);
        let mut enc_key = [0u8; 32];
        hk.expand(b"sender-key-xfer", &mut enc_key)
            .map_err(|_| CryptoError::from("Key derivation failed"))?;

        Self::encrypt_chain_key(chain_key, &enc_key)
    }

    /// Decrypt chain key received from sender
    pub fn decrypt_from_sender(
        encrypted_chain_key: &str,
        recipient_secret: &StaticSecret,
        sender_public: &PublicKey,
    ) -> Result<[u8; CHAIN_KEY_LEN], CryptoError> {
        let shared_secret = recipient_secret.diffie_hellman(sender_public);
        let shared_bytes = shared_secret.as_bytes();

        let hk = Hkdf::<Sha256>::new(Some(b"vault-key-distribution"), shared_bytes);
        let mut enc_key = [0u8; 32];
        hk.expand(b"sender-key-xfer", &mut enc_key)
            .map_err(|_| CryptoError::from("Key derivation failed"))?;

        Self::decrypt_chain_key(encrypted_chain_key, &enc_key)
    }

    /// Create a new sender key for a user in a group
    pub async fn create_sender_key(
        pool: &PgPool,
        group_id: Uuid,
        user_id: Uuid,
        identity_public_key: &str,
        master_key: &[u8; 32],
    ) -> Result<SenderKey, CryptoError> {
        let chain_key = Self::generate_chain_key();
        let encrypted_chain = Self::encrypt_chain_key(&chain_key, master_key)?;

        // Derive initial signing key from chain key
        let signing_key = Self::derive_message_key(&chain_key, 0);
        let signing_key_public = BASE64.encode(&signing_key);

        let key = sqlx::query_as::<_, SenderKey>(
            "INSERT INTO sender_keys (group_id, user_id, identity_public_key, chain_key_encrypted, signing_key_public, signing_key_encrypted, message_count, ratchet_threshold, key_version, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 1, TRUE)
             RETURNING *"
        )
        .bind(group_id)
        .bind(user_id)
        .bind(identity_public_key)
        .bind(&encrypted_chain)
        .bind(&signing_key_public)
        .bind(&encrypted_chain) // simplified - in production derive separate signing key
        .bind(DEFAULT_RATCHET_THRESHOLD)
        .fetch_one(pool)
        .await
        .map_err(|e| CryptoError::from(format!("Failed to create sender key: {}", e)))?;

        Ok(key)
    }

    /// Get active sender key for a user in a group
    pub async fn get_sender_key(
        pool: &PgPool,
        group_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<SenderKey>, sqlx::Error> {
        sqlx::query_as::<_, SenderKey>(
            "SELECT * FROM sender_keys WHERE group_id = $1 AND user_id = $2 AND is_active = TRUE ORDER BY key_version DESC LIMIT 1"
        )
        .bind(group_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
    }

    /// Get all active sender keys for a group (for encryption)
    pub async fn get_group_sender_keys(
        pool: &PgPool,
        group_id: Uuid,
    ) -> Result<Vec<SenderKey>, sqlx::Error> {
        sqlx::query_as::<_, SenderKey>(
            "SELECT DISTINCT ON (user_id) * FROM sender_keys WHERE group_id = $1 AND is_active = TRUE ORDER BY user_id, key_version DESC"
        )
        .bind(group_id)
        .fetch_all(pool)
        .await
    }

    /// Advance chain key after sending a message
    pub async fn advance_chain(
        pool: &PgPool,
        sender_key_id: Uuid,
    ) -> Result<(), CryptoError> {
        sqlx::query(
            "UPDATE sender_keys 
             SET message_count = message_count + 1,
                 updated_at = NOW()
             WHERE id = $1"
        )
        .bind(sender_key_id)
        .execute(pool)
        .await
        .map_err(|e| CryptoError::from(format!("Failed to advance chain: {}", e)))?;

        Ok(())
    }

    /// Perform key ratchet - generate new chain key
    pub async fn ratchet_key(
        pool: &PgPool,
        group_id: Uuid,
        user_id: Uuid,
        master_key: &[u8; 32],
    ) -> Result<SenderKey, CryptoError> {
        // Deactivate old key
        sqlx::query(
            "UPDATE sender_keys SET is_active = FALSE WHERE group_id = $1 AND user_id = $2 AND is_active = TRUE"
        )
        .bind(group_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| CryptoError::from(format!("Failed to deactivate old key: {}", e)))?;

        // Get current version
        let current_version: Option<i32> = sqlx::query_scalar(
            "SELECT MAX(key_version) FROM sender_keys WHERE group_id = $1 AND user_id = $2"
        )
        .bind(group_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| CryptoError::from(format!("Failed to get version: {}", e)))?;

        let new_version = current_version.unwrap_or(0) + 1;

        // Create new key
        let chain_key = Self::generate_chain_key();
        let encrypted_chain = Self::encrypt_chain_key(&chain_key, master_key)?;
        let signing_key = Self::derive_message_key(&chain_key, 0);
        let signing_key_public = BASE64.encode(&signing_key);

        let key = sqlx::query_as::<_, SenderKey>(
            "INSERT INTO sender_keys (group_id, user_id, identity_public_key, chain_key_encrypted, signing_key_public, signing_key_encrypted, message_count, ratchet_threshold, key_version, is_active)
             VALUES ($1, $2, (SELECT identity_public_key FROM sender_keys WHERE group_id = $1 AND user_id = $2 LIMIT 1), $3, $4, $5, 0, $7, $6, TRUE)
             RETURNING *"
        )
        .bind(group_id)
        .bind(user_id)
        .bind(new_version)
        .bind(&encrypted_chain)
        .bind(&signing_key_public)
        .bind(&encrypted_chain)
        .bind(DEFAULT_RATCHET_THRESHOLD)
        .fetch_one(pool)
        .await
        .map_err(|e| CryptoError::from(format!("Failed to create ratcheted key: {}", e)))?;

        Ok(key)
    }

    /// Encrypt a group message using sender's key
    pub fn encrypt_message(
        plaintext: &str,
        chain_key: &[u8; CHAIN_KEY_LEN],
        message_count: u32,
    ) -> Result<String, CryptoError> {
        let message_key = Self::derive_message_key(chain_key, message_count);

        let cipher = XChaCha20Poly1305::new(&message_key.into());
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|_| CryptoError::from("Failed to encrypt message"))?;

        // Format: version(1) || message_count(4) || nonce(24) || ciphertext
        let mut output = Vec::with_capacity(1 + 4 + 24 + ciphertext.len());
        output.push(1u8); // version
        output.extend_from_slice(&message_count.to_be_bytes());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&output))
    }

    /// Decrypt a group message using sender's key
    pub fn decrypt_message(
        encrypted: &str,
        chain_key: &[u8; CHAIN_KEY_LEN],
    ) -> Result<String, CryptoError> {
        let data = BASE64
            .decode(encrypted)
            .map_err(|_| CryptoError::from("Invalid Base64 in message"))?;

        if data.len() < 29 {
            return Err(CryptoError::from("Encrypted message too short"));
        }

        let version = data[0];
        if version != 1 {
            return Err(CryptoError::from("Unsupported message version"));
        }

        let message_count = u32::from_be_bytes([data[1], data[2], data[3], data[4]]);
        let (nonce_bytes, ciphertext) = data[5..].split_at(24);

        let message_key = Self::derive_message_key(chain_key, message_count);
        let cipher = XChaCha20Poly1305::new(&message_key.into());
        let nonce = XNonce::from_slice(nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| CryptoError::from("Decryption failed (wrong key or corrupted data)"))?;

        String::from_utf8(plaintext)
            .map_err(|_| CryptoError::from("Invalid UTF-8 in decrypted message"))
    }
}
