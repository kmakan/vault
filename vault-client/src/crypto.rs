pub mod encryptor;
pub mod pq;

pub use encryptor::{DecryptedContent, Encryptor};

/// Decryptor is an alias for Encryptor (it has both encrypt and decrypt methods)
pub type Decryptor = Encryptor;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::rngs::OsRng;
use x25519_dalek::{PublicKey, SharedSecret, StaticSecret};

pub const NONCE_LEN: usize = 24;

/// Очистить тело письма перед Base64-декодом конверта.
///
/// Почтовые транспорты (mail.ru, yandex) иногда оборачивают Base64-конверт
/// в quoted-printable кодирование: символ `=` (Base64 padding) превращается
/// в `=3D`, а `=` в других позициях — в `=XX`. Без раскодирования длина
/// «компактной» строки перестаёт быть кратной 4, decode падает, и
/// `is_encrypted()` возвращает false — письмо тихо выбрасывается как
/// «не зашифрованное».
///
/// Здесь выполняется проход QP-декодера: `=XX` раскодируется в
/// соответствующий байт (символы за пределами base64 просто выбрасываются
/// — транспорт также может вставлять `=\r\n` soft line breaks).
fn clean_base64_body(text: &str) -> String {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    // Быстрый путь: ни одного QP-escape — ничего раскодировать не нужно.
    if !compact.contains('=') {
        return compact;
    }

    let bytes = compact.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            // soft line break, который QP-транспорт оставил после очистки
            // пробелов: валидируем как base64-безопасный — пропускаем.
            b'=' if i + 2 < bytes.len()
                && bytes[i + 1].is_ascii_hexdigit()
                && bytes[i + 2].is_ascii_hexdigit() =>
            {
                let hi = (bytes[i + 1] as char).to_digit(16).unwrap();
                let lo = (bytes[i + 2] as char).to_digit(16).unwrap();
                let b = ((hi << 4) | lo) as u8;
                out.push(b);
                i += 3;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }

    // Декодер мог вернуть хвост, некратный 4 (оторванный padding).
    // Base64-провайдер ругается на такую длину — восстанавливаем padding
    // по кратности: дописываем `=` до кратного 4 размера.
    while out.len() % 4 != 0 {
        out.push(b'=');
    }

    match String::from_utf8(out) {
        Ok(s) => s,
        // Невозможно в теории: все исходные символы были ASCII.
        Err(_) => compact,
    }
}

pub struct CryptoClient {
    private_key: Option<StaticSecret>,
    public_key: Option<PublicKey>,
    shared_secret: Option<SharedSecret>,
    /// PQ: ML-KEM-768 seed (hex, приватный) и ek (b64, публичный).
    /// None — аккаунт до PQ-миграции (legacy X25519).
    pub pq_seed_hex: Option<String>,
    pub pq_ek_b64: Option<String>,
    /// PQ-ключ контакта (ek b64). None — контакт без PQ.
    pub peer_pq_ek_b64: Option<String>,
    /// X25519 pubkey последнего пира (для hybrid_encrypt_vault).
    last_peer_pub_hex: Option<String>,
}

impl CryptoClient {
    pub fn new() -> Self {
        Self {
            private_key: None,
            public_key: None,
            shared_secret: None,
            pq_seed_hex: None,
            pq_ek_b64: None,
            peer_pq_ek_b64: None,
            last_peer_pub_hex: None,
        }
    }

    /// Generate a new X25519 key pair
    pub fn generate_keypair(&mut self) -> (String, String) {
        let private = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&private);

        // PQ: ML-KEM-768 пара вместе с X25519.
        let pq = pq::pq_generate();
        self.pq_seed_hex = Some(pq.seed_hex);
        self.pq_ek_b64 = Some(pq.ek_b64);

        let pub_hex = hex::encode(public.as_bytes());
        let priv_hex = hex::encode(private.to_bytes());

        self.private_key = Some(private);
        self.public_key = Some(public);

