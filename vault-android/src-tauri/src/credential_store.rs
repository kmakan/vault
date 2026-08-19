// Credential store — keeps the mailbox login (email + app password + server
// settings) on disk so the user does NOT have to re-enter the password on
// every app restart.
//
// Security model (device-bound encryption, same approach as mainstream
// desktop mail clients):
//   * A random 32-byte device key is generated once and stored at
//     ~/.vault/credentials/device.key with 0600 permissions.
//   * The credentials JSON is encrypted with XChaCha20-Poly1305 under that
//     device key and written to ~/.vault/credentials/credentials.enc (0600).
//   * The plaintext password never touches the disk and never leaves the
//     device. Anyone who copies only `credentials.enc` to another machine
//     cannot decrypt it.
//
// Tests can redirect the directory via VAULT_CREDENTIALS_DIR (mirrors the
// VAULT_KEYS_DIR convention in key_store).

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const NONCE_LEN: usize = 24;
const DIR_NAME: &str = "credentials";
const DEVICE_KEY_FILE: &str = "device.key";
const CRED_FILE: &str = "credentials.enc";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredentials {
    pub email: String,
    pub password: String,
    pub imap_server: String,
    pub imap_port: u16,
    pub smtp_server: String,
    pub smtp_port: u16,
    pub saved_at: String,
}

fn get_dir() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("VAULT_CREDENTIALS_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault").join(DIR_NAME))
}

fn ensure_dir() -> anyhow::Result<PathBuf> {
    let dir = get_dir()?;
    fs::create_dir_all(&dir)?;
    set_dir_owner_only(&dir);
    Ok(dir)
}

#[cfg(unix)]
fn set_dir_owner_only(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    // Каталог: 0700 (нужен x для прохода внутрь). Файлы ниже — 0600.
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn set_dir_owner_only(_path: &std::path::Path) {}

#[cfg(unix)]
fn set_owner_only(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_owner_only(_path: &std::path::Path) {}

/// Load (or create once) the 32-byte device key, hex-encoded on disk.
fn device_key() -> anyhow::Result<[u8; 32]> {
    let dir = ensure_dir()?;
    let path = dir.join(DEVICE_KEY_FILE);
    if path.exists() {
        let hex_str = fs::read_to_string(&path)?;
        let bytes = hex::decode(hex_str.trim())
            .map_err(|e| anyhow::anyhow!("Corrupted device key: {e}"))?;
        if bytes.len() != 32 {
            anyhow::bail!("Device key has wrong length");
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    fs::write(&path, hex::encode(key))?;
    set_owner_only(&path);
    Ok(key)
}

fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> anyhow::Result<String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&out))
}

fn decrypt(encoded: &str, key: &[u8; 32]) -> anyhow::Result<Vec<u8>> {
    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| anyhow::anyhow!("Invalid base64: {e}"))?;
    if decoded.len() < NONCE_LEN {
        anyhow::bail!("Ciphertext too short");
    }
    let (nonce_bytes, ciphertext) = decoded.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| anyhow::anyhow!("Decryption failed (wrong device key or corrupted data)"))
}

pub fn save_credentials(creds: &StoredCredentials) -> anyhow::Result<()> {
    let dir = ensure_dir()?;
    let key = device_key()?;
    let json = serde_json::to_string(creds)?;
    let encoded = encrypt(json.as_bytes(), &key)?;
    let path = dir.join(CRED_FILE);
    fs::write(&path, encoded)?;
    set_owner_only(&path);
    Ok(())
}

pub fn load_credentials() -> anyhow::Result<Option<StoredCredentials>> {
    let dir = get_dir()?;
    let path = dir.join(CRED_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let encoded = fs::read_to_string(&path)?;
    let key = device_key()?;
    let plaintext = decrypt(&encoded, &key)?;
    let creds: StoredCredentials = serde_json::from_slice(&plaintext)?;
    Ok(Some(creds))
}

pub fn delete_credentials() -> anyhow::Result<bool> {
    let dir = get_dir()?;
    let path = dir.join(CRED_FILE);
    if path.exists() {
        fs::remove_file(&path)?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Тесты идут параллельными потоками в одном процессе и делят переменную
    // окружения VAULT_CREDENTIALS_DIR — сериализуем их мьютексом.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_dir<F: FnOnce(PathBuf)>(f: F) {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "vault-cred-test-{}",
            rand::random::<u64>()
        ));
        std::env::set_var("VAULT_CREDENTIALS_DIR", &dir);
        f(dir.clone());
        let _ = fs::remove_dir_all(&dir);
        std::env::remove_var("VAULT_CREDENTIALS_DIR");
    }

    fn sample() -> StoredCredentials {
        StoredCredentials {
            email: "demo@gmail.com".into(),
            password: "app-password-secret".into(),
            imap_server: "imap.gmail.com".into(),
            imap_port: 993,
            smtp_server: "smtp.gmail.com".into(),
            smtp_port: 587,
            saved_at: "2026-08-16T00:00:00Z".into(),
        }
    }

    #[test]
    fn test_save_load_roundtrip() {
        with_temp_dir(|dir| {
            save_credentials(&sample()).unwrap();
            // File on disk must NOT contain the plaintext password.
            let raw = fs::read_to_string(dir.join(CRED_FILE)).unwrap();
            assert!(!raw.contains("app-password-secret"));
            let loaded = load_credentials().unwrap().unwrap();
            assert_eq!(loaded.email, "demo@gmail.com");
            assert_eq!(loaded.password, "app-password-secret");
            assert_eq!(loaded.imap_port, 993);
        });
    }

    #[test]
    fn test_load_empty() {
        with_temp_dir(|_dir| {
            assert!(load_credentials().unwrap().is_none());
        });
    }

    #[test]
    fn test_delete() {
        with_temp_dir(|_dir| {
            save_credentials(&sample()).unwrap();
            assert!(delete_credentials().unwrap());
            assert!(load_credentials().unwrap().is_none());
            assert!(!delete_credentials().unwrap());
        });
    }

    #[test]
    fn test_wrong_key_fails() {
        with_temp_dir(|dir| {
            save_credentials(&sample()).unwrap();
            // Simulate copying the blob to another device: new device key.
            let key_path = dir.join(DEVICE_KEY_FILE);
            let blob = fs::read_to_string(dir.join(CRED_FILE)).unwrap();
            fs::remove_file(&key_path).unwrap();
            let _new_key = device_key().unwrap(); // generates a fresh key
            fs::write(dir.join(CRED_FILE), blob).unwrap();
            assert!(load_credentials().is_err());
        });
    }
}
