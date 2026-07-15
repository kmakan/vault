use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::Rng;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::secure_store::{SecureStore, SecureStoreError};

const MASTER_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const VERIFY_PLAINTEXT: &[u8] = b"whisper-master-key-verify-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    Biometric,
    Password,
}

#[derive(Debug, Clone)]
pub enum BiometricError {
    BiometricUnavailable,
    BiometricFailed(String),
    BiometricCancelled,
    PasswordRequired,
    WrongPassword,
    KeychainError(String),
    CryptoError(String),
    NotConfigured,
    SetupRequired,
}

impl std::fmt::Display for BiometricError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BiometricError::BiometricUnavailable => write!(f, "Biometric authentication not available on this device"),
            BiometricError::BiometricFailed(msg) => write!(f, "Biometric authentication failed: {}", msg),
            BiometricError::BiometricCancelled => write!(f, "Biometric authentication cancelled by user"),
            BiometricError::PasswordRequired => write!(f, "Password authentication required"),
            BiometricError::WrongPassword => write!(f, "Wrong password"),
            BiometricError::KeychainError(msg) => write!(f, "Keychain error: {}", msg),
            BiometricError::CryptoError(msg) => write!(f, "Cryptographic error: {}", msg),
            BiometricError::NotConfigured => write!(f, "Biometric authentication not configured"),
            BiometricError::SetupRequired => write!(f, "Initial setup required — set password first"),
        }
    }
}

impl std::error::Error for BiometricError {}

impl From<SecureStoreError> for BiometricError {
    fn from(e: SecureStoreError) -> Self {
        BiometricError::KeychainError(e.to_string())
    }
}

pub trait BiometricProvider: Send + Sync {
    fn is_available(&self) -> bool;
    fn authenticate(&self, reason: &str) -> Result<(), BiometricError>;
    fn is_enrolled(&self) -> bool;
}

pub struct BiometricConfig {
    pub biometric_enabled: bool,
    pub service_name: String,
    pub biometric_reason: String,
}

impl Default for BiometricConfig {
    fn default() -> Self {
        Self {
            biometric_enabled: false,
            service_name: "whisper-mailcipher".to_string(),
            biometric_reason: "Unlock Whisper encryption keys".to_string(),
        }
    }
}

pub struct MasterKeyManager {
    config: BiometricConfig,
    store: SecureStore,
    biometric: Option<Box<dyn BiometricProvider>>,
    session_key: Option<[u8; MASTER_KEY_LEN]>,
}

impl MasterKeyManager {
    pub fn new(config: BiometricConfig) -> Result<Self, BiometricError> {
        let store = SecureStore::open()?;
        Ok(Self {
            config,
            store,
            biometric: None,
            session_key: None,
        })
    }

    pub fn with_biometric(
        config: BiometricConfig,
        biometric: Box<dyn BiometricProvider>,
    ) -> Result<Self, BiometricError> {
        let store = SecureStore::open()?;
        Ok(Self {
            config,
            store,
            biometric: Some(biometric),
            session_key: None,
        })
    }

    pub fn is_configured(&self) -> bool {
        self.store.has_master_key()
    }

    pub fn has_session_key(&self) -> bool {
        self.session_key.is_some()
    }

    pub fn session_key(&self) -> Option<&[u8; MASTER_KEY_LEN]> {
        self.session_key.as_ref()
    }