        (pub_hex, priv_hex)
    }

    /// Загрузить пару из ~/.vault/keys/keypair.json (формат Desktop
    /// StoredKeyPair: public_key/private_key hex + pq_private_key/pq_public_key).
    /// Возвращает false, если файла нет — вызывающий код решает, звать ли
    /// /keygen. Чужой/битый JSON — тоже false (не фатально: пусть keygen).
    pub fn load_keypair(&mut self) -> bool {
        let path = dirs::home_dir()
            .map(|h| h.join(".vault/keys/keypair.json"))
            .unwrap_or_else(|| std::path::PathBuf::from(".vault/keys/keypair.json"));
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return false;
        };
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return false;
        };
        let Some(priv_hex) = obj.get("private_key").and_then(|v| v.as_str()) else {
            return false;
        };
        if self.import_private_key(priv_hex).is_err() {
            return false;
        }
        // PQ-поля опциональны (старые аккаунты без PQ продолжают работать
        // по чистому X25519 — legacy-путь).
        if let Some(seed_hex) = obj.get("pq_private_key").and_then(|v| v.as_str()) {
            if pq::pq_from_seed(seed_hex).is_some() {
                self.pq_seed_hex = Some(seed_hex.to_string());
                if let Some(ek) = obj.get("pq_public_key").and_then(|v| v.as_str()) {
                    self.pq_ek_b64 = Some(ek.to_string());
                }
            }
        }
        true
    }

    /// Сохранить текущую пару в ~/.vault/keys/keypair.json (формат Desktop).
    /// Вызывается после /keygen, чтобы ключи пережили перезапуск REPL.
    pub fn save_keypair(&self) -> Result<()> {
        let (Some(priv_key), Some(pub_key)) = (&self.private_key, &self.public_key) else {
            return Ok(());
        };
        let dir = dirs::home_dir()
            .map(|h| h.join(".vault/keys"))
            .unwrap_or_else(|| std::path::PathBuf::from(".vault/keys"));
        std::fs::create_dir_all(&dir).context("Failed to create keys dir")?;
        let path = dir.join("keypair.json");
        if path.exists() {
            // Не перезаписывать существующий аккаунтный ключ молча —
            // иначе /keygen в тестовом HOME снесёт ключ, которым уже
            // зашифрована история. Для смены ключа файл удаляют вручную.
            return Ok(());
        }
        let obj = serde_json::json!({
            "public_key": hex::encode(pub_key.as_bytes()),
            "private_key": hex::encode(priv_key.to_bytes()),
            "created_at": chrono::Utc::now().to_rfc3339(),
            "pq_private_key": self.pq_seed_hex.clone().unwrap_or_default(),
            "pq_public_key": self.pq_ek_b64.clone().unwrap_or_default(),
        });
        std::fs::write(&path, serde_json::to_string_pretty(&obj)?)
            .context("Failed to write keypair.json")?;
        Ok(())
    }

    /// Import a private key from hex
    pub fn import_private_key(&mut self, priv_hex: &str) -> Result<()> {
        let bytes = hex::decode(priv_hex).context("Invalid private key hex")?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
        let private = StaticSecret::from(arr);
        let public = PublicKey::from(&private);

        self.private_key = Some(private);
        self.public_key = Some(public);
        Ok(())
    }

    /// Set a remote peer's public key to derive shared secret
    pub fn set_peer_key(&mut self, peer_pub_hex: &str) -> Result<()> {
        self.set_peer_key_pq(peer_pub_hex, None)
    }

    /// PQ: peer X25519 ключ + опциональный ML-KEM ek контакта.
    pub fn set_peer_key_pq(&mut self, peer_pub_hex: &str, peer_pq_ek: Option<&str>) -> Result<()> {
        let priv_key = self
            .private_key
            .as_ref()
            .context("Generate keys first with /keygen")?;

        let peer_bytes = hex::decode(peer_pub_hex).context("Invalid public key hex")?;
        let peer_pub = PublicKey::from(
            <[u8; 32]>::try_from(peer_bytes.as_slice())
                .map_err(|_| anyhow::anyhow!("Public key must be 32 bytes"))?,
        );

        self.peer_pq_ek_b64 = peer_pq_ek.map(|s| s.to_string());
        self.last_peer_pub_hex = Some(peer_pub_hex.to_string());

        let shared = priv_key.diffie_hellman(&peer_pub);
        self.shared_secret = Some(shared);
        Ok(())
    }

    /// Check if keys are loaded
    pub fn has_keys(&self) -> bool {
        self.private_key.is_some()
    }

    /// Get key fingerprint (first 8 bytes of public key).
    /// Формат строго Desktop (fingerprint_cmd): hex-decode ключа → первые
    /// 8 байт → `xx:xx:…:xx:****`. Релей-сервер привязывает read-токен к fp
    /// издателя/получателя — несовпадение форматов = 403 «token bound to
    /// another account» для одного и того же ключа.
    pub fn fingerprint(&self) -> String {
        match &self.public_key {
            Some(pub_key) => {
                let fp: String = pub_key.as_bytes()[..8]
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(":");
                format!("{}:****", fp)
            }
            None => "no key".to_string(),
        }
    }

    /// Get the public key as hex
    pub fn public_key_hex(&self) -> Option<String> {
        self.public_key
            .as_ref()
            .map(|pk| hex::encode(pk.as_bytes()))
    }

    /// Get the encryption key
    fn get_key(&self) -> Result<[u8; 32]> {
        if let Some(ref shared) = self.shared_secret {
            let mut key = [0u8; 32];
            key.copy_from_slice(shared.as_bytes());
            return Ok(key);
        }

        if let Some(ref pub_key) = self.public_key {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(b"vault-self-encryption-v1");
            hasher.update(pub_key.as_bytes());
            let result = hasher.finalize();
            let mut key = [0u8; 32];
            key.copy_from_slice(&result);
            return Ok(key);
        }

        anyhow::bail!("No keys available. Use /keygen first.")
    }

    /// Encrypt plaintext string → Base64
    pub fn encrypt(&self, plaintext: &str) -> String {
        self.do_encrypt(plaintext.as_bytes())
            .unwrap_or_else(|_| BASE64.encode(plaintext.as_bytes()))
    }

    /// Decrypt Base64 ciphertext → plaintext string.
    /// Whitespace (line breaks from email transport) is ignored — transport
    /// relays may wrap the base64 line, e.g. `\r\n` inside the payload.
    /// Quoted-printable кодирование (`=3D` вместо `=`, которое некоторые
    /// SMTP-транспорты накладывают на тело) раскодируется в
    /// [`clean_base64_body`].
    pub fn decrypt(&self, ciphertext: &str) -> Result<String> {
        let compact = clean_base64_body(ciphertext);
        let decoded = BASE64.decode(compact).context("Invalid Base64")?;
        let plaintext = self.do_decrypt(&decoded)?;
        String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted text")
    }

    /// Encrypt a vault message using AAD marker "VAULT" (no plaintext prefix).
    ///
    /// The marker is passed as Associated Data to XChaCha20-Poly1305 — it is
    /// authenticated by Poly1305 but NOT present in the ciphertext.  On the
    /// wire the format is identical to `encrypt()`: base64(nonce ‖ ciphertext).
    pub fn encrypt_vault(&self, plaintext: &str) -> Result<String> {
        // PQ: при наличии PQ-ключей у обеих сторон — гибридный
        // конверт "PQ1:<kemct>|<sender_ek>|<wire>" (как desktop PQ-3/PQ-4).
        if let (Some(seed), Some(peer_ek)) =
            (self.pq_seed_hex.as_deref(), self.peer_pq_ek_b64.as_deref())
        {
            if let Some(peer_pub_hex) = self.last_peer_pub_hex.as_deref() {
                let priv_hex = self
                    .private_key
                    .as_ref()
                    .map(|k| hex::encode(k.to_bytes()))
                    .context("Generate keys first with /keygen")?;
                let (wire, hdr) = pq::hybrid_encrypt_vault(
                    plaintext,
                    &priv_hex,
                    peer_pub_hex,
                    Some(seed),
                    peer_ek,
                )?;
                let kemct = hdr.kemct.unwrap_or_default();
                let pq_ek_out = hdr.pq.unwrap_or_default();
                return Ok(format!("PQ1:{kemct}|{pq_ek_out}|{wire}"));
            }
        }
        let key = self.get_key()?;
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

        Ok(BASE64.encode(&output))
    }

    /// Decrypt a vault message authenticated with AAD marker "VAULT".
    ///
    /// Returns `Ok(plaintext)` only when Poly1305 authentication with
    /// AAD="VAULT" succeeds.  If the message was NOT encrypted with the vault
    /// AAD (or the key is wrong), returns `Err` — the caller should treat it
    /// as non-vault mail (or try the legacy fallback).
    pub fn decrypt_vault(&self, ciphertext: &str) -> Result<String> {
        // PQ: "PQ1:<kemct>|<sender_ek>|<wire>" — гибрид ML-KEM+X25519.
        let trimmed = ciphertext.trim();
        if let Some(rest) = trimmed.strip_prefix("PQ1:") {
            let parts: Vec<&str> = rest.splitn(3, '|').collect();
            if parts.len() == 3 {
                let (kemct, _sender_ek, wire) = (parts[0], parts[1], parts[2]);
                let seed = self.pq_seed_hex.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("PQ message but no PQ seed — run /keygen on this account")
                })?;
                let peer_pub = self.last_peer_pub_hex.as_deref().ok_or_else(|| {
                    anyhow::anyhow!("PQ message but peer key not set — /add or /accept first")
                })?;
                let priv_hex = self
                    .private_key
                    .as_ref()
                    .map(|k| hex::encode(k.to_bytes()))
                    .context("Generate keys first with /keygen")?;
                return pq::hybrid_decrypt_vault(wire, &priv_hex, peer_pub, seed, kemct)
                    .map_err(|e| anyhow::anyhow!("PQ decrypt failed: {e}"));
            }
        }

        let compact = clean_base64_body(ciphertext);
        let decoded = BASE64.decode(compact).context("Invalid Base64")?;

        let key = self.get_key()?;

        if decoded.len() < NONCE_LEN {
            anyhow::bail!("Encrypted data too short");
        }

        let (nonce_bytes, ct_bytes) = decoded.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce = XNonce::from_slice(nonce_bytes);

        let payload = Payload {
            msg: ct_bytes,
            aad: b"VAULT",
        };
        let plaintext = cipher
            .decrypt(nonce, payload)
            .map_err(|_| anyhow::anyhow!("Not a vault message (AAD auth failed) or wrong key"))?;

        String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted vault text")
    }

    /// Check if text looks like encrypted data
    pub fn is_encrypted(&self, text: &str) -> bool {
        let compact = clean_base64_body(text);
        if let Ok(decoded) = BASE64.decode(compact) {
            decoded.len() >= NONCE_LEN + 17 && self.has_keys()
        } else {
            false
        }
    }

    /// Encrypt binary data → Vec<u8> (raw bytes, not Base64)
    pub fn encrypt_binary(&self, data: &[u8]) -> Vec<u8> {
        self.do_encrypt_bytes(data)
            .unwrap_or_else(|_| data.to_vec())
    }

    /// Decrypt binary data → Vec<u8>
    pub fn decrypt_binary(&self, data: &[u8]) -> Result<Vec<u8>> {
        self.do_decrypt(data)
    }

    fn do_encrypt_bytes(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let key = self.get_key()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn do_encrypt(&self, plaintext: &[u8]) -> Result<String> {
        let key = self.get_key()?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&output))
    }

    fn do_decrypt(&self, encrypted: &[u8]) -> Result<Vec<u8>> {
        let key = self.get_key()?;

        if encrypted.len() < NONCE_LEN {
            anyhow::bail!("Encrypted data too short");
        }

        let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new((&key).into());
        let nonce = XNonce::from_slice(nonce_bytes);

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| anyhow::anyhow!("Decryption failed (wrong key or corrupted data)"))
    }
}

