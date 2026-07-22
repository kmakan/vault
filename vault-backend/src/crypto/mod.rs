pub mod alpha;
pub mod argon2;
pub mod binary;
pub mod columnar;
pub mod combined;
pub mod double_ratchet;
pub mod encryptor;
pub mod hybrid;
pub mod pake;
pub mod post_quantum;
pub mod sealed;
pub mod signing;
pub mod x3dh;
pub mod xchacha;

pub use alpha::AlphaCipher;
pub use binary::{
    decrypt_bytes, encrypt_bytes,
};
pub use columnar::ColumnarCipher;
pub use combined::CombinedEncryptor;
pub use sealed::seal;
pub use signing::Ed25519Signer;

use rand::Rng;

const NOISE_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

pub fn add_noise(ciphertext: &str, noise_ratio: f64) -> String {
    let original_len = ciphertext.len();
    let noise_count = (original_len as f64 * noise_ratio) as usize;
    let mut rng = rand::thread_rng();
    let mut result = String::with_capacity(original_len + noise_count + 5);

    result.push_str(&format!("{:04}#", original_len));

    let mut noise_positions: Vec<usize> = (0..noise_count)
        .map(|_| rng.gen_range(0..=result.len()))
        .collect();
    noise_positions.sort_unstable();

    let mut char_idx = 0;
    for (i, &pos) in noise_positions.iter().enumerate() {
        let adjusted_pos = pos + i;
        while char_idx < ciphertext.len() && result.len() < adjusted_pos {
            result.push(ciphertext.as_bytes()[char_idx] as char);
            char_idx += 1;
        }
        let noise_char = NOISE_CHARS[rng.gen_range(0..NOISE_CHARS.len())] as char;
        result.push(noise_char);
    }

    while char_idx < ciphertext.len() {
        result.push(ciphertext.as_bytes()[char_idx] as char);
        char_idx += 1;
    }

    result
}

pub fn remove_noise(noised_text: &str) -> Result<String, CryptoError> {
    let header_end = noised_text.find('#').ok_or("Invalid noise format: missing header")?;
    let original_len: usize = noised_text[..header_end]
        .parse()
        .map_err(|_| "Invalid noise format: bad header")?;
    let body = &noised_text[header_end + 1..];

    if body.len() < original_len {
        return Err(CryptoError::from("Invalid noise format: body too short"));
    }

    let skip = body.len() - original_len;
    let mut result = String::with_capacity(original_len);
    let mut noise_count = 0;

    for ch in body.chars() {
        if NOISE_CHARS.contains(&(ch as u8)) && noise_count < skip {
            noise_count += 1;
            continue;
        }
        result.push(ch);
    }

    if result.len() != original_len {
        return Err(CryptoError::from("Noise removal failed: length mismatch"));
    }

    Ok(result)
}

#[derive(Debug, Clone)]
pub struct CryptoError {
    pub message: String,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Crypto error: {}", self.message)
    }
}

impl std::error::Error for CryptoError {}

impl From<&str> for CryptoError {
    fn from(s: &str) -> Self {
        CryptoError {
            message: s.to_string(),
        }
    }
}

impl From<String> for CryptoError {
    fn from(s: String) -> Self {
        CryptoError { message: s }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_remove_noise_roundtrip() {
        let plaintext = "HELLO WORLD";
        let encryptor = CombinedEncryptor::new("MAGIC", "3124").unwrap();
        let encrypted = encryptor.encrypt(plaintext);
        let noised = add_noise(&encrypted, 0.3);
        let removed = remove_noise(&noised).unwrap();
        assert_eq!(removed, encrypted);
    }

    #[test]
    fn test_add_noise_increases_length() {
        let text = "TEST";
        let noised = add_noise(text, 0.5);
        assert!(noised.len() > text.len());
    }

    #[test]
    fn test_remove_noise_invalid_header() {
        assert!(remove_noise("nogood").is_err());
    }

    #[test]
    fn test_remove_noise_too_short() {
        assert!(remove_noise("0100#abc").is_err());
    }

    #[test]
    fn test_noise_with_zero_ratio() {
        let text = "HELLO";
        let noised = add_noise(text, 0.0);
        assert_eq!(noised, "0005#HELLO");
    }

    #[test]
    fn test_noise_with_high_ratio() {
        let text = "ABC";
        let noised = add_noise(text, 1.0);
        let removed = remove_noise(&noised).unwrap();
        assert_eq!(removed, text);
    }
}
