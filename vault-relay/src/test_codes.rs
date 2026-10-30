//! Персональные тестовые коды для приглашённых тестеров.
//!
//! Зачем: общий промо-ключ (`VAULT_RELAY_UNLIMITED_KEY`) выдаёт безлимитный
//! тестовый токен на 10 лет и не даёт отозвать его у одного человека, не
//! задев остальных. Здесь — код на одного тестера: одноразовый, привязан к
//! первому fingerprint, живёт ограниченный срок, отзывается по коду или fp.
//!
//! Код — bearer-секрет: сервер хранит только SHA-256, открытый текст виден
//! ровно один раз при выдаче. Формат `vt1-<32 hex>`: префикс отделяет код
//! от общего промо-ключа, hex — без двусмысленных символов при диктовке.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Префикс персонального кода. Общий промо-ключ его не содержит.
pub const CODE_PREFIX: &str = "vt1-";
/// Длина hex-части кода (16 байт энтропии = 128 бит).
pub const CODE_HEX_LEN: usize = 32;
/// Срок тестового токена по умолчанию — 6 месяцев.
pub const DEFAULT_DAYS: u32 = 180;
/// Минимальный срок: ноль дней выдал бы уже истёкший токен.
pub const MIN_DAYS: u32 = 1;
/// Максимальный срок совпадает с общим сроком токена релея (10 лет).
pub const MAX_DAYS: u32 = 3650;

/// Запись о выданном коде. Ключ в state — `hash(code)`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TesterCode {
    /// Метка владельца («тестер №3, почта …») — для админ-списка и отзыва.
    #[serde(default)]
    pub label: String,
    /// Срок тестового токена в днях (кламп при выдаче и чтении).
    #[serde(default)]
    pub days: u32,
    /// unix-сек выдачи кода.
    #[serde(default)]
    pub created_at: u64,
    /// fingerprint, к которому код привязан первым использованием.
    #[serde(default)]
    pub fp: Option<String>,
    /// hash выданного по коду токена (что именно отзывать).
    #[serde(default)]
    pub token_hash: Option<String>,
    /// Код отозван: повторно безлимит не выдаётся, токен в денлисте.
    #[serde(default)]
    pub revoked: bool,
}

/// Итог проверки кода для пришедшего fp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// Код ещё ни за кем не закреплён — закрепляем за этим fp.
    Fresh,
    /// Код уже закреплён за этим же fp (повторный вход) — идемпотентно.
    Same,
    /// Код закреплён за другим fp — второй аккаунт по нему не проходит.
    Other,
    /// Код отозван — безлимит не выдаётся.
    Revoked,
}

/// Сгенерировать новый код (16 случайных байт).
pub fn generate() -> String {
    let mut raw = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    format!("{}{}", CODE_PREFIX, hex::encode(raw))
}

/// Привести код к канону: trim, нижний регистр, проверка префикса и hex.
/// None = это не персональный код (общий промо-ключ или мусор).
pub fn normalize(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_ascii_lowercase();
    let body = lowered.strip_prefix(CODE_PREFIX)?;
    if body.len() != CODE_HEX_LEN {
        return None;
    }
    if !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("{}{}", CODE_PREFIX, body))
}

/// SHA-256 канонического кода, hex. None = код невалиден.
pub fn hash(code: &str) -> Option<String> {
    let norm = normalize(code)?;
    let mut h = Sha256::new();
    h.update(norm.as_bytes());
    Some(hex::encode(h.finalize()))
}

/// Срок токена: запрошенный (или 180 дней) в границах [1, 3650].
pub fn ttl_days(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_DAYS).clamp(MIN_DAYS, MAX_DAYS)
}

/// Можно ли выдать/переиспользовать токен по коду для этого fp.
pub fn claim(record: &TesterCode, fp: &str) -> Claim {
    if record.revoked {
        return Claim::Revoked;
    }
    match record.fp.as_deref() {
        None => Claim::Fresh,
        Some(bound) if bound.eq_ignore_ascii_case(fp) => Claim::Same,
        Some(_) => Claim::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(fp: Option<&str>, revoked: bool) -> TesterCode {
        TesterCode {
            label: "test".into(),
            days: DEFAULT_DAYS,
            created_at: 1,
            fp: fp.map(str::to_string),
            token_hash: None,
            revoked,
        }
    }

    #[test]
    fn generated_code_is_canonical_and_hashed() {
        let code = generate();
        assert!(code.starts_with(CODE_PREFIX));
        assert_eq!(code.len(), CODE_PREFIX.len() + CODE_HEX_LEN);
        assert_eq!(normalize(&code).as_deref(), Some(code.as_str()));
        let h = hash(&code).expect("hash");
        assert_eq!(h.len(), 64);
        assert_ne!(code, generate(), "коды не повторяются");
    }

    #[test]
    fn normalize_accepts_case_and_spaces_rejects_garbage() {
        let code = "vt1-0123456789abcdef0123456789abcdef";
        let upper = "  VT1-0123456789ABCDEF0123456789ABCDEF ";
        assert_eq!(normalize(upper).as_deref(), Some(code));
        assert_eq!(normalize("vt1-0123"), None, "короткий код");
        assert_eq!(normalize("vt1-0123456789abcdef0123456789abcdeg"), None);
        assert_eq!(normalize("SECRET-PROMO"), None, "общий промо-ключ это не код");
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn hash_is_stable_and_case_insensitive() {
        let a = hash("vt1-0123456789abcdef0123456789abcdef").expect("a");
        let b = hash("VT1-0123456789ABCDEF0123456789ABCDEF").expect("b");
        assert_eq!(a, b);
        assert_eq!(hash("nope"), None);
    }

    #[test]
    fn ttl_defaults_to_six_months_and_clamps() {
        assert_eq!(ttl_days(None), 180);
        assert_eq!(ttl_days(Some(0)), MIN_DAYS);
        assert_eq!(ttl_days(Some(30)), 30);
        assert_eq!(ttl_days(Some(999_999)), MAX_DAYS);
    }

    #[test]
    fn claim_rules() {
        let fresh = rec(None, false);
        assert_eq!(claim(&fresh, "aa:bb"), Claim::Fresh);
        let bound = rec(Some("aa:bb"), false);
        assert_eq!(claim(&bound, "aa:bb"), Claim::Same);
        assert_eq!(claim(&bound, "AA:BB"), Claim::Same, "fp сравниваем без регистра");
        assert_eq!(claim(&bound, "cc:dd"), Claim::Other);
        let revoked = rec(Some("aa:bb"), true);
        assert_eq!(claim(&revoked, "aa:bb"), Claim::Revoked, "отзыв важнее привязки");
        assert_eq!(claim(&revoked, "cc:dd"), Claim::Revoked);
    }
}
