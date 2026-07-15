use super::CryptoError;

#[derive(Debug, Clone)]
pub struct ColumnarCipher {
    key: String,
    column_order: Vec<usize>,
}

impl ColumnarCipher {
    pub fn new(key: &str) -> Result<Self, CryptoError> {
        if key.is_empty() {
            return Err(CryptoError::from("Key cannot be empty"));
        }

        if !key.chars().all(|c| c.is_ascii_digit()) {
            return Err(CryptoError::from("Key must contain only digits"));
        }

        let column_order = Self::parse_column_order(key)?;

        Ok(ColumnarCipher {
            key: key.to_string(),
            column_order,
        })
    }

    fn parse_column_order(key: &str) -> Result<Vec<usize>, CryptoError> {
        let digits: Vec<usize> = key.chars().map(|c| c.to_digit(10).unwrap() as usize).collect();

        let mut used = vec![false; digits.len() + 1];
        for &d in &digits {
            if d == 0 || d > digits.len() {
                return Err(CryptoError::from(format!(
                    "Invalid column index {} in key (must be 1-{})",
                    d,
                    digits.len()
                )));
            }
            if used[d] {
                return Err(CryptoError::from(format!("Duplicate column index {} in key", d)));
            }
            used[d] = true;
        }

        let mut indices: Vec<usize> = (0..digits.len()).collect();
        indices.sort_by_key(|&i| digits[i]);

        Ok(indices)
    }

    pub fn encrypt(&self, plaintext: &str) -> String {
        let text: Vec<char> = plaintext.chars().collect();
        let cols = self.key.len();

        if text.is_empty() {
            return String::new();
        }

        let rows = (text.len() + cols - 1) / cols;

        let mut matrix = vec![vec!['\0'; cols]; rows];
        for (i, &ch) in text.iter().enumerate() {
            matrix[i / cols][i % cols] = ch;
        }

        let mut result = String::with_capacity(text.len());
        for &col in &self.column_order {
            for row in 0..rows {
                if matrix[row][col] != '\0' {
                    result.push(matrix[row][col]);
                }
            }
        }

        result
    }

    pub fn decrypt(&self, ciphertext: &str) -> String {
        let text: Vec<char> = ciphertext.chars().collect();
        let cols = self.key.len();

        if text.is_empty() {
            return String::new();
        }

        let rows = text.len() / cols;
        let remainder = text.len() % cols;

        let mut matrix = vec![vec!['\0'; cols]; rows + 1];

        let mut idx = 0;
        for &col in &self.column_order {
            let col_len = if col < remainder { rows + 1 } else { rows };

            for row in 0..col_len {
                if idx < text.len() {
                    matrix[row][col] = text[idx];
                    idx += 1;
                }
            }
        }

        let mut result = String::with_capacity(text.len());
        for row in 0..rows + 1 {
            for col in 0..cols {
                if matrix[row][col] != '\0' {
                    result.push(matrix[row][col]);
                }
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
    fn test_columnar_encrypt_decrypt() {
        let cipher = ColumnarCipher::new("3124").unwrap();
        let plaintext = "HELLOWORLD";
        let encrypted = cipher.encrypt(plaintext);
        let decrypted = cipher.decrypt(&encrypted);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_columnar_encrypt_known() {
        let cipher = ColumnarCipher::new("3124").unwrap();
        let encrypted = cipher.encrypt("HELLOWORLD");
        assert_eq!(encrypted, "EWDLOHOLLR");
    }

    #[test]
    fn test_columnar_with_spaces() {
        let cipher = ColumnarCipher::new("3124").unwrap();
        let plaintext = "HELLO WORLD";
        let encrypted = cipher.encrypt(plaintext);
        let decrypted = cipher.decrypt(&encrypted);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_columnar_short_key() {
        let cipher = ColumnarCipher::new("21").unwrap();
        let plaintext = "ABCD";
        let encrypted = cipher.encrypt(plaintext);
        let decrypted = cipher.decrypt(&encrypted);
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_columnar_empty_key() {
        assert!(ColumnarCipher::new("").is_err());
    }

    #[test]
    fn test_columnar_non_digit_key() {
        assert!(ColumnarCipher::new("ABC").is_err());
    }

    #[test]
    fn test_columnar_invalid_column_index() {
        assert!(ColumnarCipher::new("0123").is_err());
    }

    #[test]
    fn test_columnar_duplicate_column() {
        assert!(ColumnarCipher::new("1123").is_err());
    }
}
