use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use x25519_dalek::{PublicKey, StaticSecret};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use base64::Engine as _;

const NONCE_LEN: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPair {
    pub public_key: String,
    pub private_key: String,
}

fn derive_key(public_key: &PublicKey) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"vault-self-encryption-v1");
    hasher.update(public_key.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

pub fn generate_keypair() -> KeyPair {
    let private = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&private);
    
    KeyPair {
        public_key: hex::encode(public.as_bytes()),
        private_key: hex::encode(private.to_bytes()),
    }
}

pub fn encrypt(
    plaintext: &str,
    private_key: &str,
    peer_public_key: Option<&str>,
) -> anyhow::Result<String> {
    let priv_bytes = hex::decode(private_key)?;
    let priv_arr: [u8; 32] = priv_bytes.try_into().map_err(|_| anyhow::anyhow!("Invalid private key"))?;
    let private = StaticSecret::from(priv_arr);
    let public = PublicKey::from(&private);
    
    let key = match peer_public_key {
        Some(peer_hex) => {
            let peer_bytes = hex::decode(peer_hex)?;
            let peer_arr: [u8; 32] = peer_bytes.try_into().map_err(|_| anyhow::anyhow!("Invalid peer key"))?;
            let peer = PublicKey::from(peer_arr);
            let shared = private.diffie_hellman(&peer);
            *shared.as_bytes()
        }
        None => derive_key(&public),
    };
    
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = XNonce::from_slice(&nonce_bytes);
    
    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("Encryption failed: {:?}", e))?;
    
    let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    
    Ok(base64::engine::general_purpose::STANDARD.encode(&output))
}

pub fn decrypt(
    ciphertext: &str,
    private_key: &str,
    peer_public_key: Option<&str>,
) -> anyhow::Result<String> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(ciphertext)?;
    
    if decoded.len() < NONCE_LEN {
        anyhow::bail!("Ciphertext too short");
    }
    
    let priv_bytes = hex::decode(private_key)?;
    let priv_arr: [u8; 32] = priv_bytes.try_into().map_err(|_| anyhow::anyhow!("Invalid private key"))?;
    let private = StaticSecret::from(priv_arr);
    let public = PublicKey::from(&private);
    
    let key = match peer_public_key {
        Some(peer_hex) => {
            let peer_bytes = hex::decode(peer_hex)?;
            let peer_arr: [u8; 32] = peer_bytes.try_into().map_err(|_| anyhow::anyhow!("Invalid peer key"))?;
            let peer = PublicKey::from(peer_arr);
            let shared = private.diffie_hellman(&peer);
            *shared.as_bytes()
        }
        None => derive_key(&public),
    };
    
    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce = XNonce::from_slice(nonce_bytes);
    
    let plaintext = cipher.decrypt(nonce, ciphertext_bytes)
        .map_err(|e| anyhow::anyhow!("Decryption failed: {:?}", e))?;
    
    Ok(String::from_utf8(plaintext)?)
}

pub fn fingerprint(public_key_hex: &str) -> anyhow::Result<String> {
    let bytes = hex::decode(public_key_hex)?;
    if bytes.len() != 32 {
        anyhow::bail!("Public key must be 32 bytes");
    }
    let fp: String = bytes[..8]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(":");
    Ok(format!("{}:****", fp))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_keygen_and_encrypt_decrypt() {
        let kp = generate_keypair();
        let plaintext = "Hello, Vault!";
        let encrypted = encrypt(plaintext, &kp.private_key, None).unwrap();
        assert_ne!(encrypted, plaintext);
        let decrypted = decrypt(&encrypted, &kp.private_key, None).unwrap();
        assert_eq!(decrypted, plaintext);
    }
    
    #[test]
    fn test_shared_secret_encryption() {
        let alice = generate_keypair();
        let bob = generate_keypair();
        let encrypted = encrypt("secret", &alice.private_key, Some(&bob.public_key)).unwrap();
        let decrypted = decrypt(&encrypted, &bob.private_key, Some(&alice.public_key)).unwrap();
        assert_eq!(decrypted, "secret");
    }
    
    #[test]
    fn test_fingerprint() {
        let kp = generate_keypair();
        let fp = fingerprint(&kp.public_key).unwrap();
        assert!(fp.contains(':'));
        assert!(fp.contains("****"));
    }
}
