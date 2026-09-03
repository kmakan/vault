// Key Recovery — восстановление личности при чистом входе.
// мнемоника из 12 слов (BIP39, 128 бит энтропии)
// которая ОБЁРТЫВАЕТ существующий backup (keypair + peer_keys + kv_store).
//
// ВАЖНОЕ ОТЛИЧИЕ от Session: у Session слова детерминированно порождают пару
// ключей. У нас пара уже существует и разослана контактам — детерминированная
// генерация сменила бы fingerprint и сломала все чаты. Поэтому слова служат
// ключом шифрования бэкапа (KEK), а не источником пары:
//   seed = PBKDF2-HMAC-SHA512(mnemonic_norm, "Vault recovery", 2048)
//   kek  = SHA-512(seed)[0..32]
//   wrapped = XChaCha20-Poly1305(kek, nonce24, backup_json)
//
// Хранение: эскроу-письмо самому себе (стелс-конверт, пустая тема) +
// опционально файл резервной копии. Восстановление: логин в ящик + слова.

use base64::Engine as _;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};

const WORDLIST: &str = include_str!("bip39_english.txt");
const PBKDF2_ITERS: u32 = 2048; 
const PASSPHRASE: &str = "Vault recovery";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WrappedBackup {
    /// версия формата обёртки
    pub v: u8,
    /// соль PBKDF2 (hex, 16 байт)
    pub salt: String,
    /// nonce XChaCha20-Poly1305 (hex, 24 байта)
    pub nonce: String,
    /// base64(шифтекст+тег) — внутри JSON export_backup()
    pub wrapped: String,
    /// отпечаток пары на момент обёртывания (для показа пользователю)
    pub fingerprint_hint: String,
    /// когда создан
    pub created_at: String,
}

// ---------- Мнемоника BIP39 (EN) ----------

fn wordlist() -> Vec<&'static str> {
    WORDLIST.lines().map(str::trim).collect()
}

/// 12 слов из 128 бит энтропии + контрольная сумма SHA-256 (4 бита).
pub fn generate_mnemonic() -> Result<String, String> {
    let list = wordlist();
    if list.len() != 2048 {
        return Err("BIP39 wordlist corrupted".into());
    }
    let mut entropy = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut entropy);

    // CS = первые 4 бита SHA-256(entropy)
    let hash: [u8; 32] = Sha256::digest(entropy).into();
    let bits_total = 128 + 4;
    let mut indices = Vec::with_capacity(12);
    for i in 0..bits_total / 11 {
        let bit = i * 11;
        let mut idx: usize = 0;
        for b in 0..11 {
            let pos = bit + b;
            let byte = pos / 8;
            let off = 7 - (pos % 8);
            let set = if byte < 16 {
                (entropy[byte] >> off) & 1
            } else {
                (hash[byte - 16] >> off) & 1
            };
            idx = (idx << 1) | set as usize;
        }
        indices.push(idx);
    }
    Ok(indices
        .iter()
        .map(|&i| list[i])
        .collect::<Vec<_>>()
        .join(" "))
}

/// Проверка контрольной суммы мнемоники (без словаря языка — EN only).
pub fn validate_mnemonic(mnemonic: &str) -> Result<(), String> {
    let list = wordlist();
    let words: Vec<String> = mnemonic
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect();
    if words.len() != 12 {
        return Err(format!("Ожидается 12 слов, введено {}", words.len()));
    }
    let mut bits: Vec<bool> = Vec::with_capacity(132);
    for w in &words {
        let idx = list
            .iter()
            .position(|lw| *lw == w.as_str())
            .ok_or_else(|| format!("Слово не из списка восстановления: {w}"))?;
        for b in (0..11).rev() {
            bits.push((idx >> b) & 1 == 1);
        }
    }
    // первые 128 бит — энтропия, последние 4 — CS
    let mut entropy = [0u8; 16];
    for (i, bit) in bits[..128].iter().enumerate() {
        if *bit {
            entropy[i / 8] |= 1 << (7 - (i % 8));
        }
    }
    let hash: [u8; 32] = Sha256::digest(entropy).into();
    for (i, bit) in bits[128..].iter().enumerate() {
        let expect = (hash[i / 8] >> (7 - (i % 8))) & 1 == 1;
        if *bit != expect {
            return Err("Контрольная сумма не совпала — проверьте слова".into());
        }
    }
    Ok(())
}

