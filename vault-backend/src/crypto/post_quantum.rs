//! Модуль пост-квантового шифрования (Kyber-1024 KEM)
//!
//! Реализует Key Encapsulation Mechanism (KEM) на основе
//! кристаллического решеточного алгоритма Kyber-1024.
//! Используется crate pqc_kyber с feature kyber1024.

use pqc_kyber::*;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use super::CryptoError;

/// Структура для хранения Kyber ключевой пары
#[derive(Debug, Clone)]
pub struct KyberKeyPair {
    /// Секретный ключ
    pub secret_key: Vec<u8>,
    /// Публичный ключ
    pub public_key: Vec<u8>,
}

/// Размер секретного ключа Kyber-1024
pub const KYBER_SECRET_KEY_SIZE: usize = KYBER_SECRETKEYBYTES;

/// Размер публичного ключа Kyber-1024
pub const KYBER_PUBLIC_KEY_SIZE: usize = KYBER_PUBLICKEYBYTES;

/// Размер шифротекста Kyber-1024
pub const KYBER_CIPHERTEXT_SIZE: usize = KYBER_CIPHERTEXTBYTES;

/// Размер общего секрета Kyber-1024
pub const KYBER_SHARED_SECRET_SIZE: usize = KYBER_SSBYTES;

/// Генерирует новую Kyber-1024 ключевую пару
///
/// Возвращает `KyberKeyPair` с публичным и секретным ключами.
pub fn generate_kyber_keypair() -> Result<KyberKeyPair, CryptoError> {
    let mut rng = rand::thread_rng();
    let kp = keypair(&mut rng)
        .map_err(|e| CryptoError::from(format!("Ошибка генерации ключей: {:?}", e)))?;

    Ok(KyberKeyPair {
        secret_key: kp.secret.to_vec(),
        public_key: kp.public.to_vec(),
    })
}

/// Инкапсулирует общий секрет с использованием публичного ключа получателя
///
/// # Аргументы
/// * `public_key` - публичный ключ Kyber-1024
///
/// # Возвращает
/// Кортеж (шифротекст, общий секрет)
pub fn kyber_encapsulate(public_key: &[u8]) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
    if public_key.len() != KYBER_PUBLIC_KEY_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер публичного ключа: ожидался {}, получен {}",
            KYBER_PUBLIC_KEY_SIZE,
            public_key.len()
        )));
    }

    let mut pk = [0u8; KYBER_PUBLICKEYBYTES];
    pk.copy_from_slice(public_key);

    let mut rng = rand::thread_rng();
    let (ct, ss) = encapsulate(&pk, &mut rng)
        .map_err(|e| CryptoError::from(format!("Ошибка инкапсуляции: {:?}", e)))?;

    Ok((ct.to_vec(), ss.to_vec()))
}

/// Деинкапсулирует общий секрет используя секретный ключ
///
/// # Аргументы
/// * `secret_key` - секретный ключ Kyber-1024
/// * `ciphertext` - шифротекст
///
/// # Возвращает
/// Общий секрет
pub fn kyber_decapsulate(secret_key: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if secret_key.len() != KYBER_SECRET_KEY_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер секретного ключа: ожидался {}, получен {}",
            KYBER_SECRET_KEY_SIZE,
            secret_key.len()
        )));
    }

    if ciphertext.len() != KYBER_CIPHERTEXT_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер шифротекста: ожидался {}, получен {}",
            KYBER_CIPHERTEXT_SIZE,
            ciphertext.len()
        )));
    }

    let mut sk = [0u8; KYBER_SECRETKEYBYTES];
    sk.copy_from_slice(secret_key);

    let mut ct = [0u8; KYBER_CIPHERTEXTBYTES];
    ct.copy_from_slice(ciphertext);

    let ss = decapsulate(&ct, &sk)
        .map_err(|e| CryptoError::from(format!("Ошибка деинкапсуляции: {:?}", e)))?;

    Ok(ss.to_vec())
}

/// Кодирует публичный ключ в Base64
pub fn kyber_public_key_to_base64(key: &[u8]) -> String {
    BASE64.encode(key)
}

/// Декодирует публичный ключ из Base64
pub fn kyber_public_key_from_base64(encoded: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64
        .decode(encoded)
        .map_err(|e| CryptoError::from(format!("Неверный Base64 публичного ключа: {}", e)))
}

/// Кодирует секретный ключ в Base64
pub fn kyber_secret_key_to_base64(key: &[u8]) -> String {
    BASE64.encode(key)
}

/// Декодирует секретный ключ из Base64
pub fn kyber_secret_key_from_base64(encoded: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64
        .decode(encoded)
        .map_err(|e| CryptoError::from(format!("Неверный Base64 секретного ключа: {}", e)))
}

/// Кодирует шифротекст в Base64
pub fn kyber_ciphertext_to_base64(ct: &[u8]) -> String {
    BASE64.encode(ct)
}

/// Декодирует шифротекст из Base64
pub fn kyber_ciphertext_from_base64(encoded: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64
        .decode(encoded)
        .map_err(|e| CryptoError::from(format!("Неверный Base64 шифротекста: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kyber_key_generation() {
        let kp = generate_kyber_keypair().unwrap();
        assert_eq!(kp.public_key.len(), KYBER_PUBLIC_KEY_SIZE);
        assert_eq!(kp.secret_key.len(), KYBER_SECRET_KEY_SIZE);
    }

    #[test]
    fn test_kyber_encapsulate_decapsulate() {
        let kp = generate_kyber_keypair().unwrap();
        let (ct, ss1) = kyber_encapsulate(&kp.public_key).unwrap();
        let ss2 = kyber_decapsulate(&kp.secret_key, &ct).unwrap();
        assert_eq!(ss1, ss2);
    }

    #[test]
    fn test_kyber_invalid_public_key_length() {
        let invalid_key = vec![0u8; 100];
        assert!(kyber_encapsulate(&invalid_key).is_err());
    }

    #[test]
    fn test_kyber_invalid_secret_key_length() {
        let kp = generate_kyber_keypair().unwrap();
        let (ct, _) = kyber_encapsulate(&kp.public_key).unwrap();
        let invalid_sk = vec![0u8; 100];
        assert!(kyber_decapsulate(&invalid_sk, &ct).is_err());
    }

    #[test]
    fn test_kyber_invalid_ciphertext_length() {
        let kp = generate_kyber_keypair().unwrap();
        let invalid_ct = vec![0u8; 100];
        assert!(kyber_decapsulate(&kp.secret_key, &invalid_ct).is_err());
    }

    #[test]
    fn test_kyber_base64_encoding() {
        let kp = generate_kyber_keypair().unwrap();
        let pk_b64 = kyber_public_key_to_base64(&kp.public_key);
        let pk_decoded = kyber_public_key_from_base64(&pk_b64).unwrap();
        assert_eq!(kp.public_key, pk_decoded);

        let sk_b64 = kyber_secret_key_to_base64(&kp.secret_key);
        let sk_decoded = kyber_secret_key_from_base64(&sk_b64).unwrap();
        assert_eq!(kp.secret_key, sk_decoded);
    }

    #[test]
    fn test_kyber_shared_secret_sizes() {
        let kp = generate_kyber_keypair().unwrap();
        let (ct, ss) = kyber_encapsulate(&kp.public_key).unwrap();
        // Каждый KEM вызов генерирует уникальный общий секрет
        assert_eq!(ss.len(), KYBER_SHARED_SECRET_SIZE);
        assert_eq!(ct.len(), KYBER_CIPHERTEXT_SIZE);
    }
}
