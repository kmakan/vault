//! Vault: общий порт OS keychain для токенов хранилищ (ADR-006 §6, §9.7).
//!
//! Почему отдельный крейт: ADR требует хранить OAuth refresh-токены в OS
//! keychain, а не в SQLite и не в логах. У мессенджера уже есть `SecureStore`,
//! но он жёстко привязан к master-key (`vault-vault` / `master-key`) и не
//! годится для токенов Sfera. Здесь — узкий порт «положить/прочитать/удалить
//! секрет» с namespace на приложение, чтобы один продукт не видел токены
//! другого.
//!
//! Пока крейт живёт в workspace Sfera. По правилу §9.7 он становится общим
//! (`vault-shared-keychain`) при появлении второго потребителя — например,
//! когда видеохостинг или мессенджер начнут хранить свои OAuth-токены.

use keyring::Entry;

const DEFAULT_SERVICE: &str = "vault-sfera";

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("keychain backend error: {0}")]
    Backend(String),
    #[error("secret not found: {0}")]
    NotFound(String),
    #[error("invalid secret name: {0}")]
    InvalidName(String),
}

impl From<keyring::Error> for KeychainError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => KeychainError::NotFound("entry".into()),
            other => KeychainError::Backend(other.to_string()),
        }
    }
}

/// Изолированный доступ к секретам одного приложения.
///
/// `namespace` — имя продукта (`sfera`, `vault`, `videohost`); `account` —
/// стабильный идентификатор токена (`yandex:refresh`, `google:refresh`).
/// Разные namespace не видят чужие записи даже при одинаковом account.
#[derive(Clone, Debug)]
pub struct SecretStore {
    service: String,
}

impl SecretStore {
    pub fn new(namespace: &str) -> Result<Self, KeychainError> {
        if namespace.is_empty()
            || namespace.len() > 64
            || !namespace
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(KeychainError::InvalidName(namespace.into()));
        }
        Ok(Self {
            service: format!("{DEFAULT_SERVICE}:{namespace}"),
        })
    }

    fn entry(&self, account: &str) -> Result<Entry, KeychainError> {
        if account.is_empty()
            || account.len() > 128
            || !account
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.'))
        {
            return Err(KeychainError::InvalidName(account.into()));
        }
        Ok(Entry::new(&self.service, account)?)
    }

    /// Сохранить секрет. Повторная запись перезаписывает значение.
    pub fn set(&self, account: &str, secret: &str) -> Result<(), KeychainError> {
        self.entry(account)?.set_password(secret)?;
        Ok(())
    }

    /// Прочитать секрет. Отсутствие — типизированная ошибка `NotFound`.
    pub fn get(&self, account: &str) -> Result<String, KeychainError> {
        self.entry(account)?.get_password().map_err(Into::into)
    }

    /// Удалить секрет. Идемпотентно: повторный вызов не ошибка.
    pub fn delete(&self, account: &str) -> Result<(), KeychainError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(KeychainError::Backend(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_is_validated() {
        assert!(SecretStore::new("sfera").is_ok());
        assert!(SecretStore::new("video-host_1").is_ok());
        assert!(SecretStore::new("").is_err());
        assert!(SecretStore::new("bad/name").is_err());
    }

    #[test]
    fn account_names_are_validated() {
        let s = SecretStore::new("sfera").unwrap();
        assert!(s.entry("yandex:refresh").is_ok());
        assert!(s.entry("google-refresh.v1").is_ok());
        assert!(s.entry("bad name").is_err());
        assert!(s.entry("").is_err());
    }

    #[test]
    fn namespaces_are_isolated() {
        let a = SecretStore::new("sfera").unwrap();
        let b = SecretStore::new("videohost").unwrap();
        assert_ne!(a.service, b.service);
        assert!(a.service.starts_with("vault-sfera:"));
    }
}
