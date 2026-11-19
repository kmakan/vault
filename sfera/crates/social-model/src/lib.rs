//! Vault Sfera — базовая модель данных.
//!
//! Идентичность пользователя — отпечаток публичного ключа (`Fingerprint`),
//! НЕ email. Email (`deliver_to`) — только адрес доставки конверта.
//! Протокольные решения живут здесь, в Rust; JS — только UI/адаптер (ADR-006,
//! ADR-005).

pub mod canonical;
pub mod identity;
pub mod post;

pub use identity::Fingerprint;

/// Версия формата конверта. Неизвестные версии сохраняются как
/// «неподдерживаемые», а не ломают ленту (см. ADR-006 §4).
pub const FORMAT_VERSION: u8 = 1;

/// Автор поста: идентификатор (fingerprint) + открытый ключ для проверки подписи.
///
/// `fp` детерминированно выводится из `pub_key`, но хранится явно, чтобы
/// получатель мог опознать автора, не расшифровывая тело. Email здесь нет —
/// он живёт только в `deliver_to` конверта.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Author {
    /// Отпечаток публичного ключа, форма `xx:...:****` — ID пользователя.
    pub fp: Fingerprint,
    /// Открытый ключ (hex, 32 байта), которым проверяется `sig` поста.
    pub pub_key: String,
}

impl Author {
    /// Собрать автора из hex публичного ключа; `fp` выводится из него же.
    pub fn from_public_key_hex(pub_key: &str) -> Result<Self, String> {
        let fp = Fingerprint::from_public_key_hex(pub_key)?;
        Ok(Self {
            fp,
            pub_key: pub_key.to_string(),
        })
    }

    /// Совпадает ли `fp` автора с данным отпечатком.
    pub fn is(&self, fp: &Fingerprint) -> bool {
        self.fp.same(fp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUB: &str = "0200000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn author_identity_comes_from_public_key_not_email() {
        let author = Author::from_public_key_hex(PUB).unwrap();
        assert_eq!(author.fp.as_str(), "02:00:00:00:00:00:00:00:****");
        assert!(author.is(&Fingerprint::from_str("02:00:00:00:00:00:00:00:****")));
    }

    #[test]
    fn author_rejects_bad_key() {
        assert!(Author::from_public_key_hex("nope").is_err());
    }
}
