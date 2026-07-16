use super::{AlphaCipher, ColumnarCipher, CryptoError};

#[derive(Debug, Clone)]
pub struct CombinedEncryptor {
    alpha: AlphaCipher,
    columnar: ColumnarCipher,
}

#[derive(Debug, Clone)]
pub struct CombinedDecryptor {
    alpha: AlphaCipher,
    columnar: ColumnarCipher,
}

impl CombinedEncryptor {
    pub fn new(alpha_key: &str, columnar_key: &str) -> Result<Self, CryptoError> {
        let alpha = AlphaCipher::new(alpha_key)?;
        let columnar = ColumnarCipher::new(columnar_key)?;

        Ok(CombinedEncryptor { alpha, columnar })
    }

    pub fn encrypt(&self, plaintext: &str) -> String {
        let after_alpha = self.alpha.encrypt(plaintext);
        self.columnar.encrypt(&after_alpha)
    }
}

impl CombinedDecryptor {
    pub fn new(alpha_key: &str, columnar_key: &str) -> Result<Self, CryptoError> {
        let alpha = AlphaCipher::new(alpha_key)?;
        let columnar = ColumnarCipher::new(columnar_key)?;

        Ok(CombinedDecryptor { alpha, columnar })
    }

    pub fn decrypt(&self, ciphertext: &str) -> String {
        let after_columnar = self.columnar.decrypt(ciphertext);
        self.alpha.decrypt(&after_columnar)
    }
}

pub fn combined_encrypt(
    plaintext: &str,
    alpha_key: &str,
    columnar_key: &str,
) -> Result<String, CryptoError> {
    let encryptor = CombinedEncryptor::new(alpha_key, columnar_key)?;
    Ok(encryptor.encrypt(plaintext))
}

pub fn combined_decrypt(
    ciphertext: &str,
    alpha_key: &str,
    columnar_key: &str,
) -> Result<String, CryptoError> {
    let decryptor = CombinedDecryptor::new(alpha_key, columnar_key)?;
    Ok(decryptor.decrypt(ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_combined_encrypt_decrypt() {
        let encryptor = CombinedEncryptor::new("MAGIC", "3124").unwrap();
        let decryptor = CombinedDecryptor::new("MAGIC", "3124").unwrap();

        let plaintext = "HELLO WORLD";
        let encrypted = encryptor.encrypt(plaintext);
        let decrypted = decryptor.decrypt(&encrypted);

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_combined_functions() {
        let plaintext = "SECRET MESSAGE";
        let encrypted = combined_encrypt(plaintext, "KEY", "21").unwrap();
        let decrypted = combined_decrypt(&encrypted, "KEY", "21").unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_combined_different_keys() {
        let encryptor = CombinedEncryptor::new("ALPHA", "4321").unwrap();
        let decryptor = CombinedDecryptor::new("ALPHA", "4321").unwrap();

        let plaintext = "Hello, World! 123";
        let encrypted = encryptor.encrypt(plaintext);
        let decrypted = decryptor.decrypt(&encrypted);

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_combined_invalid_alpha_key() {
        assert!(CombinedEncryptor::new("", "123").is_err());
    }

    #[test]
    fn test_combined_invalid_columnar_key() {
        assert!(CombinedEncryptor::new("KEY", "").is_err());
    }
}
