use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use x25519_dalek::{PublicKey, StaticSecret};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use base64::Engine as _;

const NONCE_LEN: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPair {
    pub public_key: String,
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoState {
    pub private_key: Option<String>,
    pub public_key: Option<String>,
    pub peer_public_key: Option<String>,
}

impl Default for CryptoState {
    fn default() -> Self {
        Self {
            private_key: None,
            public_key: None,
            peer_public_key: None,
        }
    }
}

fn derive_key(public_key: &PublicKey) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"vault-self-encryption-v1");
    hasher.update(public_key.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

#[allow(dead_code)]
fn derive_shared_key(private_hex: &str, peer_hex: &str) -> anyhow::Result<[u8; 32]> {
    let priv_bytes = hex::decode(private_hex)
        .map_err(|e| anyhow::anyhow!("Invalid private key hex: {}", e))?;
    let priv_arr: [u8; 32] = priv_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);

    let peer_bytes = hex::decode(peer_hex)
        .map_err(|e| anyhow::anyhow!("Invalid peer key hex: {}", e))?;
    let peer_arr: [u8; 32] = peer_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
    let peer = PublicKey::from(peer_arr);

    let shared = private.diffie_hellman(&peer);
    Ok(*shared.as_bytes())
}

pub fn generate_keypair_cmd() -> KeyPair {
    let private = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&private);

    KeyPair {
        public_key: hex::encode(public.as_bytes()),
        private_key: hex::encode(private.to_bytes()),
    }
}

pub fn encrypt_cmd(
    plaintext: &str,
    private_key: &str,
    peer_public_key: Option<&str>,
) -> anyhow::Result<String> {
    let priv_bytes = hex::decode(private_key)
        .map_err(|e| anyhow::anyhow!("Invalid private key: {}", e))?;
    let priv_arr: [u8; 32] = priv_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);
    let public = PublicKey::from(&private);

    let key = match peer_public_key {
        Some(peer_hex) => {
            let peer_bytes = hex::decode(peer_hex)
                .map_err(|e| anyhow::anyhow!("Invalid peer key: {}", e))?;
            let peer_arr: [u8; 32] = peer_bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
            let peer = PublicKey::from(peer_arr);
            let shared = private.diffie_hellman(&peer);
            *shared.as_bytes()
        }
        None => derive_key(&public),
    };

    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

    let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    Ok(base64::engine::general_purpose::STANDARD.encode(&output))
}

pub fn decrypt_cmd(
    ciphertext: &str,
    private_key: &str,
    peer_public_key: Option<&str>,
) -> anyhow::Result<String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|e| anyhow::anyhow!("Invalid base64: {}", e))?;

    if decoded.len() < NONCE_LEN {
        anyhow::bail!("Ciphertext too short");
    }

    let priv_bytes = hex::decode(private_key)
        .map_err(|e| anyhow::anyhow!("Invalid private key: {}", e))?;
    let priv_arr: [u8; 32] = priv_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);
    let public = PublicKey::from(&private);

    let key = match peer_public_key {
        Some(peer_hex) => {
            let peer_bytes = hex::decode(peer_hex)
                .map_err(|e| anyhow::anyhow!("Invalid peer key: {}", e))?;
            let peer_arr: [u8; 32] = peer_bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
            let peer = PublicKey::from(peer_arr);
            let shared = private.diffie_hellman(&peer);
            *shared.as_bytes()
        }
        None => derive_key(&public),
    };

    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce = XNonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext_bytes)
        .map_err(|_| anyhow::anyhow!("Decryption failed (wrong key or corrupted data)"))?;

    String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {}", e))
}

/// Encrypt a vault message using AAD marker "VAULT" (no plaintext prefix).
///
/// Same key derivation as `encrypt_cmd` (DH with peer key, or self-derivation),
/// but the message is authenticated by XChaCha20-Poly1305 with AAD="VAULT".
/// On the wire the format is identical: base64(nonce ‖ ciphertext).
pub fn encrypt_vault_cmd(
    plaintext: &str,
    private_key: &str,
    peer_public_key: Option<&str>,
) -> anyhow::Result<String> {
    use chacha20poly1305::aead::Payload;

    let priv_bytes = hex::decode(private_key)
        .map_err(|e| anyhow::anyhow!("Invalid private key: {}", e))?;
    let priv_arr: [u8; 32] = priv_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);
    let public = PublicKey::from(&private);

    let key = match peer_public_key {
        Some(peer_hex) => {
            let peer_bytes = hex::decode(peer_hex)
                .map_err(|e| anyhow::anyhow!("Invalid peer key: {}", e))?;
            let peer_arr: [u8; 32] = peer_bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
            let peer = PublicKey::from(peer_arr);
            let shared = private.diffie_hellman(&peer);
            *shared.as_bytes()
        }
        None => derive_key(&public),
    };

    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = XNonce::from_slice(&nonce_bytes);

    let payload = Payload {
        msg: plaintext.as_bytes(),
        aad: b"VAULT",
    };
    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| anyhow::anyhow!("Vault encryption failed: {}", e))?;

    let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    Ok(base64::engine::general_purpose::STANDARD.encode(&output))
}

