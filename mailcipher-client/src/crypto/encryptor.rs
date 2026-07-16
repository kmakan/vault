use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::{Signer, SigningKey, Verifier};
use rand::rngs::OsRng;
use std::path::Path;

const NONCE_LEN: usize = 24;
const FORMAT_VERSION: &str = "1";

#[derive(Debug, Clone)]
pub enum DataType {
    Text,
    File {
        filename: String,
        content_type: String,
    },
}

/// Standalone Encryptor/Decryptor for Whisper Vault
///
/// Produces transport-agnostic encrypted output that can be shared via
/// any channel (WhatsApp, Telegram, email, etc.) and decrypted by any
/// Whisper client that has the matching key.
pub struct Encryptor {
    signing_key: SigningKey,
}

impl Encryptor {
    /// Create a new Encryptor with a fresh signing key
    pub fn new() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        Self { signing_key }
    }

    /// Create an Encryptor from an existing signing key bytes
    pub fn from_key_bytes(key_bytes: &[u8; 32]) -> Self {
        let signing_key = SigningKey::from_bytes(key_bytes);
        Self { signing_key }
    }

    /// Get the verifying (public) key as hex
    pub fn public_key_hex(&self) -> String {
        hex::encode(self.signing_key.verifying_key().to_bytes())
    }

    /// Get the signing (private) key as hex
    pub fn private_key_hex(&self) -> String {
        hex::encode(self.signing_key.to_bytes())
    }

    /// Encrypt plaintext text
    pub fn encrypt_text(&self, plaintext: &str) -> String {
        self.encrypt_inner(plaintext.as_bytes(), DataType::Text)
            .expect("Encryption should not fail")
    }

    /// Encrypt binary data from a file
    pub fn encrypt_file(&self, path: &Path) -> Result<String> {
        let data = std::fs::read(path).context("Failed to read file")?;
        let filename = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let content_type = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();

        self.encrypt_inner(
            &data,
            DataType::File {
                filename,
                content_type,
            },
        )
    }

    /// Encrypt bytes with a given data type
    fn encrypt_inner(&self, plaintext: &[u8], data_type: DataType) -> Result<String> {
        // Generate ephemeral encryption key
        let enc_key: [u8; 32] = rand::random();
        let cipher = XChaCha20Poly1305::new((&enc_key).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        // Pack: nonce || ciphertext || enc_key
        let mut payload = Vec::with_capacity(NONCE_LEN + ciphertext.len() + 32);
        payload.extend_from_slice(&nonce_bytes);
        payload.extend_from_slice(&ciphertext);
        payload.extend_from_slice(&enc_key);

        // Sign the payload
        let signature = self.signing_key.sign(&payload);

        // Build header
        let mut header = String::new();
        header.push_str(&format!("Version: {}\n", FORMAT_VERSION));
        match &data_type {
            DataType::Text => {
                header.push_str("Type: text\n");
            }
            DataType::File {
                filename,
                content_type,
            } => {
                header.push_str("Type: file\n");
                header.push_str(&format!("Filename: {}\n", filename));
                header.push_str(&format!("Content-Type: {}\n", content_type));
            }
        }

        let payload_b64 = BASE64.encode(&payload);
        let signature_b64 = BASE64.encode(signature.to_bytes());

        let mut output = String::new();
        output.push_str("---BEGIN WHISPER ENCRYPTED---\n");
        output.push_str(&header);
        output.push_str("---\n");
        output.push_str(&payload_b64);
        output.push('\n');
        output.push_str(&signature_b64);
        output.push('\n');
        output.push_str("---END WHISPER ENCRYPTED---\n");

        Ok(output)
    }

    /// Decrypt an encrypted message/file block
    pub fn decrypt(&self, encrypted: &str) -> Result<DecryptedContent> {
        let parsed = parse_encrypted_block(encrypted)?;

        let payload = BASE64
            .decode(&parsed.payload_b64)
            .context("Invalid Base64 in payload")?;
        let signature_bytes = BASE64
            .decode(&parsed.signature_b64)
            .context("Invalid Base64 in signature")?;

        // Verify signature
        let sig_arr: [u8; 64] = signature_bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid signature length"))?;
        let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);

        let verifying_key = self.signing_key.verifying_key();
        verifying_key
            .verify(&payload, &signature)
            .context("Signature verification failed — wrong key or tampered data")?;

        // Extract parts: nonce || ciphertext || enc_key
        if payload.len() < NONCE_LEN + 16 + 32 {
            anyhow::bail!("Payload too short");
        }

        let enc_key_start = payload.len() - 32;
        let ciphertext_end = enc_key_start;
        let nonce_end = NONCE_LEN;

        let nonce = XNonce::from_slice(&payload[..nonce_end]);
        let ciphertext = &payload[nonce_end..ciphertext_end];
        let enc_key: [u8; 32] = payload[enc_key_start..].try_into().unwrap();

        let cipher = XChaCha20Poly1305::new((&enc_key).into());
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| anyhow::anyhow!("Decryption failed — corrupted data: {}", e))?;

        match parsed.data_type {
            DataType::Text => {
                let text =
                    String::from_utf8(plaintext).context("Decrypted data is not valid UTF-8")?;
                Ok(DecryptedContent::Text(text))
            }
            DataType::File {
                filename,
                content_type,
            } => Ok(DecryptedContent::File {
                data: plaintext,
                filename,
                content_type,
            }),
        }
    }
}

