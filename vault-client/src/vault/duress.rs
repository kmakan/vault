//! Параметры PBKDF2 замка и duress/panic-кодов (ADR-005 §W4, `t_502b6c90`).
//!
//! Зачем в ядре: итерации и формат `salt:hash` — протокол, а не деталь
//! экрана. Ошибка в итерациях делает ранее сохранённый хэш невалидным:
//! пользователь вводит верный код, а замок не открывается или аварийное
//! стирание не срабатывает — тихо, без ошибки. Поэтому параметры, вывод и
//! проверка живут в одном месте, покрыты тестами и мутационным набором, а
//! мост только читает/пишет конфиг и зовёт эти функции.
//!
//! Форма сохранённого значения — часть протокола: её читает и Kotlin-замок
//! (`LockActivity` → JNI → `verify_secret`), и JS-замок через мост.

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

/// Итерации PBKDF2. Меняется ТОЛЬКО вместе с миграцией сохранённых хэшей:
/// иначе все существующие PIN-ы перестанут проверяться.
pub const ITERATIONS: u32 = 10_000;
/// Длина соли в байтах.
pub const SALT_LEN: usize = 16;
/// Длина производного ключа в байтах.
pub const KEY_LEN: usize = 32;

fn pbkdf2_hmac_sha256(secret: &[u8], salt: &[u8], iterations: u32, out: &mut [u8; KEY_LEN]) {
    // PBKDF2-HMAC-SHA256 вручную (без pbkdf2-crate): U1=HMAC(salt||i), Ui=HMAC(prev)...
    type HmacSha256 = Hmac<Sha256>;
    let mut block: [u8; KEY_LEN] = [0; KEY_LEN];
    let mut block_index: u32 = 1;
    let mut filled = 0usize;
    while filled < KEY_LEN {
        let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
        mac.update(salt);
        mac.update(&block_index.to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut t = u;
        for _ in 1..iterations {
            let mut mac2 = HmacSha256::new_from_slice(secret).expect("hmac key");
            mac2.update(&u);
            u = mac2.finalize().into_bytes();
            for (tb, ub) in t.iter_mut().zip(u.iter()) {
                *tb ^= ub;
            }
        }
        let take = (KEY_LEN - filled).min(KEY_LEN);
        block[..take].copy_from_slice(&t[..take]);
        out[filled..filled + take].copy_from_slice(&block[..take]);
        filled += take;
        block_index += 1;
    }
}

/// Новый хэш секрета: `salt:hash` в hex. Соль случайная, поэтому два хэша
/// одного PIN-а различаются (проверяется тестом).
pub fn hash_secret(secret: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut out = [0u8; KEY_LEN];
    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, ITERATIONS, &mut out);
    let hex_salt: String = salt.iter().map(|b| format!("{b:02x}")).collect();
    let hex_hash: String = out.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex_salt}:{hex_hash}")
}

/// Constant-time сравнение сохранённого `salt:hash` с введённым секретом.
///
/// Разбор строгий: неверная длина или не-hex — это `false`, а не
/// «декодировали в нули и, может быть, совпало».
pub fn verify_secret(secret: &str, stored: &str) -> bool {
    let Some((hex_salt, hex_hash)) = stored.split_once(':') else {
        return false;
    };
    let Ok(salt) = hex::decode(hex_salt) else {
        return false;
    };
    if salt.len() != SALT_LEN {
        return false;
    }
    let Ok(expected_stored) = hex::decode(hex_hash) else {
        return false;
    };
    if expected_stored.len() != KEY_LEN {
        return false;
    }
    let mut expected = [0u8; KEY_LEN];
    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, ITERATIONS, &mut expected);
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(expected_stored.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_secret("1234");
        assert!(verify_secret("1234", &h));
        assert!(!verify_secret("4321", &h));
        assert!(!verify_secret("1234", "garbage"));
    }

    #[test]
    fn different_salts() {
        assert_ne!(hash_secret("x"), hash_secret("x"));
    }

    /// Параметры — контракт с уже сохранёнными хэшами. Этот тест падает
    /// первым, если кто-то «оптимизирует» итерации: иначе round-trip внутри
    /// новой версии остался бы зелёным, а старые PIN-ы перестали бы работать.
    #[test]
    fn parameters_match_protocol() {
        assert_eq!(ITERATIONS, 10_000);
        assert_eq!(SALT_LEN, 16);
        assert_eq!(KEY_LEN, 32);
    }

    /// KAT с фиксированной солью. Ловит дрейф алгоритма (порядок XOR, длина
    /// выхода, итерации), который round-trip внутри новой версии не видит:
    /// старые `salt:hash` перестали бы проверяться, а `hash_secret`+
    /// `verify_secret` остались бы согласованы сами с собой.
    #[test]
    fn pbkdf2_matches_known_vector() {
        let salt: [u8; SALT_LEN] = core::array::from_fn(|i| i as u8);
        let mut out = [0u8; KEY_LEN];
        pbkdf2_hmac_sha256(b"1234", &salt, ITERATIONS, &mut out);
        assert_eq!(
            hex::encode(out),
            "91ea059bae0333a2969fc8ccd7c77851dda43f5adb96baeea246a624cdf489ec"
        );
    }

    #[test]
    fn rejects_malformed_stored_hash() {
        let good = hash_secret("1234");
        let (salt, hash) = good.split_once(':').unwrap();
        assert!(!verify_secret("1234", salt), "нет разделителя");
        assert!(
            !verify_secret("1234", &format!("{}:{hash}", &salt[..8])),
            "короткая, но hex соль"
        );
        assert!(!verify_secret("1234", &format!("{salt}:")), "пустой хэш");
        assert!(
            !verify_secret("1234", &format!("{salt}:{}", &hash[..62])),
            "короткий хэш"
        );
        assert!(
            !verify_secret("1234", &format!("zz{salt}:{hash}")),
            "не-hex соль"
        );
        assert!(
            !verify_secret("1234", &format!("{salt}:zz{}", &hash[2..])),
            "не-hex хэш"
        );
    }

    #[test]
    fn empty_secret_is_still_hashed() {
        let h = hash_secret("");
        assert!(verify_secret("", &h));
        assert!(!verify_secret("0", &h));
    }
}
