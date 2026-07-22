//! Модуль гибридного шифрования (X25519 + Kyber-1024)
//!
//! Объединяет классический обмен ключами X25519 с пост-квантовым
//! Kyber-1024 для обеспечения безопасности в эпоху квантовых компьютеров.

use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use rand::rngs::OsRng;
use hkdf::Hkdf;
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use super::post_quantum::{
    generate_kyber_keypair, kyber_encapsulate, kyber_decapsulate,
    KYBER_SECRET_KEY_SIZE, KYBER_PUBLIC_KEY_SIZE, KYBER_CIPHERTEXT_SIZE,
};
use super::CryptoError;

/// Константа: размер X25519 публичного ключа
pub const X25519_PUBLIC_KEY_SIZE: usize = 32;

/// Константа: размер X25519 секретного ключа
pub const X25519_SECRET_KEY_SIZE: usize = 32;

/// Константа: размер X25519 шифротекста
pub const X25519_CIPHERTEXT_SIZE: usize = 32;

/// Константа: размер гибридного общего секрета
pub const HYBRID_SHARED_SECRET_SIZE: usize = 32;

/// Структура гибридного обмена ключами
#[derive(Debug, Clone)]
pub struct HybridKeyExchange {
    /// Kyber ключевая пара
    pub kyber_public_key: Vec<u8>,
    /// X25519 публичный ключ (для отправки)
    pub x25519_public: Vec<u8>,
}

/// Результат гибридной инкапсуляции
#[derive(Debug, Clone)]
pub struct HybridEncapsulation {
    /// X25519 шифротекст (ephemeral public key)
    pub x25519_ciphertext: Vec<u8>,
    /// Kyber шифротекст
    pub kyber_ciphertext: Vec<u8>,
    /// Гибридный общий секрет
    pub hybrid_secret: Vec<u8>,
}

/// Генерирует гибридную ключевую пару (X25519 + Kyber-1024)
pub fn generate_hybrid_keypair() -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), CryptoError> {
    // Генерируем Kyber ключевую пару
    let kyber_kp = generate_kyber_keypair()?;

    // Генерируем X25519 ключевую пару
    let mut csprng = OsRng;
    let x25519_secret = StaticSecret::random_from_rng(&mut csprng);
    let x25519_public = PublicKey::from(&x25519_secret);

    Ok((
        x25519_secret.to_bytes().to_vec(),
        x25519_public.to_bytes().to_vec(),
        kyber_kp.public_key,
    ))
}

/// Инкапсулирует гибридный общий секрет
///
/// Объединяет X25519 и Kyber инкапсуляцию, затем выводит
/// единый общий секрет через HKDF-SHA256.
pub fn hybrid_encapsulate(
    x25519_public_key: &[u8],
    kyber_public_key: &[u8],
) -> Result<HybridEncapsulation, CryptoError> {
    // Валидация длин ключей
    if x25519_public_key.len() != X25519_PUBLIC_KEY_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер X25519 публичного ключа: ожидался {}, получен {}",
            X25519_PUBLIC_KEY_SIZE,
            x25519_public_key.len()
        )));
    }

    if kyber_public_key.len() != KYBER_PUBLIC_KEY_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер Kyber публичного ключа: ожидался {}, получен {}",
            KYBER_PUBLIC_KEY_SIZE,
            kyber_public_key.len()
        )));
    }

    // X25519 инкапсуляция
    let mut x25519_pk_bytes = [0u8; 32];
    x25519_pk_bytes.copy_from_slice(x25519_public_key);
    let recipient_x25519 = PublicKey::from(x25519_pk_bytes);

    let mut csprng = OsRng;
    let ephemeral_secret = EphemeralSecret::random_from_rng(&mut csprng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let x25519_shared = ephemeral_secret.diffie_hellman(&recipient_x25519);

    // Kyber инкапсуляция
    let (kyber_ct, kyber_shared) = kyber_encapsulate(kyber_public_key)?;

    // HKDF для объединения секретов
    let mut kyber_shared_arr = [0u8; 32];
    kyber_shared_arr.copy_from_slice(&kyber_shared);
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(x25519_shared.as_bytes());
    ikm.extend_from_slice(&kyber_shared_arr);

    let hk = Hkdf::<Sha256>::new(None, &ikm);
    let mut hybrid_secret = [0u8; HYBRID_SHARED_SECRET_SIZE];
    hk.expand(b"vault-hybrid-x25519-kyber1024", &mut hybrid_secret)
        .map_err(|e| CryptoError::from(format!("HKDF ошибка: {}", e)))?;

    Ok(HybridEncapsulation {
        x25519_ciphertext: ephemeral_public.to_bytes().to_vec(),
        kyber_ciphertext: kyber_ct,
        hybrid_secret: hybrid_secret.to_vec(),
    })
}

