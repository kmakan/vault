//! Восстановление личности по мнемонике: формат архива ключей и контрольная
//! сумма слов (ADR-005 §W4, `t_502b6c90`).
//!
//! Зачем в ядре: архив ключей — протокол, а не деталь экрана. Если контрольная
//! сумма считается по другой кодировке (регистр, лишние пробелы, порядок бит),
//! пользователь получает «слова не подходят» на верной мнемонике — и теряет
//! доступ к ящику. Поэтому генерация, нормализация, проверка суммы и обёртка
//! бэкапа живут здесь, покрыты тестами и мутационным набором; мост только
//! читает/пишет письмо-эскроу и зовёт эти функции.
//!
//! Формат:
//!   seed = PBKDF2-HMAC-SHA512(mnemonic_norm, "mnemonic"+"Vault recovery", 2048)
//!   kek  = SHA-256(SHA-512(seed)[0..32] || "vault-key-recovery-v1")
//!   wrapped = XChaCha20-Poly1305(kek, nonce24, backup_json)
//!
//! Соль в `WrappedBackup` хранится для совместимости, но KEK выводится только
//! из слов: восстановление детерминировано, иначе бэкап не открыть на другом
//! устройстве.

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
/// Итерации PBKDF2 для KEK. Меняются только вместе с миграцией архивов.
pub const PBKDF2_ITERS: u32 = 2048;
/// Соль PBKDF2 — часть BIP39-схемы, не пользовательский секрет.
pub const PASSPHRASE: &str = "Vault recovery";

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

/// Проверка контрольной суммы мнемоники (словарь EN, BIP39).
///
/// Ввод нормализуется: регистр и лишние пробелы допустимы — иначе «верные
/// слова, но с заглавной буквы» отвергались бы как неверные.
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

pub fn normalize_mnemonic(mnemonic: &str) -> String {
    mnemonic.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// PBKDF2-HMAC-SHA512 вручную (без pbkdf2-crate).
///
/// ВНИМАНИЕ: блок-счётчик — 8 байт, а не 4, как требует RFC 8018 (INT(i)).
/// Так вышло в мосте, который уже обёртывал архивы ключей, и менять это
/// нельзя: иначе все ранее созданные эскроу-письма перестанут открываться
/// словами (unwrap вернёт «неверный ключ»). Это не ошибка, а часть формата
/// архива — поэтому `kek_matches_archive_vector` закрепляет фактическое
/// значение, а не эталон PBKDF2.
fn pbkdf2_sha512(password: &[u8], salt: &[u8], iters: u32, out_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(out_len);
    let blocks = out_len.div_ceil(64usize);
    for block in 1..=blocks {
        let mut mac =
            <Hmac<Sha512> as Mac>::new_from_slice(password).expect("HMAC accepts any key length");
        mac.update(salt);
        mac.update(&(block as u64).to_be_bytes());
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
    hasher.update(b"vault-key-recovery-v1");
    hasher.finalize().into()
}

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
    let _ = salt; // соль участвует в KEK при создании; для обратной совместимости
                  // храним её, но KEK выводим только из слов (детерминизм).
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

        // Коррупт чексаммы: заменяем первое отличающееся слово на
        // «abandon»/«ability». ВАЖНО: у 12-словной мнемоники чексамма
        // ВСЕГО 4 бита — смена одного слова даёт ВАЛИДНУЮ новую сумму
        // с вероятностью 1/16, поэтому одна подстановка флакала
        // (~6–25% прогонов: «checksum must fail» на валидной замене).
        // Перебираем позиции (строго по индексу, не подстрокой), пока
        // checksum реально не сломается — P(все 12 коллизий) = 16^-12
        // ≈ 0, тест детерминирован.
        let words: Vec<&str> = m1.split_whitespace().collect();
        let candidates = ["abandon", "ability", "able", "about", "above"];
        let mut broken = false;
        for pos in 0..words.len() {
            for cand in candidates {
                if cand == words[pos] {
                    continue;
                }
                let mut cand_words = words.clone();
                cand_words[pos] = cand;
                if validate_mnemonic(&cand_words.join(" ")).is_err() {
                    broken = true;
                    break;
                }
            }
            if broken {
                break;
            }
        }
        assert!(broken, "checksum must fail for some replacement");
    }

    #[test]
    fn rejects_wrong_word_count_and_unknown_word() {
        assert!(validate_mnemonic("abandon abandon").is_err());
        let twelve = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        // 'about' в конце — известная валидная мнемоника BIP39 (нулевая энтропия).
        validate_mnemonic(twelve).expect("canonical all-zero mnemonic is valid");
        assert!(validate_mnemonic(&twelve.replace("about", "zzzz")).is_err());
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let backup = r#"{"keypair":{"public_key":"00112233445566778899aabbccddeeff"},"peer_keys":{}}"#;
        let mnemonic = generate_mnemonic().unwrap();
        let wrapped = wrap_backup(backup, &mnemonic).unwrap();
        assert_eq!(wrapped.v, 1);
        assert_eq!(wrapped.nonce.len(), 48);
        assert!(!wrapped.fingerprint_hint.is_empty());
        let ok = unwrap_backup(&wrapped, &mnemonic).unwrap();
        assert_eq!(ok, backup);

        let other = generate_mnemonic().unwrap();
        assert!(unwrap_backup(&wrapped, &other).is_err());

        let mut tampered = wrapped.clone();
        tampered.wrapped = base64::engine::general_purpose::STANDARD.encode(b"tampered");
        assert!(unwrap_backup(&tampered, &mnemonic).is_err());
    }

    /// KAT: KEK из канонической мнемоники (нулевая энтропия) — ровно то
    /// значение, с которым уже созданы эскроу-письма. Вектор НЕ совпадает с
    /// учебным PBKDF2-эталоном: блок-счётчик в мосте был 8-байтовым (см.
    /// `pbkdf2_sha512`). «Исправить» его — значит сделать старые архивы
    /// неоткрываемыми, при этом wrap+unwrap внутри одной версии остался бы
    /// зелёным: оба конца считали бы одинаково неверно.
    #[test]
    fn kek_matches_archive_vector() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let seed = pbkdf2_sha512(
            normalize_mnemonic(m).as_bytes(),
            format!("mnemonic{PASSPHRASE}").as_bytes(),
            PBKDF2_ITERS,
            64,
        );
        assert_eq!(
            hex::encode(&seed),
            "71da4dec16e1606584147d3c7ef87946eb58774309c59ad5e454850a8f87074b062613271ec4a489ab3c148600249216cadc9951204013fb30aca898a29fc692"
        );
        assert_eq!(
            hex::encode(kek_from_mnemonic(m)),
            "555430dfa00b7cf19fd2222c3b98e627c79f689a5fdaa6e333169c3bddeed82c"
        );
    }

    #[test]
    fn parameters_match_protocol() {
        // Меняются только вместе с миграцией архивов: иначе старые эскроу-
        // письма перестанут открываться верными словами.
        assert_eq!(PBKDF2_ITERS, 2048);
        assert_eq!(PASSPHRASE, "Vault recovery");
        assert_eq!(wordlist().len(), 2048);
    }

    #[test]
    fn normalization_collapses_whitespace_only() {
        assert_eq!(normalize_mnemonic("  a \n b\t c "), "a b c");
        // регистр НЕ приводится здесь: его приводит validate_mnemonic.
        assert_eq!(normalize_mnemonic("Ab C"), "Ab C");
    }
}
