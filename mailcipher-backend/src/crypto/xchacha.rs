use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng as ChaChaOsRng},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;

use super::CryptoError;

pub const XCHACHA_NONCE_SIZE: usize = 24;
pub const XCHACHA_KEY_SIZE: usize = 32;

pub fn encrypt(plaintext: &[u8], key: &[u8; XCHACHA_KEY_SIZE], nonce: &[u8; XCHACHA_NONCE_SIZE]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let n = XNonce::from_slice(nonce);
    cipher.encrypt(n, plaintext).map_err(|e| CryptoError::from(format!("XChaCha20 encrypt failed: {e}")))
}

pub fn decrypt(ciphertext: &[u8], key: &[u8; XCHACHA_KEY_SIZE], nonce: &[u8; XCHACHA_NONCE_SIZE]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let n = XNonce::from_slice(nonce);
    cipher.decrypt(n, ciphertext).map_err(|e| CryptoError::from(format!("XChaCha20 decrypt failed: {e}")))
}

pub fn generate_nonce() -> [u8; XCHACHA_NONCE_SIZE] {
    let mut nonce = [0u8; XCHACHA_NONCE_SIZE];
    ChaChaOsRng.fill_bytes(&mut nonce);
    nonce
}

pub fn generate_key() -> [u8; XCHACHA_KEY_SIZE] {
    let mut key = [0u8; XCHACHA_KEY_SIZE];
    ChaChaOsRng.fill_bytes(&mut key);
    key
}

pub fn encrypt_random(plaintext: &[u8], key: &[u8; XCHACHA_KEY_SIZE]) -> Result<(Vec<u8>, [u8; XCHACHA_NONCE_SIZE]), CryptoError> {
    let nonce = generate_nonce();
    let ciphertext = encrypt(plaintext, key, &nonce)?;
    Ok((ciphertext, nonce))
}

pub fn key_to_base64(key: &[u8; XCHACHA_KEY_SIZE]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key)
}

pub fn key_from_base64(s: &str) -> Result<[u8; XCHACHA_KEY_SIZE], CryptoError> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s)
        .map_err(|e| CryptoError::from(format!("Invalid base64 key: {e}")))?;
    if bytes.len() != XCHACHA_KEY_SIZE {
        return Err(CryptoError::from(format!("Key length {} != {}", bytes.len(), XCHACHA_KEY_SIZE)));
    }
    let mut key = [0u8; XCHACHA_KEY_SIZE];
    key.copy_from_slice(&bytes);
    Ok(key)
}

pub fn nonce_to_base64(nonce: &[u8; XCHACHA_NONCE_SIZE]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce)
}

pub fn nonce_from_base64(s: &str) -> Result<[u8; XCHACHA_NONCE_SIZE], CryptoError> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s)
        .map_err(|e| CryptoError::from(format!("Invalid base64 nonce: {e}")))?;
    if bytes.len() != XCHACHA_NONCE_SIZE {
        return Err(CryptoError::from(format!("Nonce length {} != {}", bytes.len(), XCHACHA_NONCE_SIZE)));
    }
    let mut nonce = [0u8; XCHACHA_NONCE_SIZE];
    nonce.copy_from_slice(&bytes);
    Ok(nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = generate_key();
        let nonce = generate_nonce();
        let plaintext = b"Hello, Vault!";
        let ciphertext = encrypt(plaintext, &key, &nonce).unwrap();
        assert_ne!(ciphertext, plaintext);
        let decrypted = decrypt(&ciphertext, &key, &nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_key_rejects() {
        let key1 = generate_key();
        let key2 = generate_key();
        let nonce = generate_nonce();
        let ciphertext = encrypt(b"secret", &key1, &nonce).unwrap();
        let result = decrypt(&ciphertext, &key2, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn wrong_nonce_rejects() {
        let key = generate_key();
        let nonce1 = generate_nonce();
        let nonce2 = generate_nonce();
        let ciphertext = encrypt(b"secret", &key, &nonce1).unwrap();
        let result = decrypt(&ciphertext, &key, &nonce2);
        assert!(result.is_err());
    }

    #[test]
    fn deterministic_with_same_nonce() {
        let key = generate_key();
        let nonce = generate_nonce();
        let ct1 = encrypt(b"deterministic", &key, &nonce).unwrap();
        let ct2 = encrypt(b"deterministic", &key, &nonce).unwrap();
        assert_eq!(ct1, ct2);
    }

    #[test]
    fn nonce_is_24_bytes() {
        let nonce = generate_nonce();
        assert_eq!(nonce.len(), XCHACHA_NONCE_SIZE);
    }

    #[test]
    fn key_is_32_bytes() {
        let key = generate_key();
        assert_eq!(key.len(), XCHACHA_KEY_SIZE);
    }

    #[test]
    fn encrypt_random_works() {
        let key = generate_key();
        let (ct, nonce) = encrypt_random(b"random nonce", &key).unwrap();
        let pt = decrypt(&ct, &key, &nonce).unwrap();
        assert_eq!(pt, b"random nonce");
    }

    #[test]
    fn base64_roundtrip_key() {
        let key = generate_key();
        let encoded = key_to_base64(&key);
        let decoded = key_from_base64(&encoded).unwrap();
        assert_eq!(key, decoded);
    }

    #[test]
    fn base64_roundtrip_nonce() {
        let nonce = generate_nonce();
        let encoded = nonce_to_base64(&nonce);
        let decoded = nonce_from_base64(&encoded).unwrap();
        assert_eq!(nonce, decoded);
    }

    #[test]
    fn empty_plaintext() {
        let key = generate_key();
        let nonce = generate_nonce();
        let ct = encrypt(b"", &key, &nonce).unwrap();
        let pt = decrypt(&ct, &key, &nonce).unwrap();
        assert_eq!(pt, b"");
    }

    #[test]
    fn tampered_ciphertext_rejects() {
        let key = generate_key();
        let nonce = generate_nonce();
        let mut ct = encrypt(b"integrity", &key, &nonce).unwrap();
        ct[0] ^= 0xff;
        assert!(decrypt(&ct, &key, &nonce).is_err());
    }
}
