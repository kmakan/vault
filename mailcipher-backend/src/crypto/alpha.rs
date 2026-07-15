use super::CryptoError;

#[derive(Debug, Clone)]
pub struct AlphaCipher {
    key: String,
}

impl AlphaCipher {
    pub fn new(key: &str) -> Result<Self, CryptoError> {
        if key.is_empty() {
            return Err(CryptoError::from("Key cannot be empty"));
        }

        let key_upper = key.to_uppercase();
        if !key_upper.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(CryptoError::from("Key must contain only alphabetic characters"));
        }

        Ok(AlphaCipher {
            key: key_upper,
        })
    }

    pub fn encrypt(&self, plaintext: &str) -> String {
        let mut result = String::with_capacity(plaintext.len());
        let mut key_index = 0;

        for ch in plaintext.chars() {
            if ch.is_ascii_alphabetic() {
                let shift = self.key.as_bytes()[key_index % self.key.len()] - b'A';
                let base = if ch.is_ascii_uppercase() { b'A' } else { b'a' };
                let encrypted = ((ch as u8 - base + shift) % 26) + base;
                result.push(encrypted as char);
                key_index += 1;
            } else {
                result.push(ch);
            }
        }

        result
    }

    pub fn decrypt(&self, ciphertext: &str) -> String {
        let mut result = String::with_capacity(ciphertext.len());
        let mut key_index = 0;

        for ch in ciphertext.chars() {
            if ch.is_ascii_alphabetic() {
                let shift = self.key.as_bytes()[key_index % self.key.len()] - b'A';
                let base = if ch.is_ascii_uppercase() { b'A' } else { b'a' };
                let decrypted = (ch as u8 + 26 - base - shift) % 26 + base;
                result.push(decrypted as char);
                key_index += 1;
            } else {
                result.push(ch);
            }
        }

        result
    }

    pub fn key(&self) -> &str {
        &self.key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_alpha_encrypt_decrypt() {
        let cipher = AlphaCipher::new("MAGIC").unwrap();
        let plaintext = "HELLO WORLD";
        let encrypted = cipher.encrypt(plaintext);
        let decrypted = cipher.decrypt(&encrypted);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_alpha_encrypt_known() {
        let cipher = AlphaCipher::new("MAGIC").unwrap();
        let encrypted = cipher.encrypt("HELLO");
        assert_eq!(encrypted, "TERTQ");
    }

    #[test]
    fn test_alpha_preserves_case() {
        let cipher = AlphaCipher::new("KEY").unwrap();
        let encrypted = cipher.encrypt("Hello World");
        let decrypted = cipher.decrypt(&encrypted);
        assert_eq!(decrypted, "Hello World");
    }

    #[test]
    fn test_alpha_preserves_non_alpha() {
        let cipher = AlphaCipher::new("KEY").unwrap();
        let encrypted = cipher.encrypt("Hello, World!");
        let decrypted = cipher.decrypt(&encrypted);
        assert_eq!(decrypted, "Hello, World!");
    }

    #[test]
    fn test_alpha_empty_key() {
        assert!(AlphaCipher::new("").is_err());
    }

    #[test]
    fn test_alpha_non_alpha_key() {
        assert!(AlphaCipher::new("ABC123").is_err());
    }
}