/// Decrypt a vault message authenticated with AAD marker "VAULT".
///
/// Returns `Ok(plaintext)` only when Poly1305 authentication with AAD="VAULT"
/// succeeds.  If the message was NOT encrypted with the vault AAD (or the key
/// is wrong), returns `Err` — the caller should treat it as non-vault mail.
pub fn decrypt_vault_cmd(
    ciphertext: &str,
    private_key: &str,
    peer_public_key: Option<&str>,
) -> anyhow::Result<String> {
    use chacha20poly1305::aead::Payload;

    // SMTP-переносы (fold ≤76 колонок) оставляют в теле \n — base64-декодер
    // должен их игнорировать, иначе НИ ОДНО входящее письмо не расшифруется.
    let cleaned: String = ciphertext
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| anyhow::anyhow!("Invalid base64: {}", e))?;

    if decoded.len() < NONCE_LEN {
        anyhow::bail!("Ciphertext too short");
    }

    let priv_bytes = hex::decode(private_key)
        .map_err(|e| anyhow::anyhow!("Invalid private key: {}", e))?;
    let priv_arr: [u8; 32] = priv_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);
    let public = PublicKey::from(&private);

    let key = match peer_public_key {
        Some(peer_hex) => {
            let peer_bytes = hex::decode(peer_hex)
                .map_err(|e| anyhow::anyhow!("Invalid peer key: {}", e))?;
            let peer_arr: [u8; 32] = peer_bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
            let peer = PublicKey::from(peer_arr);
            let shared = private.diffie_hellman(&peer);
            *shared.as_bytes()
        }
        None => derive_key(&public),
    };

    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce = XNonce::from_slice(nonce_bytes);

    let payload = Payload {
        msg: ciphertext_bytes,
        aad: b"VAULT",
    };
    let plaintext = cipher
        .decrypt(nonce, payload)
        .map_err(|_| anyhow::anyhow!("Not a vault message (AAD auth failed) or wrong key"))?;

    String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {}", e))
}