    fn derive_key_from_password(password: &str, salt: &[u8]) -> [u8; MASTER_KEY_LEN] {
        use argon2::{
            password_hash::{PasswordHasher, SaltString},
            Argon2, Algorithm, Params, Version,
        };
        let params = Params::new(65536, 3, 4, Some(MASTER_KEY_LEN))
            .expect("valid argon2 params");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; MASTER_KEY_LEN];
        argon2
            .hash_password_into(password.as_bytes(), salt, &mut key)
            .expect("argon2 derivation failed");
        key
    }

    fn encrypt_master_key(master_key: &[u8; MASTER_KEY_LEN], password_key: &[u8; MASTER_KEY_LEN]) -> (Vec<u8>, Vec<u8>) {
        let cipher = XChaCha20Poly1305::new(password_key.into());
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let encrypted = cipher.encrypt(nonce, master_key.as_ref())
            .expect("encryption failed");

        let mut output = Vec::with_capacity(24 + encrypted.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&encrypted);
        (output, nonce_bytes.to_vec())
    }

    fn decrypt_master_key(encrypted: &[u8], password_key: &[u8; MASTER_KEY_LEN]) -> Result<[u8; MASTER_KEY_LEN], BiometricError> {
        if encrypted.len() < 24 {
            return Err(BiometricError::CryptoError("Encrypted data too short".into()));
        }
        let (nonce_bytes, ciphertext) = encrypted.split_at(24);
        let cipher = XChaCha20Poly1305::new(password_key.into());
        let nonce = XNonce::from_slice(nonce_bytes);

        let plaintext = cipher.decrypt(nonce, ciphertext)
            .map_err(|e| BiometricError::CryptoError(format!("Decryption failed: {}", e)))?;

        if plaintext.len() != MASTER_KEY_LEN {
            return Err(BiometricError::CryptoError("Invalid master key length".into()));
        }

        let mut key = [0u8; MASTER_KEY_LEN];
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    fn compute_verify_hash(master_key: &[u8; MASTER_KEY_LEN], password_key: &[u8; MASTER_KEY_LEN]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(VERIFY_PLAINTEXT);
        hasher.update(master_key);
        hasher.update(password_key);
        hasher.finalize().to_vec()
    }

    pub fn setup_with_password(
        &mut self,
        password: &str,
        enable_biometric: bool,
    ) -> Result<AuthMethod, BiometricError> {
        if self.store.has_master_key() {
            return Err(BiometricError::CryptoError("Master key already exists. Use unlock instead.".into()));
        }

        let mut master_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut master_key);

        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill(&mut salt);

        let password_key = Self::derive_key_from_password(password, &salt);
        let (encrypted_key, _) = Self::encrypt_master_key(&master_key, &password_key);
        let verify_hash = Self::compute_verify_hash(&master_key, &password_key);

        self.store.store_master_key(&encrypted_key, &salt, &verify_hash)?;

        let use_biometric = enable_biometric
            && self.biometric.as_ref().map_or(false, |b| b.is_available() && b.is_enrolled());

        if use_biometric {
            if let Some(ref bio) = self.biometric {
                bio.authenticate(&self.config.biometric_reason)?;
            }
            self.store_biometric_key(&master_key, password)?;
        }

        master_key.zeroize();
        self.session_key = Some(Self::derive_key_from_password(password, &salt));

        Ok(if use_biometric { AuthMethod::Biometric } else { AuthMethod::Password })
    }

    pub fn unlock_with_password(&mut self, password: &str) -> Result<AuthMethod, BiometricError> {
        if !self.store.has_master_key() {
            return Err(BiometricError::SetupRequired);
        }

        let (encrypted_key, salt, stored_verify) = self.store.retrieve_master_key()?;
        let password_key = Self::derive_key_from_password(password, &salt);

        let master_key = Self::decrypt_master_key(&encrypted_key, &password_key)?;
        let computed_verify = Self::compute_verify_hash(&master_key, &password_key);

        if computed_verify != stored_verify {
            master_key.zeroize();
            return Err(BiometricError::WrongPassword);
        }

        self.session_key = Some(master_key);
        Ok(AuthMethod::Password)
    }

    pub fn unlock(&mut self) -> Result<AuthMethod, BiometricError> {
        if !self.store.has_master_key() {
            return Err(BiometricError::SetupRequired);
        }

        if let Some(ref bio) = self.biometric {
            if self.config.biometric_enabled && bio.is_available() && bio.is_enrolled() {
                match bio.authenticate(&self.config.biometric_reason) {
                    Ok(()) => {
                        if let Ok(master_key) = self.retrieve_biometric_key() {
                            self.session_key = Some(master_key);
                            return Ok(AuthMethod::Biometric);
                        }
                    }
                    Err(BiometricError::BiometricCancelled) => {
                        return Err(BiometricError::BiometricCancelled);
                    }
                    Err(_) => {}
                }
            }
        }

        Err(BiometricError::PasswordRequired)
    }

    pub fn lock(&mut self) {
        if let Some(ref mut key) = self.session_key {
            key.zeroize();
        }
        self.session_key = None;
    }

    pub fn change_password(
        &mut self,
        old_password: &str,
        new_password: &str,
    ) -> Result<(), BiometricError> {
        let (encrypted_key, salt, stored_verify) = self.store.retrieve_master_key()?;
        let old_key = Self::derive_key_from_password(old_password, &salt);

        let master_key = Self::decrypt_master_key(&encrypted_key, &old_key)?;
        let computed_verify = Self::compute_verify_hash(&master_key, &old_key);

        if computed_verify != stored_verify {
            master_key.zeroize();
            return Err(BiometricError::WrongPassword);
        }

        let mut new_salt = [0u8; SALT_LEN];
        rand::thread_rng().fill(&mut new_salt);

        let new_password_key = Self::derive_key_from_password(new_password, &new_salt);
        let (new_encrypted, _) = Self::encrypt_master_key(&master_key, &new_password_key);
        let new_verify = Self::compute_verify_hash(&master_key, &new_password_key);

        self.store.update_master_key(&new_encrypted, &new_salt, &new_verify)?;

        if self.config.biometric_enabled {
            if let Some(ref bio) = self.biometric {
                if bio.is_available() && bio.is_enrolled() {
                    let _ = bio.authenticate(&self.config.biometric_reason);
                    self.store_biometric_key(&master_key, new_password)?;
                }
            }
        }

        self.session_key = Some(master_key);
        Ok(())
    }

    pub fn enable_biometric(&mut self, password: &str) -> Result<(), BiometricError> {
        let bio = self.biometric.as_ref()
            .ok_or(BiometricError::BiometricUnavailable)?;

        if !bio.is_available() || !bio.is_enrolled() {
            return Err(BiometricError::BiometricUnavailable);
        }

        bio.authenticate(&self.config.biometric_reason)?;

        let (encrypted_key, salt, stored_verify) = self.store.retrieve_master_key()?;
        let password_key = Self::derive_key_from_password(password, &salt);
        let master_key = Self::decrypt_master_key(&encrypted_key, &password_key)?;
        let computed_verify = Self::compute_verify_hash(&master_key, &password_key);

        if computed_verify != stored_verify {
            master_key.zeroize();
            return Err(BiometricError::WrongPassword);
        }

        self.store_biometric_key(&master_key, password)?;
        self.config.biometric_enabled = true;
        self.session_key = Some(master_key);
        Ok(())
    }

    pub fn disable_biometric(&mut self) -> Result<(), BiometricError> {
        let bio_store = SecureStore::open_with_target("biometric")?;
        let _ = bio_store.delete_master_key();
        self.config.biometric_enabled = false;
        Ok(())
    }

    fn store_biometric_key(&self, master_key: &[u8; MASTER_KEY_LEN], password: &str) -> Result<(), BiometricError> {
        let bio_store = SecureStore::open_with_target("biometric")?;

        let bio_key = {
            let mut hasher = Sha256::new();
            hasher.update(b"whisper-biometric-key-v1");
            hasher.update(password.as_bytes());
            let result = hasher.finalize();
            let mut key = [0u8; MASTER_KEY_LEN];
            key.copy_from_slice(&result);
            key
        };

        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill(&mut nonce_bytes);
        let cipher = XChaCha20Poly1305::new((&bio_key).into());
        let nonce = XNonce::from_slice(&nonce_bytes);
        let encrypted = cipher.encrypt(nonce, master_key.as_ref())
            .map_err(|e| BiometricError::CryptoError(e.to_string()))?;

        let mut output = Vec::with_capacity(24 + encrypted.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&encrypted);

        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill(&mut salt);
        let verify = Sha256::digest(master_key).to_vec();

        bio_store.store_master_key(&output, &salt, &verify)?;
        Ok(())
    }

    fn retrieve_biometric_key(&self) -> Result<[u8; MASTER_KEY_LEN], BiometricError> {
        let bio_store = SecureStore::open_with_target("biometric")?;
        let (encrypted, _, _) = bio_store.retrieve_master_key()?;

        if encrypted.len() < 24 {
            return Err(BiometricError::CryptoError("Invalid biometric key data".into()));
        }

        let (nonce_bytes, ciphertext) = encrypted.split_at(24);

        let password_key = self.session_key.unwrap_or([0u8; MASTER_KEY_LEN]);
        let cipher = XChaCha20Poly1305::new((&password_key).into());
        let nonce = XNonce::from_slice(nonce_bytes);

        let plaintext = cipher.decrypt(nonce, ciphertext)
            .map_err(|e| BiometricError::CryptoError(format!("Biometric key decryption failed: {}", e)))?;

        if plaintext.len() != MASTER_KEY_LEN {
            return Err(BiometricError::CryptoError("Invalid biometric key length".into()));
        }

        let mut key = [0u8; MASTER_KEY_LEN];
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    pub fn delete_all(&mut self) -> Result<(), BiometricError> {
        self.lock();
        self.store.delete_master_key()?;
        let bio_store = SecureStore::open_with_target("biometric")?;
        let _ = bio_store.delete_master_key();
        self.config.biometric_enabled = false;
        Ok(())
    }
}