impl Default for CryptoClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        let text = "Hello, Vault! Привет, мир!";
        let encrypted = crypto.encrypt(text);
        assert_ne!(encrypted, text);

        let decrypted = crypto.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, text);
    }

    #[test]
    fn test_binary_encrypt_decrypt() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        let data: Vec<u8> = (0..=255).cycle().take(1024).collect();
        let encrypted = crypto.encrypt_binary(&data);
        assert_ne!(encrypted, data);

        let decrypted = crypto.decrypt_binary(&encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn test_key_fingerprint() {
        let mut crypto = CryptoClient::new();
        assert_eq!(crypto.fingerprint(), "no key");

        crypto.generate_keypair();
        let fp = crypto.fingerprint();
        assert!(fp.contains(':'));
        assert!(fp.contains("****"));
    }

    #[test]
    fn test_is_encrypted() {
        let mut crypto = CryptoClient::new();
        assert!(!crypto.is_encrypted("hello"));

        crypto.generate_keypair();
        let encrypted = crypto.encrypt("hello");
        assert!(crypto.is_encrypted(&encrypted));
    }

    #[test]
    fn test_import_export_key() {
        let mut crypto1 = CryptoClient::new();
        let (_, priv_hex) = crypto1.generate_keypair();

        let mut crypto2 = CryptoClient::new();
        crypto2.import_private_key(&priv_hex).unwrap();
        assert!(crypto2.has_keys());
        assert_eq!(crypto1.fingerprint(), crypto2.fingerprint());
    }

    #[test]
    fn test_vault_aad_encrypt_decrypt_roundtrip() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        let text = "Hello, Vault! Привет, мир!";
        let encrypted = crypto.encrypt_vault(text).unwrap();
        assert_ne!(encrypted, text);

        // decrypt_vault with the same key should succeed and return clean text
        let decrypted = crypto.decrypt_vault(&encrypted).unwrap();
        assert_eq!(decrypted, text);
        // No VAULT1: prefix — the text is pure
        assert!(!decrypted.starts_with("VAULT1:"));
    }

    #[test]
    fn test_vault_aad_rejects_non_vault_data() {
        let mut crypto = CryptoClient::new();
        crypto.generate_keypair();

        // Data encrypted WITHOUT AAD (old encrypt, no vault marker)
        let non_vault = crypto.encrypt("hello");
        // decrypt_vault must reject it
        let result = crypto.decrypt_vault(&non_vault);
        assert!(result.is_err(), "non-vault ciphertext must fail AAD auth");

        // Data encrypted with AAD=Vault... but decrypted with WRONG key
        let vault_enc = crypto.encrypt_vault("secret").unwrap();

        let mut other = CryptoClient::new();
        other.generate_keypair();
        let result = other.decrypt_vault(&vault_enc);
        assert!(result.is_err(), "wrong key must fail AAD auth");
    }
}
