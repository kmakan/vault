use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::{Signer, Verifier};
use hkdf::Hkdf;
use sha2::Sha256;

use super::CryptoError;

/// Вид зашифрованного контента
#[derive(Debug, Clone, PartialEq)]
pub enum ContentType {
    Text,
    File,
}

/// Расшифрованный контент
#[derive(Debug, Clone)]
pub struct DecryptedContent {
    pub content_type: ContentType,
    pub data: Vec<u8>,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
}

/// Шифровальщик/расшифровальщик для standalone использования
pub struct Encryptor {
    key: [u8; 32],
}

impl Encryptor {
    /// Создать шифровальщик из ключа
    pub fn new(key: &[u8; 32]) -> Self {
        Self { key: *key }
    }

    /// Создать шифровальщик из пароля
    pub fn from_password(password: &str, salt: &[u8]) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(salt), password.as_bytes());
        let mut key = [0u8; 32];
        hk.expand(b"vault-encryptor-key", &mut key)
            .expect("HKDF expansion failed");
        Self { key }
    }

    /// Зашифровать текст
    pub fn encrypt_text(&self, plaintext: &str) -> Result<String, CryptoError> {
        self.encrypt_with_type(plaintext.as_bytes(), ContentType::Text, None, None)
    }

    /// Зашифровать файл
    pub fn encrypt_file(
        &self,
        data: &[u8],
        filename: &str,
        mime_type: &str,
    ) -> Result<String, CryptoError> {
        self.encrypt_with_type(data, ContentType::File, Some(filename), Some(mime_type))
    }

    /// Шифрование с указанием типа
    fn encrypt_with_type(
        &self,
        data: &[u8],
        content_type: ContentType,
        filename: Option<&str>,
        mime_type: Option<&str>,
    ) -> Result<String, CryptoError> {
        let cipher = XChaCha20Poly1305::new(self.key.as_ref().into());
        let nonce = XNonce::from(rand::random::<[u8; 24]>());

        let ciphertext = cipher
            .encrypt(&nonce, data)
            .map_err(|e| CryptoError::from(format!("Encryption failed: {}", e)))?;

        // Генерируем ключ подписи из основного ключа
        let signing_key = self.derive_signing_key();
        let signer = ed25519_dalek::SigningKey::from_bytes(&signing_key);

        // Подписываем: nonce + ciphertext
        let mut sign_data = nonce.to_vec();
        sign_data.extend_from_slice(&ciphertext);
        let signature = signer.sign(&sign_data);

        // Формируем вывод
        let mut output = String::new();
        output.push_str("---BEGIN VAULT ENCRYPTED---\n");
        output.push_str("Version: 1\n");
        output.push_str(&format!("Type: {}\n", match content_type {
            ContentType::Text => "text",
            ContentType::File => "file",
        }));
        if let Some(f) = filename {
            output.push_str(&format!("Filename: {}\n", f));
        }
        if let Some(m) = mime_type {
            output.push_str(&format!("Content-Type: {}\n", m));
        }
        output.push_str("---\n");
        output.push_str(&format!("Nonce: {}\n", BASE64.encode(&nonce)));
        output.push_str(&format!("Signature: {}\n", BASE64.encode(&signature.to_bytes())));
        output.push_str(&format!("Content: {}\n", BASE64.encode(&ciphertext)));
        output.push_str("---END VAULT ENCRYPTED---\n");

        Ok(output)
    }

    /// Расшифровать
    pub fn decrypt(&self, encrypted: &str) -> Result<DecryptedContent, CryptoError> {
        // Парсим формат
        let (header, content, nonce_b64, signature_b64) = self.parse_encrypted(encrypted)?;

        // Восстанавливаем данные
        let nonce_bytes = BASE64
            .decode(&nonce_b64)
            .map_err(|e| CryptoError::from(format!("Invalid nonce: {}", e)))?;
        let signature_bytes = BASE64
            .decode(&signature_b64)
            .map_err(|e| CryptoError::from(format!("Invalid signature: {}", e)))?;
        let ciphertext = BASE64
            .decode(&content)
            .map_err(|e| CryptoError::from(format!("Invalid ciphertext: {}", e)))?;

        // Проверяем подпись
        let verifier = self.derive_verifying_key();

        let mut sign_data = nonce_bytes.clone();
        sign_data.extend_from_slice(&ciphertext);

        let signature = ed25519_dalek::Signature::from_bytes(
            &signature_bytes.try_into().map_err(|_| CryptoError::from("Invalid signature length"))?,
        );

        verifier
            .verify(&sign_data, &signature)
            .map_err(|e| CryptoError::from(format!("Signature verification failed: {}", e)))?;

        // Расшифровываем
        let cipher = XChaCha20Poly1305::new(self.key.as_ref().into());
        let nonce = XNonce::from_slice(&nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| CryptoError::from(format!("Decryption failed: {}", e)))?;

        // Определяем тип контента
        let content_type = match header.get("Type").map(|s| s.as_str()) {
            Some("file") => ContentType::File,
            _ => ContentType::Text,
        };

        let filename = header.get("Filename").cloned();
        let mime_type = header.get("Content-Type").cloned();

        Ok(DecryptedContent {
            content_type,
            data: plaintext,
            filename,
            mime_type,
        })
    }

    /// Парсим зашифрованное сообщение
    fn parse_encrypted(
        &self,
        encrypted: &str,
    ) -> Result<(HashMap<String, String>, String, String, String), CryptoError> {
        if !encrypted.contains("---BEGIN VAULT ENCRYPTED---") {
            return Err(CryptoError::from("Not a Vault encrypted message"));
        }

        let mut header = HashMap::new();
        let mut content = String::new();
        let mut nonce = String::new();
        let mut signature = String::new();

        let _in_content = false;
        let mut past_header = false;

        for line in encrypted.lines() {
            let line = line.trim();

            if line == "---BEGIN VAULT ENCRYPTED---" {
                continue;
            }
            if line == "---END VAULT ENCRYPTED---" {
                break;
            }
            if line == "---" {
                if !past_header {
                    past_header = true;
                }
                continue;
            }

            if !past_header {
                if let Some((key, value)) = line.split_once(':') {
                    header.insert(key.trim().to_string(), value.trim().to_string());
                }
            } else if line.starts_with("Nonce: ") {
                nonce = line[7..].to_string();
            } else if line.starts_with("Signature: ") {
                signature = line[11..].to_string();
            } else if line.starts_with("Content: ") {
                content = line[9..].to_string();
            }
        }

        if nonce.is_empty() || signature.is_empty() || content.is_empty() {
            return Err(CryptoError::from("Invalid encrypted format"));
        }

        Ok((header, content, nonce, signature))
    }

    /// Derive signing key from main key
    fn derive_signing_key(&self) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(None, &self.key);
        let mut key = [0u8; 32];
        hk.expand(b"ed25519-signing-key", &mut key)
            .expect("HKDF expansion failed");
        key
    }

    /// Derive verifying key from signing key
    fn derive_verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        let signing_key = self.derive_signing_key();
        let signing = ed25519_dalek::SigningKey::from_bytes(&signing_key);
        signing.verifying_key()
    }
}

