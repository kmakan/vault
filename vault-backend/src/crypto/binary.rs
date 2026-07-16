use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;

use super::CryptoError;

const NONCE_LEN: usize = 24; // XChaCha20 uses 24-byte nonce
const KEY_LEN: usize = 32;

/// Derive an encryption key from a shared secret (e.g., X25519 shared secret)
pub fn derive_file_key(shared_secret: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let hk = Hkdf::<Sha256>::new(Some(b"vault-file-encryption"), shared_secret);
    let mut key = [0u8; KEY_LEN];
    hk.expand(b"file-key-v1", &mut key)
        .map_err(|_| CryptoError::from("Key derivation failed"))?;
    Ok(key)
}

/// Encrypt raw bytes (any file content: audio, video, documents, images)
/// Returns: nonce (24 bytes) || ciphertext (with 16-byte Poly1305 tag)
pub fn encrypt_bytes(data: &[u8], key: &[u8; KEY_LEN]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, data)
        .expect("encryption should not fail for XChaCha20-Poly1305");

    let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    output
}

/// Decrypt raw bytes. Input: nonce (24 bytes) || ciphertext
pub fn decrypt_bytes(encrypted: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, CryptoError> {
    if encrypted.len() < NONCE_LEN {
        return Err(CryptoError::from("Encrypted data too short"));
    }

    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| CryptoError::from("Decryption failed (wrong key or corrupted data)"))
}

/// Encrypt file and return as Base64 string (safe for email transport)
pub fn encrypt_to_base64(data: &[u8], key: &[u8; KEY_LEN]) -> String {
    let encrypted = encrypt_bytes(data, key);
    BASE64.encode(&encrypted)
}

/// Decrypt from Base64 string back to bytes
pub fn decrypt_from_base64(encoded: &str, key: &[u8; KEY_LEN]) -> Result<Vec<u8>, CryptoError> {
    let encrypted = BASE64
        .decode(encoded)
        .map_err(|_| CryptoError::from("Invalid Base64 encoding"))?;
    decrypt_bytes(&encrypted, key)
}

/// Encrypt a file at path, return Base64 string
pub fn encrypt_file(path: &str, key: &[u8; KEY_LEN]) -> Result<String, CryptoError> {
    let data = std::fs::read(path)
        .map_err(|e| CryptoError::from(format!("Failed to read file: {}", e)))?;
    Ok(encrypt_to_base64(&data, key))
}

/// Decrypt Base64 string and write to file
pub fn decrypt_to_file(
    encoded: &str,
    output_path: &str,
    key: &[u8; KEY_LEN],
) -> Result<(), CryptoError> {
    let data = decrypt_from_base64(encoded, key)?;
    std::fs::write(output_path, &data)
        .map_err(|e| CryptoError::from(format!("Failed to write file: {}", e)))?;
    Ok(())
}

/// Get file size overhead from encryption (nonce + auth tag = 24 + 16 = 40 bytes)
pub fn encrypted_size(plaintext_len: usize) -> usize {
    NONCE_LEN + plaintext_len + 16 // nonce + data + Poly1305 tag
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_bytes_roundtrip() {
        let key: [u8; KEY_LEN] = rand::random();
        let data = b"Hello, World! This is binary data: \x00\x01\x02\xff";

        let encrypted = encrypt_bytes(data, &key);
        assert_ne!(encrypted, data);
        assert_eq!(encrypted.len(), NONCE_LEN + data.len() + 16);

        let decrypted = decrypt_bytes(&encrypted, &key).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn test_encrypt_decrypt_binary_file() {
        let key: [u8; KEY_LEN] = rand::random();

        // Simulate binary file content (e.g., JPEG header, audio data)
        let binary_data: Vec<u8> = (0..=255).cycle().take(4096).collect();

        let encrypted = encrypt_bytes(&binary_data, &key);
        let decrypted = decrypt_bytes(&encrypted, &key).unwrap();
        assert_eq!(decrypted, binary_data);
    }

    #[test]
    fn test_base64_roundtrip() {
        let key: [u8; KEY_LEN] = rand::random();
        let data = b"Binary data with special chars: \xe2\x9c\x93 \xf0\x9f\x98\x80";

        let encoded = encrypt_to_base64(data, &key);
        let decoded = decrypt_from_base64(&encoded, &key).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key1: [u8; KEY_LEN] = rand::random();
        let key2: [u8; KEY_LEN] = rand::random();
        let data = b"secret data";

        let encrypted = encrypt_bytes(data, &key1);
        assert!(decrypt_bytes(&encrypted, &key2).is_err());
    }

    #[test]
    fn test_tampered_data_fails() {
        let key: [u8; KEY_LEN] = rand::random();
        let data = b"important data";

        let mut encrypted = encrypt_bytes(data, &key);
        // Tamper with ciphertext (skip nonce, modify payload)
        if encrypted.len() > NONCE_LEN + 5 {
            encrypted[NONCE_LEN + 5] ^= 0xff;
        }
        assert!(decrypt_bytes(&encrypted, &key).is_err());
    }

    #[test]
    fn test_empty_data() {
        let key: [u8; KEY_LEN] = rand::random();
        let data = b"";

        let encrypted = encrypt_bytes(data, &key);
        let decrypted = decrypt_bytes(&encrypted, &key).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn test_large_data() {
        let key: [u8; KEY_LEN] = rand::random();
        // 1MB of data
        let data: Vec<u8> = (0..1_000_000).map(|i| (i % 256) as u8).collect();

        let encrypted = encrypt_bytes(&data, &key);
        let decrypted = decrypt_bytes(&encrypted, &key).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn test_encrypted_size_formula() {
        assert_eq!(encrypted_size(0), 40); // nonce + tag only
        assert_eq!(encrypted_size(100), 140); // 100 + 40
        assert_eq!(encrypted_size(1024), 1064);
    }
}
