pub mod encryptor;

pub use encryptor::{DecryptedContent, Encryptor};

/// Decryptor is an alias for Encryptor (it has both encrypt and decrypt methods)
pub type Decryptor = Encryptor;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::rngs::OsRng;
use x25519_dalek::{PublicKey, SharedSecret, StaticSecret};

const NONCE_LEN: usize = 24;

pub struct CryptoClient {
    private_key: Option<StaticSecret>,
    public_key: Option<PublicKey>,
    shared_secret: Option<SharedSecret>,
}

impl CryptoClient {
    pub fn new() -> Self {
        Self {
            private_key: None,
            public_key: None,
            shared_secret: None,
        }
    }

    /// Generate a new X25519 key pair
    pub fn generate_keypair(&mut self) -> (String, String) {
        let private = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&private);

        let pub_hex = hex::encode(public.as_bytes());
        let priv_hex = hex::encode(private.to_bytes());

        self.private_key = Some(private);
        self.public_key = Some(public);

        (pub_hex, priv_hex)
    }

    /// Import a private key from hex
    pub fn import_private_key(&mut self, priv_hex: &str) -> Result<()> {
        let bytes = hex::decode(priv_hex).context("Invalid private key hex")?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
        let private = StaticSecret::from(arr);
        let public = PublicKey::from(&private);

        self.private_key = Some(private);
        self.public_key = Some(public);
        Ok(())
    }

    /// Set a remote peer's public key to derive shared secret
    pub fn set_peer_key(&mut self, peer_pub_hex: &str) -> Result<()> {
        let priv_key = self
            .private_key
            .as_ref()
            .context("Generate keys first with /keygen")?;

        let peer_bytes = hex::decode(peer_pub_hex).context("Invalid public key hex")?;
        let peer_pub = PublicKey::from(
            <[u8; 32]>::try_from(peer_bytes.as_slice())
                .map_err(|_| anyhow::anyhow!("Public key must be 32 bytes"))?,
        );

        let shared = priv_key.diffie_hellman(&peer_pub);
        self.shared_secret = Some(shared);
        Ok(())
    }

    /// Check if keys are loaded
    pub fn has_keys(&self) -> bool {
        self.private_key.is_some()
    }

    /// Get key fingerprint (first 8 bytes of public key)
    pub fn fingerprint(&self) -> String {
        match &self.public_key {
            Some(pub_key) => {
                let bytes = pub_key.as_bytes();
                let fp: String = bytes[..8]
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(":");
                format!("{}:****", fp)
            }
            None => "no key".to_string(),
        }
    }

    /// Get the public key as hex
    pub fn public_key_hex(&self) -> Option<String> {
        self.public_key
            .as_ref()
            .map(|pk| hex::encode(pk.as_bytes()))
    }

    /// Get the encryption key
    fn get_key(&self) -> Result<[u8; 32]> {
        if let Some(ref shared) = self.shared_secret {
            let mut key = [0u8; 32];
            key.copy_from_slice(shared.as_bytes());
            return Ok(key);
        }

        if let Some(ref pub_key) = self.public_key {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(b"vault-self-encryption-v1");
            hasher.update(pub_key.as_bytes());
            let result = hasher.finalize();
            let mut key = [0u8; 32];
            key.copy_from_slice(&result);
            return Ok(key);
        }

        anyhow::bail!("No keys available. Use /keygen first.")
    }

    /// Encrypt plaintext string → Base64
    pub fn encrypt(&self, plaintext: &str) -> String {
        self.do_encrypt(plaintext.as_bytes())
            .unwrap_or_else(|_| BASE64.encode(plaintext.as_bytes()))
    }

    /// Decrypt Base64 ciphertext → plaintext string.
    /// Whitespace (line breaks from email transport) is ignored — transport
    /// relays may wrap the base64 line, e.g. `\r\n` inside the payload.
    pub fn decrypt(&self, ciphertext: &str) -> Result<String> {
        let compact: String = ciphertext.chars().filter(|c| !c.is_whitespace()).collect();
        let decoded = BASE64.decode(compact).context("Invalid Base64")?;
        let plaintext = self.do_decrypt(&decoded)?;
        String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted text")
    }

    /// Encrypt a vault message using AAD marker "VAULT" (no plaintext prefix).
    ///
    /// The marker is passed as Associated Data to XChaCha20-Poly1305 — it is
    /// authenticated by Poly1305 but NOT present in the ciphertext.  On the
    /// wire the format is identical to `encrypt()`: base64(nonce ‖ ciphertext).
    pub fn encrypt_vault(&self, plaintext: &str) -> Result<String> {
        let key = self.get_key()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);

        let payload = Payload {
            msg: plaintext.as_bytes(),
            aad: b"VAULT",
        };
        let ciphertext = cipher
            .encrypt(nonce, payload)
            .map_err(|e| anyhow::anyhow!("Vault encryption failed: {}", e))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&output))
    }

    /// Decrypt a vault message authenticated with AAD marker "VAULT".
    ///
    /// Returns `Ok(plaintext)` only when Poly1305 authentication with
    /// AAD="VAULT" succeeds.  If the message was NOT encrypted with the vault
    /// AAD (or the key is wrong), returns `Err` — the caller should treat it
    /// as non-vault mail (or try the legacy fallback).
    pub fn decrypt_vault(&self, ciphertext: &str) -> Result<String> {
        let compact: String = ciphertext.chars().filter(|c| !c.is_whitespace()).collect();
        let decoded = BASE64.decode(compact).context("Invalid Base64")?;

        let key = self.get_key()?;

        if decoded.len() < NONCE_LEN {
            anyhow::bail!("Encrypted data too short");
        }

        let (nonce_bytes, ct_bytes) = decoded.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce = XNonce::from_slice(nonce_bytes);

        let payload = Payload {
            msg: ct_bytes,
            aad: b"VAULT",
        };
        let plaintext = cipher
            .decrypt(nonce, payload)
            .map_err(|_| anyhow::anyhow!("Not a vault message (AAD auth failed) or wrong key"))?;

        String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted vault text")
    }

    /// Check if text looks like encrypted data
    pub fn is_encrypted(&self, text: &str) -> bool {
        let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if let Ok(decoded) = BASE64.decode(compact) {
            decoded.len() >= NONCE_LEN + 17 && self.has_keys()
        } else {
            false
        }
    }

    /// Encrypt binary data → Vec<u8> (raw bytes, not Base64)
    pub fn encrypt_binary(&self, data: &[u8]) -> Vec<u8> {
        self.do_encrypt_bytes(data)
            .unwrap_or_else(|_| data.to_vec())
    }

    /// Decrypt binary data → Vec<u8>
    pub fn decrypt_binary(&self, data: &[u8]) -> Result<Vec<u8>> {
        self.do_decrypt(data)
    }

    fn do_encrypt_bytes(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let key = self.get_key()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn do_encrypt(&self, plaintext: &[u8]) -> Result<String> {
        let key = self.get_key()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&output))
    }

    fn do_decrypt(&self, encrypted: &[u8]) -> Result<Vec<u8>> {
        let key = self.get_key()?;

        if encrypted.len() < NONCE_LEN {
            anyhow::bail!("Encrypted data too short");
        }

        let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce = XNonce::from_slice(nonce_bytes);

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| anyhow::anyhow!("Decryption failed (wrong key or corrupted data)"))
    }
}