/// Деинкапсулирует гибридный общий секрет
pub fn hybrid_decapsulate(
    x25519_secret_key: &[u8],
    kyber_secret_key: &[u8],
    x25519_ciphertext: &[u8],
    kyber_ciphertext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    // Валидация длин
    if x25519_secret_key.len() != X25519_SECRET_KEY_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер X25519 секретного ключа: ожидался {}, получен {}",
            X25519_SECRET_KEY_SIZE,
            x25519_secret_key.len()
        )));
    }

    if kyber_secret_key.len() != KYBER_SECRET_KEY_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер Kyber секретного ключа: ожидался {}, получен {}",
            KYBER_SECRET_KEY_SIZE,
            kyber_secret_key.len()
        )));
    }

    if x25519_ciphertext.len() != X25519_CIPHERTEXT_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер X25519 шифротекста: ожидался {}, получен {}",
            X25519_CIPHERTEXT_SIZE,
            x25519_ciphertext.len()
        )));
    }

    if kyber_ciphertext.len() != KYBER_CIPHERTEXT_SIZE {
        return Err(CryptoError::from(format!(
            "Неверный размер Kyber шифротекста: ожидался {}, получен {}",
            KYBER_CIPHERTEXT_SIZE,
            kyber_ciphertext.len()
        )));
    }

    // X25519 деинкапсуляция
    let mut sk_bytes = [0u8; 32];
    sk_bytes.copy_from_slice(x25519_secret_key);
    let secret = StaticSecret::from(sk_bytes);

    let mut ct_bytes = [0u8; 32];
    ct_bytes.copy_from_slice(x25519_ciphertext);
    let ephemeral = PublicKey::from(ct_bytes);

    let x25519_shared = secret.diffie_hellman(&ephemeral);

    // Kyber деинкапсуляция
    let kyber_shared = kyber_decapsulate(kyber_secret_key, kyber_ciphertext)?;

    // HKDF для объединения секретов
    let mut kyber_shared_arr = [0u8; 32];
    kyber_shared_arr.copy_from_slice(&kyber_shared);
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(x25519_shared.as_bytes());
    ikm.extend_from_slice(&kyber_shared_arr);

    let hk = Hkdf::<Sha256>::new(None, &ikm);
    let mut hybrid_secret = [0u8; HYBRID_SHARED_SECRET_SIZE];
    hk.expand(b"vault-hybrid-x25519-kyber1024", &mut hybrid_secret)
        .map_err(|e| CryptoError::from(format!("HKDF ошибка: {}", e)))?;

    Ok(hybrid_secret.to_vec())
}

/// Кодирует X25519 публичный ключ в Base64
pub fn x25519_public_key_to_base64(key: &[u8]) -> String {
    BASE64.encode(key)
}

/// Декодирует X25519 публичный ключ из Base64
pub fn x25519_public_key_from_base64(encoded: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64
        .decode(encoded)
        .map_err(|e| CryptoError::from(format!("Неверный Base64 X25519 публичного ключа: {}", e)))
}

/// Кодирует X25519 секретный ключ в Base64
pub fn x25519_secret_key_to_base64(key: &[u8]) -> String {
    BASE64.encode(key)
}

/// Декодирует X25519 секретный ключ из Base64
pub fn x25519_secret_key_from_base64(encoded: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64
        .decode(encoded)
        .map_err(|e| CryptoError::from(format!("Неверный Base64 X25519 секретного ключа: {}", e)))
}

/// Кодирует гибридный шифротекст в Base64
pub fn hybrid_ciphertext_to_base64(ct: &[u8]) -> String {
    BASE64.encode(ct)
}

/// Декодирует гибридный шифротекст из Base64
pub fn hybrid_ciphertext_from_base64(encoded: &str) -> Result<Vec<u8>, CryptoError> {
    BASE64
        .decode(encoded)
        .map_err(|e| CryptoError::from(format!("Неверный Base64 гибридного шифротекста: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hybrid_key_generation() {
        let (x25519_secret, x25519_public, kyber_pk) = generate_hybrid_keypair().unwrap();
        assert_eq!(x25519_secret.len(), X25519_SECRET_KEY_SIZE);
        assert_eq!(x25519_public.len(), X25519_PUBLIC_KEY_SIZE);
        assert_eq!(kyber_pk.len(), KYBER_PUBLIC_KEY_SIZE);
    }

    #[test]
    fn test_hybrid_encapsulate_decapsulate() {
        let (x25519_secret, x25519_public, kyber_pk) = generate_hybrid_keypair().unwrap();

        // Генерируем Kyber ключевую пару для деинкапсуляции
        let kyber_kp = generate_kyber_keypair().unwrap();

        let enc = hybrid_encapsulate(&x25519_public, &kyber_kp.public_key).unwrap();
        let secret = hybrid_decapsulate(
            &x25519_secret,
            &kyber_kp.secret_key,
            &enc.x25519_ciphertext,
            &enc.kyber_ciphertext,
        ).unwrap();

        assert_eq!(enc.hybrid_secret, secret);
    }

    #[test]
    fn test_hybrid_invalid_x25519_key_length() {
        let invalid_key = vec![0u8; 100];
        let kyber_pk = generate_kyber_keypair().unwrap().public_key;
        assert!(hybrid_encapsulate(&invalid_key, &kyber_pk).is_err());
    }

    #[test]
    fn test_hybrid_invalid_kyber_key_length() {
        let mut csprng = OsRng;
        let secret = StaticSecret::random_from_rng(&mut csprng);
        let public = PublicKey::from(&secret);
        let invalid_kyber_pk = vec![0u8; 100];
        assert!(hybrid_encapsulate(&public.to_bytes(), &invalid_kyber_pk).is_err());
    }

    #[test]
    fn test_hybrid_base64_encoding() {
        let ct = vec![0u8; 64];
        let ct_b64 = hybrid_ciphertext_to_base64(&ct);
        let ct_decoded = hybrid_ciphertext_from_base64(&ct_b64).unwrap();
        assert_eq!(ct, ct_decoded);

        let pk = vec![0u8; 32];
        let pk_b64 = x25519_public_key_to_base64(&pk);
        let pk_decoded = x25519_public_key_from_base64(&pk_b64).unwrap();
        assert_eq!(pk, pk_decoded);
    }
}
