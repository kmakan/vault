use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;

use super::CryptoError;

const NONCE_LEN: usize = 12;
const SEPARATOR: &str = ":";

fn derive_key(jwt_secret: &str) -> Result<[u8; 32], CryptoError> {
    let hk = Hkdf::<Sha256>::new(Some(b"mailcipher-key-encryption"), jwt_secret.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"sealed-key-v1", &mut key)
        .map_err(|_| CryptoError::from("Key derivation failed"))?;
    Ok(key)
}

pub fn seal(plaintext: &str, jwt_secret: &str) -> Result<String, CryptoError> {
    let key = derive_key(jwt_secret)?;
    let cipher = ChaCha20Poly1305::new(&key.into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| CryptoError::from("Encryption failed"))?;
    let mut output = BASE64.encode(nonce_bytes);
    output.push_str(SEPARATOR);
    output.push_str(&BASE64.encode(&ciphertext));
    Ok(output)
}

pub fn unseal(sealed: &str, jwt_secret: &str) -> Result<String, CryptoError> {
    let (nonce_b64, cipher_b64) = sealed
        .split_once(SEPARATOR)
        .ok_or_else(|| CryptoError::from("Invalid sealed format"))?;
    let nonce_bytes = BASE64
        .decode(nonce_b64)
        .map_err(|_| CryptoError::from("Invalid nonce encoding"))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(CryptoError::from("Invalid nonce length"));
    }
    let ciphertext = BASE64
        .decode(cipher_b64)
        .map_err(|_| CryptoError::from("Invalid ciphertext encoding"))?;
    let key = derive_key(jwt_secret)?;
    let cipher = ChaCha20Poly1305::new(&key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| CryptoError::from("Decryption failed (wrong key or corrupted data)"))?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::from("Decrypted data is not valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_seal_unseal_roundtrip() {
        let secret = "test-jwt-secret-32bytes-long!!!";
        let plaintext = "MY_SECRET_ENCRYPTION_KEY";
        let sealed = seal(plaintext, secret).unwrap();
        let decrypted = unseal(&sealed, secret).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_seal_different_each_time() {
        let secret = "test-jwt-secret-32bytes-long!!!";
        let a = seal("DATA", secret).unwrap();
        let b = seal("DATA", secret).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn test_unseal_wrong_key_fails() {
        let a = seal("DATA", "key-one").unwrap();
        assert!(unseal(&a, "key-two").is_err());
    }

    #[test]
    fn test_unseal_tampered_ciphertext() {
        let secret = "test-jwt-secret-32bytes-long!!!";
        let sealed = seal("DATA", secret).unwrap();
        let mut chars: Vec<char> = sealed.chars().collect();
        if let Some(c) = chars.last_mut() {
            *c = if *c == 'A' { 'B' } else { 'A' };
        }
        let tampered: String = chars.into_iter().collect();
        assert!(unseal(&tampered, secret).is_err());
    }
}