impl Default for CryptoClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        let text = "Hello, Vault! Привет, мир!";
        let encrypted = crypto.encrypt(text);
        assert_ne!(encrypted, text);

        let decrypted = crypto.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, text);
    }

    #[test]
    fn test_binary_encrypt_decrypt() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        let data: Vec<u8> = (0..=255).cycle().take(1024).collect();
        let encrypted = crypto.encrypt_binary(&data);
        assert_ne!(encrypted, data);

        let decrypted = crypto.decrypt_binary(&encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn test_key_fingerprint() {
        let mut crypto = CryptoClient::new();
        assert_eq!(crypto.fingerprint(), "no key");

        crypto.generate_keypair();
        let fp = crypto.fingerprint();
        assert!(fp.contains(':'));
        assert!(fp.contains("****"));
    }

    #[test]
    fn test_is_encrypted() {
        let mut crypto = CryptoClient::new();
        assert!(!crypto.is_encrypted("hello"));

        crypto.generate_keypair();
        let encrypted = crypto.encrypt("hello");
        assert!(crypto.is_encrypted(&encrypted));
    }

    #[test]
    fn test_import_export_key() {
        let mut crypto1 = CryptoClient::new();
        let (_, priv_hex) = crypto1.generate_keypair();

        let mut crypto2 = CryptoClient::new();
        crypto2.import_private_key(&priv_hex).unwrap();
        assert!(crypto2.has_keys());
        assert_eq!(crypto1.fingerprint(), crypto2.fingerprint());
    }

    #[test]
    fn test_vault_aad_encrypt_decrypt_roundtrip() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        let text = "Hello, Vault! Привет, мир!";
        let encrypted = crypto.encrypt_vault(text).unwrap();
        assert_ne!(encrypted, text);

        // decrypt_vault with the same key should succeed and return clean text
        let decrypted = crypto.decrypt_vault(&encrypted).unwrap();
        assert_eq!(decrypted, text);
        // No VAULT1: prefix — the text is pure
        assert!(!decrypted.starts_with("VAULT1:"));
    }

    #[test]
    fn test_vault_aad_rejects_non_vault_data() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        // Data encrypted WITHOUT AAD (old encrypt, no vault marker)
        let non_vault = crypto.encrypt("hello");
        // decrypt_vault must reject it
        let result = crypto.decrypt_vault(&non_vault);
        assert!(result.is_err(), "non-vault ciphertext must fail AAD auth");

        // Data encrypted with AAD=Vault... but decrypted with WRONG key
        let vault_enc = crypto.encrypt_vault("secret").unwrap();

        let mut other = CryptoClient::new();
        other.generate_keypair();
        let result = other.decrypt_vault(&vault_enc);
        assert!(result.is_err(), "wrong key must fail AAD auth");
    }
}
