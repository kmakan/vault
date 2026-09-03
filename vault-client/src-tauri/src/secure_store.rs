use keyring::Entry;
use zeroize::Zeroize;

const SERVICE_NAME: &str = "vault-vault";
const MASTER_KEY_ACCOUNT: &str = "master-key";
const SALT_ACCOUNT: &str = "master-key-salt";
const VERIFY_ACCOUNT: &str = "master-key-verify";

#[derive(Debug)]
pub enum SecureStoreError {
    Keyring(String),
    NotFound,
    Encoding,
    Corruption(String),
}

impl std::fmt::Display for SecureStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecureStoreError::Keyring(msg) => write!(f, "Keyring error: {}", msg),
            SecureStoreError::NotFound => write!(f, "Master key not found in keychain"),
            SecureStoreError::Encoding => write!(f, "Failed to encode/decode key data"),
            SecureStoreError::Corruption(msg) => write!(f, "Keychain data corrupted: {}", msg),
        }
    }
}

impl std::error::Error for SecureStoreError {}

impl From<keyring::Error> for SecureStoreError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => SecureStoreError::NotFound,
            other => SecureStoreError::Keyring(other.to_string()),
        }
    }
}

pub struct SecureStore {
    key_entry: Entry,
    salt_entry: Entry,
    verify_entry: Entry,
}

impl SecureStore {
    pub fn open() -> Result<Self, SecureStoreError> {
        let key_entry = Entry::new(SERVICE_NAME, MASTER_KEY_ACCOUNT)?;
        let salt_entry = Entry::new(SERVICE_NAME, SALT_ACCOUNT)?;
        let verify_entry = Entry::new(SERVICE_NAME, VERIFY_ACCOUNT)?;
        Ok(Self {
            key_entry,
            salt_entry,
            verify_entry,
        })
    }

    pub fn open_with_target(target: &str) -> Result<Self, SecureStoreError> {
        let key_entry = Entry::new_with_target(
            &format!("{}-{}", target, MASTER_KEY_ACCOUNT),
            SERVICE_NAME,
            MASTER_KEY_ACCOUNT,
        )?;
        let salt_entry = Entry::new_with_target(
            &format!("{}-{}", target, SALT_ACCOUNT),
            SERVICE_NAME,
            SALT_ACCOUNT,
        )?;
        let verify_entry = Entry::new_with_target(
            &format!("{}-{}", target, VERIFY_ACCOUNT),
            SERVICE_NAME,
            VERIFY_ACCOUNT,
        )?;
        Ok(Self {
            key_entry,
            salt_entry,
            verify_entry,
        })
    }

    pub fn has_master_key(&self) -> bool {
        self.key_entry.get_password().is_ok()
    }

    pub fn store_master_key(&self, encrypted_key: &[u8], salt: &[u8], verify_hash: &[u8]) -> Result<(), SecureStoreError> {
        self.key_entry
            .set_password(&base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                encrypted_key,
            ))
            .map_err(|e| SecureStoreError::Keyring(e.to_string()))?;

        self.salt_entry
            .set_password(&base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                salt,
            ))
            .map_err(|e| {
                let _ = self.key_entry.delete_credential();
                SecureStoreError::Keyring(e.to_string())
            })?;

        self.verify_entry
            .set_password(&base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                verify_hash,
            ))
            .map_err(|e| {
                let _ = self.key_entry.delete_credential();
                let _ = self.salt_entry.delete_credential();
                SecureStoreError::Keyring(e.to_string())
            })?;

        Ok(())
    }

    pub fn retrieve_master_key(&self) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), SecureStoreError> {
        let key_b64 = self.key_entry.get_password()?;
        let salt_b64 = self.salt_entry.get_password()?;
        let verify_b64 = self.verify_entry.get_password()?;

        let encrypted_key = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &key_b64,
        )
        .map_err(|_| SecureStoreError::Encoding)?;

        let salt = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &salt_b64,
        )
        .map_err(|_| SecureStoreError::Encoding)?;

        let verify_hash = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &verify_b64,
        )
        .map_err(|_| SecureStoreError::Encoding)?;

        Ok((encrypted_key, salt, verify_hash))
    }

    pub fn delete_master_key(&self) -> Result<(), SecureStoreError> {
        let _ = self.key_entry.delete_credential();
        let _ = self.salt_entry.delete_credential();
        let _ = self.verify_entry.delete_credential();
        Ok(())
    }

    pub fn update_master_key(
        &self,
        encrypted_key: &[u8],
        salt: &[u8],
        verify_hash: &[u8],
    ) -> Result<(), SecureStoreError> {
        self.delete_master_key()?;
        self.store_master_key(encrypted_key, salt, verify_hash)
    }
}

