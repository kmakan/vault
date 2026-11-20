//! Vault Sfera: Яндекс Диск (ADR-006 §6, очередь 4).
//!
//! Яндекс Диск говорит по WebDAV, поэтому HTTP-логика НЕ дублируется: этот
//! crate — тонкий слой, который достаёт OAuth-токен из OS keychain и отдаёт
//! готовый `BlobStore` из `storage-webdav` с Bearer-авторизацией.
//!
//! Правила:
//! - refresh/access-токены хранятся в OS keychain (`storage-keychain`),
//!   не в SQLite и не в логах (§6);
//! - токен не попадает в `Locator`: capability-путь остаётся логируемым (§5.2);
//! - `Locator.store_id` фиксирован как `yandex`, чтобы нельзя было подсунуть
//!   путь другого провайдера (§5.3).

use storage_api::{BlobId, BlobStore, Locator, StorageError};
use storage_keychain::{KeychainError, SecretStore};
use storage_webdav::{WebDavConfig, WebDavStore};

pub const STORE_ID: &str = "yandex";
pub const WEBDAV_ENDPOINT: &str = "https://webdav.yandex.ru";
pub const KEYCHAIN_NAMESPACE: &str = "sfera";
pub const ACCESS_TOKEN_ACCOUNT: &str = "yandex:disk:access";
pub const REFRESH_TOKEN_ACCOUNT: &str = "yandex:disk:refresh";

/// OAuth-токены Яндекс Диска. Хранятся в OS keychain, никогда не логируются.
#[derive(Clone, Debug)]
pub struct YandexTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

impl YandexTokens {
    /// Прочитать токены из keychain. Отсутствие access-токена — ошибка.
    pub fn from_keychain(secrets: &SecretStore) -> Result<Self, StorageError> {
        let access = secrets
            .get(ACCESS_TOKEN_ACCOUNT)
            .map_err(map_keychain)?;
        let refresh = match secrets.get(REFRESH_TOKEN_ACCOUNT) {
            Ok(v) => Some(v),
            Err(KeychainError::NotFound(_)) => None,
            Err(e) => return Err(map_keychain(e)),
        };
        Ok(Self { access_token: access, refresh_token: refresh })
    }

    /// Сохранить токены в keychain. Вызывается после OAuth-потока.
    pub fn save(&self, secrets: &SecretStore) -> Result<(), StorageError> {
        secrets
            .set(ACCESS_TOKEN_ACCOUNT, &self.access_token)
            .map_err(map_keychain)?;
        if let Some(ref refresh) = self.refresh_token {
            secrets
                .set(REFRESH_TOKEN_ACCOUNT, refresh)
                .map_err(map_keychain)?;
        }
        Ok(())
    }

    /// Удалить токены (выход из аккаунта / отзыв доступа).
    pub fn clear(secrets: &SecretStore) -> Result<(), StorageError> {
        secrets.delete(ACCESS_TOKEN_ACCOUNT).map_err(map_keychain)?;
        secrets.delete(REFRESH_TOKEN_ACCOUNT).map_err(map_keychain)?;
        Ok(())
    }
}

fn map_keychain(e: KeychainError) -> StorageError {
    match e {
        KeychainError::NotFound(_) => StorageError::Unauthorized,
        other => StorageError::Auth(other.to_string()),
    }
}

/// Собрать `BlobStore` для Яндекс Диска из токенов в keychain.
pub fn store_from_keychain(
    secrets: &SecretStore,
) -> Result<Box<dyn BlobStore>, StorageError> {
    let tokens = YandexTokens::from_keychain(secrets)?;
    let cfg = WebDavConfig::new(WEBDAV_ENDPOINT, STORE_ID)
        .with_bearer_token(tokens.access_token);
    Ok(Box::new(WebDavStore::new(cfg)?))
}

/// Capability-путь блоба. Секретов внутри нет (§5.2).
pub fn locator_uri(id: &BlobId) -> String {
    format!("{WEBDAV_ENDPOINT}/vault/blobs/{}", id.to_hex())
}

/// Проверить, что `Locator` принадлежит Яндекс Диску (§5.3).
pub fn is_ours(loc: &Locator) -> bool {
    loc.store_id == STORE_ID && loc.uri.starts_with(&format!("{WEBDAV_ENDPOINT}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_has_no_secrets() {
        let id = BlobId::from_bytes([7u8; 32]);
        let uri = locator_uri(&id);
        assert!(uri.starts_with(WEBDAV_ENDPOINT));
        assert!(!uri.contains("Bearer"));
        assert!(!uri.contains("token"));
    }

    #[test]
    fn foreign_locator_is_rejected() {
        let id = BlobId::from_bytes([7u8; 32]);
        let foreign = Locator {
            store_id: "selectel".into(),
            uri: locator_uri(&id),
            blob_id: id,
        };
        assert!(!is_ours(&foreign));
        let ours = Locator {
            store_id: STORE_ID.into(),
            uri: locator_uri(&id),
            blob_id: id,
        };
        assert!(is_ours(&ours));
    }

    #[test]
    fn keychain_accounts_are_stable() {
        assert_eq!(ACCESS_TOKEN_ACCOUNT, "yandex:disk:access");
        assert_eq!(REFRESH_TOKEN_ACCOUNT, "yandex:disk:refresh");
    }
}