impl Default for Encryptor {
    fn default() -> Self {
        Self::new()
    }
}

pub enum DecryptedContent {
    Text(String),
    File {
        data: Vec<u8>,
        filename: String,
        content_type: String,
    },
}

struct ParsedBlock {
    data_type: DataType,
    payload_b64: String,
    signature_b64: String,
}

fn parse_encrypted_block(input: &str) -> Result<ParsedBlock> {
    let input = input.trim();

    let begin_marker = "---BEGIN WHISPER ENCRYPTED---";
    let end_marker = "---END WHISPER ENCRYPTED---";

    let start = input.find(begin_marker).context("Missing BEGIN marker")?;
    let end = input.find(end_marker).context("Missing END marker")?;

    let block = &input[start + begin_marker.len()..end];
    let block = block.trim();

    // Split on "---" separator between header and body
    let sep_pos = block
        .find("---")
        .context("Missing header/body separator (---)")?;
    let header = block[..sep_pos].trim();
    let body = block[sep_pos + 3..].trim();

    // Parse header
    let mut version = None;
    let mut data_type = None;
    let mut filename = None;
    let mut content_type = None;

    for line in header.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("Version: ") {
            version = Some(v.trim().to_string());
        } else if let Some(t) = line.strip_prefix("Type: ") {
            data_type = Some(t.trim().to_string());
        } else if let Some(f) = line.strip_prefix("Filename: ") {
            filename = Some(f.trim().to_string());
        } else if let Some(ct) = line.strip_prefix("Content-Type: ") {
            content_type = Some(ct.trim().to_string());
        }
    }

    let _version = version.context("Missing Version in header")?;
    let type_str = data_type.context("Missing Type in header")?;

    let dt = match type_str.as_str() {
        "text" => DataType::Text,
        "file" => DataType::File {
            filename: filename.unwrap_or_else(|| "unknown".into()),
            content_type: content_type.unwrap_or_else(|| "application/octet-stream".into()),
        },
        other => anyhow::bail!("Unknown data type: {}", other),
    };

    // Parse body: payload_b64 \n signature_b64
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() < 2 {
        anyhow::bail!("Expected payload and signature in body");
    }

    Ok(ParsedBlock {
        data_type: dt,
        payload_b64: lines[0].trim().to_string(),
        signature_b64: lines[1].trim().to_string(),
    })
}