impl Drop for SecureStore {
    fn drop(&mut self) {
        self.key_entry.delete_credential().ok();
        self.salt_entry.delete_credential().ok();
        self.verify_entry.delete_credential().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_MUTEX: Mutex<()> = Mutex::new(());

    fn test_store() -> SecureStore {
        SecureStore::open_with_target("test").expect("Failed to open test store")
    }

    #[test]
    fn test_store_and_retrieve_master_key() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let store = test_store();
        let _ = store.delete_master_key();

        let encrypted_key = vec![1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        let salt = vec![10u8; 16];
        let verify = vec![20u8; 32];

        store.store_master_key(&encrypted_key, &salt, &verify).unwrap();
        assert!(store.has_master_key());

        let (retrieved_key, retrieved_salt, retrieved_verify) = store.retrieve_master_key().unwrap();
        assert_eq!(retrieved_key, encrypted_key);
        assert_eq!(retrieved_salt, salt);
        assert_eq!(retrieved_verify, verify);

        let _ = store.delete_master_key();
    }

    #[test]
    fn test_has_master_key_returns_false_when_empty() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let store = test_store();
        let _ = store.delete_master_key();
        assert!(!store.has_master_key());
    }

    #[test]
    fn test_delete_master_key() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let store = test_store();

        store.store_master_key(&[1u8; 16], &[2u8; 16], &[3u8; 32]).unwrap();
        assert!(store.has_master_key());

        store.delete_master_key().unwrap();
        assert!(!store.has_master_key());
    }

    #[test]
    fn test_update_master_key() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let store = test_store();
        let _ = store.delete_master_key();

        store.store_master_key(&[1u8; 16], &[2u8; 16], &[3u8; 32]).unwrap();

        let new_key = vec![99u8; 32];
        let new_salt = vec![88u8; 16];
        let new_verify = vec![77u8; 32];
        store.update_master_key(&new_key, &new_salt, &new_verify).unwrap();

        let (key, salt, verify) = store.retrieve_master_key().unwrap();
        assert_eq!(key, new_key);
        assert_eq!(salt, new_salt);
        assert_eq!(verify, new_verify);

        let _ = store.delete_master_key();
    }

    #[test]
    fn test_empty_key_rejected() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let store = test_store();
        let _ = store.delete_master_key();

        let result = store.retrieve_master_key();
        assert!(result.is_err());
    }

    #[test]
    fn test_store_isolation_between_targets() {
        let _lock = TEST_MUTEX.lock().unwrap();
        let store_a = SecureStore::open_with_target("test-a").unwrap();
        let store_b = SecureStore::open_with_target("test-b").unwrap();
        let _ = store_a.delete_master_key();
        let _ = store_b.delete_master_key();

        store_a.store_master_key(&[1u8; 16], &[2u8; 16], &[3u8; 32]).unwrap();
        assert!(store_a.has_master_key());
        assert!(!store_b.has_master_key());

        store_b.store_master_key(&[10u8; 16], &[20u8; 16], &[30u8; 32]).unwrap();
        let (key_a, _, _) = store_a.retrieve_master_key().unwrap();
        let (key_b, _, _) = store_b.retrieve_master_key().unwrap();
        assert_eq!(key_a, vec![1u8; 16]);
        assert_eq!(key_b, vec![10u8; 16]);

        let _ = store_a.delete_master_key();
        let _ = store_b.delete_master_key();
    }
}