pub fn fingerprint_cmd(public_key_hex: &str) -> anyhow::Result<String> {
    let bytes = hex::decode(public_key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid public key hex: {}", e))?;
    if bytes.len() != 32 {
        anyhow::bail!("Public key must be 32 bytes");
    }
    let fp: String = bytes[..8]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(":");
    Ok(format!("{}:****", fp))
}

/// Symmetric encrypt with a raw 32-byte hex key (for group shared keys)
pub fn encrypt_symmetric_cmd(plaintext: &str, key_hex: &str) -> anyhow::Result<String> {
    let key_bytes = hex::decode(key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid key hex: {}", e))?;
    if key_bytes.len() != 32 {
        anyhow::bail!("Group key must be 32 bytes");
    }
    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(&key_bytes);

    let cipher = XChaCha20Poly1305::new((&key_arr).into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = XNonce::from_slice(&nonce_bytes);

    use chacha20poly1305::aead::Payload;
    // Стелс-метка: аутентифицируем групповые письма AAD="VAULT" — тот же
    // маркер, что у 1-на-1 (encrypt_vault_cmd). Раньше групповые письма шли
    // БЕЗ AAD и определялись только по видимой теме `VaultGroup: <id>` —
    // не стелс и не надёжно. С меткой приём проверяет «это письмо Vault»
    // криптографически (Poly1305), как и в 1-на-1.
    let payload = Payload {
        msg: plaintext.as_bytes(),
        aad: b"VAULT",
    };
    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

    let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    Ok(base64::engine::general_purpose::STANDARD.encode(&output))
}

/// Symmetric decrypt with a raw 32-byte hex key (for group shared keys)
pub fn decrypt_symmetric_cmd(ciphertext: &str, key_hex: &str) -> anyhow::Result<String> {
    // Групповые сообщения идут через SMTP: отправка фолдит base64 строками ≤76
    // (спам-фильтр), и письмо приходит с '\n' внутри. Строгий base64-декодер
    // падает на переносах → сообщение не расшифровывается. Игнорируем все
    // пробельные символы (тот же фикс, что в decrypt_vault_cmd).
    let cleaned: String = ciphertext
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| anyhow::anyhow!("Invalid base64: {}", e))?;

    if decoded.len() < NONCE_LEN {
        anyhow::bail!("Ciphertext too short");
    }

    let key_bytes = hex::decode(key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid key hex: {}", e))?;
    if key_bytes.len() != 32 {
        anyhow::bail!("Group key must be 32 bytes");
    }
    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(&key_bytes);

    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new((&key_arr).into());
    let nonce = XNonce::from_slice(nonce_bytes);

    use chacha20poly1305::aead::Payload;
    // Сначала пробуем формат со стелс-меткой (AAD="VAULT", текущий); при
    // неудаче — legacy-формат БЕЗ AAD, чтобы групповые письма, зашифрованные
    // до введения метки, продолжали расшифровываться.
    let plaintext = match cipher.decrypt(nonce, Payload { msg: ciphertext_bytes, aad: b"VAULT" }) {
        Ok(pt) => pt,
        Err(_) => cipher
            .decrypt(nonce, ciphertext_bytes)
            .map_err(|_| anyhow::anyhow!("Decryption failed (wrong key or corrupted data)"))?,
    };

    String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keygen_and_encrypt_decrypt() {
        let kp = generate_keypair_cmd();
        let plaintext = "Hello, Vault!";
        let encrypted = encrypt_cmd(plaintext, &kp.private_key, None).unwrap();
        assert_ne!(encrypted, plaintext);
        let decrypted = decrypt_cmd(&encrypted, &kp.private_key, None).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_shared_secret_encryption() {
        let alice = generate_keypair_cmd();
        let bob = generate_keypair_cmd();

        let encrypted = encrypt_cmd("secret", &alice.private_key, Some(&bob.public_key)).unwrap();
        let decrypted = decrypt_cmd(&encrypted, &bob.private_key, Some(&alice.public_key)).unwrap();
        assert_eq!(decrypted, "secret");
    }

    #[test]
    fn test_wrong_key_fails() {
        let alice = generate_keypair_cmd();
        let bob = generate_keypair_cmd();
        let eve = generate_keypair_cmd();

        let encrypted = encrypt_cmd("secret", &alice.private_key, Some(&bob.public_key)).unwrap();
        let result = decrypt_cmd(&encrypted, &eve.private_key, Some(&alice.public_key));
        assert!(result.is_err());
    }

    #[test]
    fn test_fingerprint() {
        let kp = generate_keypair_cmd();
        let fp = fingerprint_cmd(&kp.public_key).unwrap();
        assert!(fp.contains(':'));
        assert!(fp.contains("****"));
    }

    #[test]
    fn test_symmetric_encrypt_decrypt() {
        let key = hex::encode([42u8; 32]);
        let plaintext = "group secret message";
        let encrypted = encrypt_symmetric_cmd(plaintext, &key).unwrap();
        assert_ne!(encrypted, plaintext);
        let decrypted = decrypt_symmetric_cmd(&encrypted, &key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_symmetric_wrong_key_fails() {
        let key1 = hex::encode([1u8; 32]);
        let key2 = hex::encode([2u8; 32]);
        let encrypted = encrypt_symmetric_cmd("secret", &key1).unwrap();
        let result = decrypt_symmetric_cmd(&encrypted, &key2);
        assert!(result.is_err());
    }

    #[test]
    fn test_symmetric_vault_aad_roundtrip() {
        // Новый формат несёт стелс-метку AAD="VAULT" и расшифровывается ею.
        let key = hex::encode([7u8; 32]);
        let encrypted = encrypt_symmetric_cmd("group stealth msg", &key).unwrap();
        let decrypted = decrypt_symmetric_cmd(&encrypted, &key).unwrap();
        assert_eq!(decrypted, "group stealth msg");
    }

    #[test]
    fn test_symmetric_legacy_no_aad_still_decrypts() {
        // Legacy-письмо (до метки, без AAD) должно читаться через фолбэк.
        use chacha20poly1305::aead::Aead;
        let key_arr = [9u8; 32];
        let key = hex::encode(key_arr);
        let cipher = XChaCha20Poly1305::new((&key_arr).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, b"legacy group msg" as &[u8])
            .unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        let legacy_b64 = base64::engine::general_purpose::STANDARD.encode(&out);
        let decrypted = decrypt_symmetric_cmd(&legacy_b64, &key).unwrap();
        assert_eq!(decrypted, "legacy group msg");
    }
}