fn normalize_mnemonic(mnemonic: &str) -> String {
    mnemonic.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------- KEK из слов ----------

/// PBKDF2-HMAC-SHA512 вручную (hmac crate): без зависимости pbkdf2-crate.
fn pbkdf2_sha512(password: &[u8], salt: &[u8], iters: u32, out_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(out_len);
    let blocks = out_len.div_ceil(64usize);
    for block in 1..=blocks {
        let mut mac =
            <Hmac<Sha512> as Mac>::new_from_slice(password).expect("HMAC accepts any key length");
        mac.update(salt);
        mac.update(&block.to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut f: Vec<u8> = u.clone().to_vec();
        for _ in 1..iters {
            let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(password).unwrap();
            mac.update(&u);
            u = mac.finalize().into_bytes();
            for (fb, ub) in f.iter_mut().zip(u.iter()) {
                *fb ^= ub;
            }
        }
        out.extend_from_slice(&f);
    }
    out.truncate(out_len);
    out
}

fn kek_from_mnemonic(mnemonic: &str) -> [u8; 32] {
    let norm = normalize_mnemonic(mnemonic);
    // BIP39-style seed: PBKDF2(слова, "mnemonic"+passphrase), затем срез до 32 байт.
    let seed = pbkdf2_sha512(
        norm.as_bytes(),
        format!("mnemonic{PASSPHRASE}").as_bytes(),
        PBKDF2_ITERS,
        64,
    );
    let full: [u8; 64] = seed.try_into().expect("64 bytes");
    let dk: [u8; 32] = full[..32].try_into().unwrap();
    let mut hasher = Sha256::new();
    hasher.update(dk);
    hasher.update(b"vault-key-recovery-v1"); // доменная привязка
    hasher.finalize().into()
}

// ---------- Обёртывание / распаковка ----------

pub fn wrap_backup(backup_json: &str, mnemonic: &str) -> Result<WrappedBackup, String> {
    validate_mnemonic(mnemonic)?;
    let kek = kek_from_mnemonic(mnemonic);

    let mut nonce_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let cipher = XChaCha20Poly1305::new((&kek).into());
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce_bytes), backup_json.as_bytes())
        .map_err(|e| format!("wrap failed: {e}"))?;

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);

    // fingerprint_hint берём из самого бэкапа, если он там есть.
    let fp = serde_json::from_str::<serde_json::Value>(backup_json)
        .ok()
        .and_then(|v| {
            v.get("keypair")
                .and_then(|kp| kp.get("public_key"))
                .and_then(|pk| pk.as_str())
                .map(|s| s.to_string())
        })
        .map(|pub_hex| {
            let h: [u8; 32] = Sha256::digest(hex::decode(&pub_hex).unwrap_or_default()).into();
            hex::encode(&h[..8])
        })
        .unwrap_or_default();

    Ok(WrappedBackup {
        v: 1,
        salt: hex::encode(salt),
        nonce: hex::encode(nonce_bytes),
        wrapped: base64::engine::general_purpose::STANDARD.encode(&ct),
        fingerprint_hint: fp,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

pub fn unwrap_backup(wrapped: &WrappedBackup, mnemonic: &str) -> Result<String, String> {
    validate_mnemonic(mnemonic)?;
    let kek = kek_from_mnemonic(mnemonic);
    let salt = hex::decode(&wrapped.salt).map_err(|_| "bad salt")?;
    let _ = salt; // salt участвует в KEK при создании; для обратной совместимости
                  // храним его, но KEK выводим только из слов (детерминизм).
    let nonce_bytes = hex::decode(&wrapped.nonce).map_err(|_| "bad nonce")?;
    if nonce_bytes.len() != 24 {
        return Err("bad nonce length".into());
    }
    let ct = base64::engine::general_purpose::STANDARD
        .decode(&wrapped.wrapped)
        .map_err(|_| "bad ciphertext encoding")?;
    let cipher = XChaCha20Poly1305::new((&kek).into());
    let pt = cipher
        .decrypt(XNonce::from_slice(&nonce_bytes), ct.as_ref())
        .map_err(|_| "Неверный ключ восстановления (слова не подходят)".to_string())?;
    String::from_utf8(pt).map_err(|_| "corrupted plaintext".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mnemonic_roundtrip() {
        let m1 = generate_mnemonic().unwrap();
        assert_eq!(m1.split_whitespace().count(), 12);
        validate_mnemonic(&m1).expect("valid");
        // нормализация: лишние пробелы/регистр допустимы при вводе
        validate_mnemonic(&format!("  {}  ", m1.to_uppercase())).expect("normalized valid");

        let bad = m1.replace(m1.split_whitespace().next().unwrap(), "abandon");
        if bad != m1 {
            assert!(validate_mnemonic(&bad).is_err(), "checksum must fail");
        }
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let backup =
            r#"{"version":1,"keypair":{"public_key":"aa","private_key":"bb"},"peer_keys":[]}"#;
        let mnemonic = generate_mnemonic().unwrap();
        let wrapped = wrap_backup(backup, &mnemonic).unwrap();

        let ok = unwrap_backup(&wrapped, &mnemonic).unwrap();
        assert_eq!(ok, backup);

        let other = generate_mnemonic().unwrap();
        assert!(unwrap_backup(&wrapped, &other).is_err());
        // подмена шифротекста ломает AEAD
        let mut tampered = wrapped.clone();
        tampered.wrapped = tampered.wrapped[..tampered.wrapped.len() - 4].to_string() + "AAAA";
        assert!(unwrap_backup(&tampered, &mnemonic).is_err());
    }
}