/// Quick check if a string looks like a Whisper encrypted block
pub fn is_whisper_encrypted(input: &str) -> bool {
    input.contains("---BEGIN WHISPER ENCRYPTED---") && input.contains("---END WHISPER ENCRYPTED---")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_text_roundtrip() {
        let enc = Encryptor::new();
        let plaintext = "Hello, Whisper Vault! Привет, мир!";
        let encrypted = enc.encrypt_text(plaintext);

        assert!(encrypted.contains("---BEGIN WHISPER ENCRYPTED---"));
        assert!(encrypted.contains("Type: text"));
        assert!(encrypted.contains("---END WHISPER ENCRYPTED---"));
        assert_ne!(encrypted, plaintext);

        let decrypted = enc.decrypt(&encrypted).unwrap();
        match decrypted {
            DecryptedContent::Text(t) => assert_eq!(t, plaintext),
            _ => panic!("Expected text"),
        }
    }

    #[test]
    fn test_encrypt_decrypt_file_roundtrip() {
        let enc = Encryptor::new();
        let temp_dir = std::env::temp_dir().join("whisper_encryptor_test");
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("test_secret.txt");
        let content = b"Binary content: \x00\x01\x02\x03\xff\xfe";
        std::fs::write(&file_path, content).unwrap();

        let encrypted = enc.encrypt_file(&file_path).unwrap();
        assert!(encrypted.contains("Type: file"));
        assert!(encrypted.contains("Filename: test_secret.txt"));

        let decrypted = enc.decrypt(&encrypted).unwrap();
        match decrypted {
            DecryptedContent::File {
                data,
                filename,
                content_type,
            } => {
                assert_eq!(data, content);
                assert_eq!(filename, "test_secret.txt");
                assert!(content_type.contains("text"));
            }
            _ => panic!("Expected file"),
        }

        std::fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_wrong_key_rejects() {
        let enc1 = Encryptor::new();
        let enc2 = Encryptor::new();

        let encrypted = enc1.encrypt_text("secret message");
        let result = enc2.decrypt(&encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn test_tampered_payload_rejects() {
        let enc = Encryptor::new();
        let encrypted = enc.encrypt_text("secret message");

        // Tamper with the payload (flip a character in the middle)
        let lines: Vec<&str> = encrypted.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.len() > 100 && !line.starts_with("---") {
                // This is likely the payload line
                let mut payload_chars: Vec<char> = line.chars().collect();
                if payload_chars.len() > 50 {
                    payload_chars[50] = if payload_chars[50] == 'A' { 'B' } else { 'A' };
                    let tampered_line: String = payload_chars.into_iter().collect();
                    let mut new_lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
                    new_lines[i] = tampered_line;
                    let tampered = new_lines.join("\n");
                    let result = enc.decrypt(&tampered);
                    assert!(result.is_err(), "Should reject tampered payload");
                    return;
                }
            }
        }
        panic!("Could not find payload to tamper");
    }

    #[test]
    fn test_format_output_structure() {
        let enc = Encryptor::new();
        let encrypted = enc.encrypt_text("test");

        let lines: Vec<&str> = encrypted.lines().collect();
        assert_eq!(lines[0], "---BEGIN WHISPER ENCRYPTED---");
        assert!(lines[1].starts_with("Version: "));
        assert!(lines[2].starts_with("Type: "));
        assert_eq!(lines[3], "---");
        assert!(!lines[4].is_empty()); // payload
        assert!(!lines[5].is_empty()); // signature
        assert_eq!(lines[6], "---END WHISPER ENCRYPTED---");
    }

    #[test]
    fn test_is_whisper_encrypted() {
        assert!(is_whisper_encrypted(
            "---BEGIN WHISPER ENCRYPTED---\n---END WHISPER ENCRYPTED---"
        ));
        assert!(!is_whisper_encrypted("just plain text"));
        assert!(!is_whisper_encrypted("some base64 data"));
    }

    #[test]
    fn test_from_key_bytes() {
        let key_bytes: [u8; 32] = rand::random();
        let enc1 = Encryptor::from_key_bytes(&key_bytes);
        let enc2 = Encryptor::from_key_bytes(&key_bytes);

        let encrypted = enc1.encrypt_text("cross-instance");
        let decrypted = enc2.decrypt(&encrypted).unwrap();
        match decrypted {
            DecryptedContent::Text(t) => assert_eq!(t, "cross-instance"),
            _ => panic!("Expected text"),
        }
    }

    #[test]
    fn test_large_text() {
        let enc = Encryptor::new();
        let large_text = "A".repeat(100_000);
        let encrypted = enc.encrypt_text(&large_text);
        let decrypted = enc.decrypt(&encrypted).unwrap();
        match decrypted {
            DecryptedContent::Text(t) => assert_eq!(t.len(), 100_000),
            _ => panic!("Expected text"),
        }
    }
}