/// Проверить, является ли строка зашифрованным сообщением Vault
pub fn is_vault_encrypted(text: &str) -> bool {
    text.contains("---BEGIN VAULT ENCRYPTED---")
}

use std::collections::HashMap;

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        [42u8; 32]
    }

    #[test]
    fn test_encrypt_decrypt_text() {
        let encryptor = Encryptor::new(&test_key());
        let plaintext = "Hello, World! Это тестовое сообщение.";

        let encrypted = encryptor.encrypt_text(plaintext).unwrap();
        assert!(encrypted.contains("---BEGIN VAULT ENCRYPTED---"));
        assert!(encrypted.contains("Type: text"));

        let decrypted = encryptor.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted.content_type, ContentType::Text);
        assert_eq!(String::from_utf8(decrypted.data).unwrap(), plaintext);
    }

    #[test]
    fn test_encrypt_decrypt_file() {
        let encryptor = Encryptor::new(&test_key());
        let file_data = b"Binary file content: \x00\x01\x02\x03";

        let encrypted = encryptor
            .encrypt_file(file_data, "test.bin", "application/octet-stream")
            .unwrap();
        assert!(encrypted.contains("Filename: test.bin"));
        assert!(encrypted.contains("Content-Type: application/octet-stream"));

        let decrypted = encryptor.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted.content_type, ContentType::File);
        assert_eq!(decrypted.data, file_data);
        assert_eq!(decrypted.filename.as_deref(), Some("test.bin"));
        assert_eq!(decrypted.mime_type.as_deref(), Some("application/octet-stream"));
    }

    #[test]
    fn test_wrong_key_fails() {
        let encryptor = Encryptor::new(&test_key());
        let encrypted = encryptor.encrypt_text("secret").unwrap();

        let wrong_key = [99u8; 32];
        let wrong_encryptor = Encryptor::new(&wrong_key);

        let result = wrong_encryptor.decrypt(&encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn test_different_nonces() {
        let encryptor = Encryptor::new(&test_key());
        let enc1 = encryptor.encrypt_text("same text").unwrap();
        let enc2 = encryptor.encrypt_text("same text").unwrap();

        // Разные nonce → разный ciphertext
        assert_ne!(enc1, enc2);
    }

    #[test]
    fn test_is_vault_encrypted() {
        assert!(is_vault_encrypted("---BEGIN VAULT ENCRYPTED---"));
        assert!(!is_vault_encrypted("普通文本"));
        assert!(!is_vault_encrypted("-----BEGIN PGP MESSAGE-----"));
    }

    #[test]
    fn test_not_vault_encrypted() {
        let encryptor = Encryptor::new(&test_key());
        let result = encryptor.decrypt("普通文本");
        assert!(result.is_err());
    }

    #[test]
    fn test_from_password() {
        let enc1 = Encryptor::from_password("password", b"fixedsalt");
        let enc2 = Encryptor::from_password("password", b"fixedsalt");
        
        let encrypted = enc1.encrypt_text("test").unwrap();
        let decrypted = enc2.decrypt(&encrypted).unwrap();
        assert_eq!(String::from_utf8(decrypted.data).unwrap(), "test");
    }
}