pub struct NoopBiometricProvider;

impl BiometricProvider for NoopBiometricProvider {
    fn is_available(&self) -> bool {
        false
    }

    fn authenticate(&self, _reason: &str) -> Result<(), BiometricError> {
        Err(BiometricError::BiometricUnavailable)
    }

    fn is_enrolled(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_MUTEX: Mutex<()> = Mutex::new(());

    fn test_manager() -> MasterKeyManager {
        let config = BiometricConfig::default();
        MasterKeyManager::with_biometric(config, Box::new(NoopBiometricProvider))
            .expect("Failed to create manager")
    }

    #[test]
    fn test_master_key_encrypt_decrypt_roundtrip() {
        let mut master_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut master_key);

        let mut password_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut password_key);

        let (encrypted, _) = MasterKeyManager::encrypt_master_key(&master_key, &password_key);
        let decrypted = MasterKeyManager::decrypt_master_key(&encrypted, &password_key).unwrap();

        assert_eq!(decrypted, master_key);
    }

    #[test]
    fn test_master_key_wrong_password_fails() {
        let mut master_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut master_key);

        let mut key1 = [0u8; MASTER_KEY_LEN];
        let mut key2 = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut key1);
        rand::thread_rng().fill(&mut key2);

        let (encrypted, _) = MasterKeyManager::encrypt_master_key(&master_key, &key1);
        let result = MasterKeyManager::decrypt_master_key(&encrypted, &key2);

        assert!(result.is_err());
    }

    #[test]
    fn test_derive_key_deterministic() {
        let salt = [42u8; SALT_LEN];
        let key1 = MasterKeyManager::derive_key_from_password("password", &salt);
        let key2 = MasterKeyManager::derive_key_from_password("password", &salt);
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_derive_key_different_passwords() {
        let salt = [42u8; SALT_LEN];
        let key1 = MasterKeyManager::derive_key_from_password("password1", &salt);
        let key2 = MasterKeyManager::derive_key_from_password("password2", &salt);
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_verify_hash_deterministic() {
        let mut key = [0u8; MASTER_KEY_LEN];
        let mut pw_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut key);
        rand::thread_rng().fill(&mut pw_key);

        let h1 = MasterKeyManager::compute_verify_hash(&key, &pw_key);
        let h2 = MasterKeyManager::compute_verify_hash(&key, &pw_key);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_verify_hash_different_keys() {
        let mut key1 = [0u8; MASTER_KEY_LEN];
        let mut key2 = [0u8; MASTER_KEY_LEN];
        let mut pw_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut key1);
        rand::thread_rng().fill(&mut key2);
        rand::thread_rng().fill(&mut pw_key);

        let h1 = MasterKeyManager::compute_verify_hash(&key1, &pw_key);
        let h2 = MasterKeyManager::compute_verify_hash(&key2, &pw_key);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_setup_and_unlock_with_password() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let mut manager = test_manager();
        let _ = manager.delete_all();

        let method = manager.setup_with_password("strong-password-123!", false).unwrap();
        assert_eq!(method, AuthMethod::Password);
        assert!(manager.has_session_key());

        manager.lock();
        assert!(!manager.has_session_key());

        let method = manager.unlock_with_password("strong-password-123!").unwrap();
        assert_eq!(method, AuthMethod::Password);
        assert!(manager.has_session_key());

        let _ = manager.delete_all();
    }

    #[test]
    fn test_wrong_password_fails_unlock() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let mut manager = test_manager();
        let _ = manager.delete_all();

        manager.setup_with_password("correct-password", false).unwrap();
        manager.lock();

        let result = manager.unlock_with_password("wrong-password");
        assert!(result.is_err());

        let _ = manager.delete_all();
    }

    #[test]
    fn test_change_password() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let mut manager = test_manager();
        let _ = manager.delete_all();

        manager.setup_with_password("old-password", false).unwrap();
        manager.change_password("old-password", "new-password").unwrap();
        manager.lock();

        let result = manager.unlock_with_password("old-password");
        assert!(result.is_err());

        let method = manager.unlock_with_password("new-password").unwrap();
        assert_eq!(method, AuthMethod::Password);

        let _ = manager.delete_all();
    }

    #[test]
    fn test_noop_biometric_unavailable() {
        let bio = NoopBiometricProvider;
        assert!(!bio.is_available());
        assert!(!bio.is_enrolled());
        assert!(bio.authenticate("test").is_err());
    }

    #[test]
    fn test_biometric_provider_trait_object() {
        let bio: Box<dyn BiometricProvider> = Box::new(NoopBiometricProvider);
        assert!(!bio.is_available());
    }

    #[test]
    fn test_master_key_zeroize_on_wrong_password() {
        let mut master_key = [42u8; MASTER_KEY_LEN];
        let mut password_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut password_key);

        let (encrypted, _) = MasterKeyManager::encrypt_master_key(&master_key, &password_key);

        let mut wrong_key = [0u8; MASTER_KEY_LEN];
        rand::thread_rng().fill(&mut wrong_key);

        let result = MasterKeyManager::decrypt_master_key(&encrypted, &wrong_key);
        assert!(result.is_err());

        master_key.zeroize();
        assert!(master_key.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_delete_all_cleans_up() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let mut manager = test_manager();
        let _ = manager.delete_all();

        manager.setup_with_password("test-password", false).unwrap();
        assert!(manager.is_configured());

        manager.delete_all().unwrap();
        assert!(!manager.is_configured());

        let _ = manager.delete_all();
    }
}
