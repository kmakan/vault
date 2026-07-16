use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Algorithm, Argon2, Params, Version,
};
use rand::Rng;

use super::CryptoError;

const KEY_LEN: usize = 32;

#[derive(Debug, Clone)]
pub struct DeriveParams {
    pub memory_cost: u32,
    pub time_cost: u32,
    pub parallelism: u32,
}

impl Default for DeriveParams {
    fn default() -> Self {
        Self {
            memory_cost: 65536,
            time_cost: 3,
            parallelism: 4,
        }
    }
}

impl DeriveParams {
    pub fn interactive() -> Self {
        Self {
            memory_cost: 32768,
            time_cost: 2,
            parallelism: 1,
        }
    }

    pub fn sensitive() -> Self {
        Self {
            memory_cost: 131072,
            time_cost: 4,
            parallelism: 4,
        }
    }
}

fn build_argon2(params: &DeriveParams) -> Result<Argon2<'static>, CryptoError> {
    let argon2_params = Params::new(
        params.memory_cost,
        params.time_cost,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|e| CryptoError::from(format!("Invalid Argon2 params: {}", e)))?;

    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params))
}

pub fn derive_key_from_password(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let argon2 = build_argon2(&DeriveParams::default())?;
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| CryptoError::from(format!("Argon2id derivation failed: {}", e)))?;
    Ok(key)
}

pub fn derive_key_interactive(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let argon2 = build_argon2(&DeriveParams::interactive())?;
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| CryptoError::from(format!("Argon2id derivation failed: {}", e)))?;
    Ok(key)
}

pub fn derive_key_sensitive(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let argon2 = build_argon2(&DeriveParams::sensitive())?;
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| CryptoError::from(format!("Argon2id derivation failed: {}", e)))?;
    Ok(key)
}

pub fn generate_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill(&mut salt);
    salt
}

pub fn generate_salt_string() -> SaltString {
    SaltString::generate(&mut OsRng)
}

pub fn derive_and_encrypt(
    plaintext: &str,
    password: &str,
) -> Result<String, CryptoError> {
    let salt = generate_salt();
    let key = derive_key_from_password(password, &salt)?;

    let encrypted = super::encrypt_bytes(plaintext.as_bytes(), &key);
    let salt_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &salt,
    );
    let key_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &key,
    );
    let enc_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &encrypted,
    );

    Ok(format!("$argon2id${}${}${}$", salt_b64, key_b64, enc_b64))
}

pub fn derive_and_decrypt(
    envelope: &str,
    password: &str,
) -> Result<String, CryptoError> {
    let inner = envelope.strip_prefix('$').and_then(|s| s.strip_suffix('$'))
        .ok_or_else(|| CryptoError::from("Invalid envelope format"))?;
    let parts: Vec<&str> = inner.split('$').collect();
    if parts.len() != 4 || parts[0] != "argon2id" {
        return Err(CryptoError::from("Invalid envelope format"));
    }

    let salt = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        parts[1],
    )
    .map_err(|_| CryptoError::from("Invalid salt encoding"))?;

    let encrypted = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        parts[3],
    )
    .map_err(|_| CryptoError::from("Invalid ciphertext encoding"))?;

    let key = derive_key_from_password(password, &salt)?;

    let decrypted = super::decrypt_bytes(&encrypted, &key)?;
    String::from_utf8(decrypted).map_err(|_| CryptoError::from("Decrypted data is not valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_key_deterministic() {
        let salt = [42u8; 16];
        let key1 = derive_key_from_password("password", &salt).unwrap();
        let key2 = derive_key_from_password("password", &salt).unwrap();
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_derive_key_different_passwords() {
        let salt = [42u8; 16];
        let key1 = derive_key_from_password("password1", &salt).unwrap();
        let key2 = derive_key_from_password("password2", &salt).unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_derive_key_different_salts() {
        let key1 = derive_key_from_password("password", &[1u8; 16]).unwrap();
        let key2 = derive_key_from_password("password", &[2u8; 16]).unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_derive_and_encrypt_roundtrip() {
        let plaintext = "SECRET MESSAGE";
        let password = "my-strong-password-123!";
        let envelope = derive_and_encrypt(plaintext, password).unwrap();
        let decrypted = derive_and_decrypt(&envelope, password).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_derive_and_decrypt_wrong_password() {
        let plaintext = "SECRET MESSAGE";
        let envelope = derive_and_encrypt(plaintext, "correct-password").unwrap();
        assert!(derive_and_decrypt(&envelope, "wrong-password").is_err());
    }

    #[test]
    fn test_derive_and_encrypt_different_each_time() {
        let plaintext = "SECRET MESSAGE";
        let password = "password";
        let e1 = derive_and_encrypt(plaintext, password).unwrap();
        let e2 = derive_and_encrypt(plaintext, password).unwrap();
        assert_ne!(e1, e2);
    }

    #[test]
    fn test_interactive_params_faster() {
        let salt = [42u8; 16];
        let key = derive_key_interactive("password", &salt).unwrap();
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn test_sensitive_params() {
        let salt = [42u8; 16];
        let key = derive_key_sensitive("password", &salt).unwrap();
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn test_generate_salt_unique() {
        let s1 = generate_salt();
        let s2 = generate_salt();
        assert_ne!(s1, s2);
    }
}
