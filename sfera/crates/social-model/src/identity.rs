//! Идентичность пользователя Sfera — отпечаток публичного ключа, НЕ email.
//!
//! Это то же правило, что в мессенджере (`vault-core/identity.rs`): `fp:` —
//! префикс namespace записи, а не часть отпечатка; сам отпечаток имеет форму
//! `xx:...:****` и стабилен при смене почты. Email — только адрес доставки.
//!
//! Форма отпечатка не дублируется здесь: она живёт в `vault-core` и вызывается
//! отсюда. Один источник истины на оба приложения.

use vault_core::identity as core_identity;

/// Идентификатор пользователя Sfera — отпечаток его публичного ключа.
///
/// Сравнение — через `vault_core::identity::same_fingerprint`, поэтому пустой
/// отпечаток никогда не совпадает ни с чем (в том числе с другим пустым).
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Fingerprint(String);

impl Fingerprint {
    /// Вычислить отпечаток из hex-строки публичного ключа (32 байта).
    ///
    /// Ошибка — если ключ не hex или не 32 байта: поддельный `author` не должен
    /// молча превращаться в «любой» отпечаток.
    pub fn from_public_key_hex(public_key_hex: &str) -> Result<Self, String> {
        let fp = core_identity::fingerprint_from_public_key(public_key_hex)?;
        Ok(Self(fp))
    }

    /// Создать из уже известной строки отпечатка (например, из QR/bundle).
    pub fn from_str(fp: &str) -> Self {
        Self(core_identity::normalize(fp))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Тот же пользователь? Пустой отпечаток не совпадает ни с чем.
    pub fn same(&self, other: &Self) -> bool {
        core_identity::same_fingerprint(&self.0, &other.0)
    }
}

impl std::fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUB_A: &str = "0200000000000000000000000000000000000000000000000000000000000000";
    const PUB_B: &str = "0300000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn fingerprint_derives_from_public_key() {
        let fp = Fingerprint::from_public_key_hex(PUB_A).expect("valid 32-byte key");
        // Первые 8 байт публичного ключа, запись xx:...:****.
        assert_eq!(fp.as_str(), "02:00:00:00:00:00:00:00:****");
    }

    #[test]
    fn different_public_keys_give_different_identities() {
        let a = Fingerprint::from_public_key_hex(PUB_A).unwrap();
        let b = Fingerprint::from_public_key_hex(PUB_B).unwrap();
        assert!(!a.same(&b));
    }

    #[test]
    fn identity_is_stable_across_email_change() {
        // Отпечаток не зависит от адреса: смена ящика пользователя не меняет.
        let fp = Fingerprint::from_public_key_hex(PUB_A).unwrap();
        let reparsed = Fingerprint::from_str("  02:00:00:00:00:00:00:00:****  ");
        assert!(fp.same(&reparsed));
    }

    #[test]
    fn empty_fingerprint_matches_nothing() {
        let empty = Fingerprint::from_str("");
        let real = Fingerprint::from_public_key_hex(PUB_A).unwrap();
        assert!(!empty.same(&empty));
        assert!(!empty.same(&real));
        assert!(!real.same(&empty));
    }

    #[test]
    fn invalid_public_key_is_rejected() {
        assert!(Fingerprint::from_public_key_hex("not-hex").is_err());
        assert!(Fingerprint::from_public_key_hex("deadbeef").is_err());
    }
}
