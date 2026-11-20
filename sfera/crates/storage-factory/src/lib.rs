//! Vault Sfera: фабрика `BlobStore` по пресету (ADR-006 §6.1).
//!
//! Каталог (`storage-providers`) говорит, какие поля показать; фабрика
//! превращает заполненные поля в готовый адаптер. Ни один доменный крейт не
//! знает, какой HTTP-клиент или keychain стоит за `BlobStore`.
//!
//! Секреты приходят в `Credentials` из UI/keychain и НЕ попадают в `Locator`.
//! Google Drive сознательно не поддерживается: `storage-providers::is_deferred`.

use std::path::PathBuf;
use std::sync::Arc;

use storage_api::{BlobStore, StorageError};
use storage_keychain::SecretStore;
use storage_providers::{preset, is_deferred};
use storage_s3::{S3Config, S3Store};
use storage_webdav::{WebDavConfig, WebDavStore};

/// Учётные данные для подключения. Значения приходят из полей формы или
/// OS keychain; в логах и `Locator` их нет.
#[derive(Clone, Debug, Default)]
pub struct Credentials {
    pub url: Option<String>,
    pub login: Option<String>,
    pub secret: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub local_root: Option<PathBuf>,
}

/// Собрать `BlobStore` по id пресета.
pub fn build_store(
    preset_id: &str,
    creds: &Credentials,
) -> Result<Arc<dyn BlobStore>, StorageError> {
    if is_deferred(preset_id) {
        return Err(StorageError::Backend(format!(
            "provider {preset_id} is deferred until all main providers work"
        )));
    }
    let p = preset(preset_id)
        .ok_or_else(|| StorageError::Backend(format!("unknown preset {preset_id}")))?;

    match p.id {
        "device" => {
            let root = creds.local_root.clone()
                .ok_or_else(|| StorageError::InvalidLocator("local_root required".into()))?;
            Ok(Arc::new(storage_local::LocalStore::new(root)
                .map_err(|e| StorageError::Io(e.to_string()))?))
        }
        "nextcloud" | "webdav" => {
            let url = creds.url.as_ref()
                .ok_or_else(|| StorageError::InvalidLocator("url required".into()))?;
            let cfg = WebDavConfig::new(url.clone(), p.id)
                .with_basic_auth(
                    creds.login.clone().unwrap_or_default(),
                    creds.secret.clone().unwrap_or_default(),
                );
            Ok(Arc::new(WebDavStore::new(cfg)?))
        }
        "selectel" => {
            let endpoint = creds.url.clone()
                .unwrap_or_else(|| p.endpoint.unwrap_or("").to_string());
            let bucket = creds.bucket.clone()
                .ok_or_else(|| StorageError::InvalidLocator("bucket required".into()))?;
            let mut cfg = S3Config::new(endpoint, bucket, p.id);
            if let Some(ref region) = creds.region {
                cfg = cfg.with_region(region.clone());
            } else if let Some(r) = p.region {
                cfg = cfg.with_region(r);
            }
            cfg = cfg.with_keys(
                creds.login.clone().unwrap_or_default(),
                creds.secret.clone().unwrap_or_default(),
            );
            Ok(Arc::new(S3Store::new(cfg)?))
        }
        "yandex" => {
            // OAuth: токены берём из OS keychain, полей в UI нет.
            let secrets = SecretStore::new(storage_yandex::KEYCHAIN_NAMESPACE)
                .map_err(|e| StorageError::Auth(e.to_string()))?;
            let boxed = storage_yandex::store_from_keychain(&secrets)?;
            Ok(Arc::from(boxed))
        }
        "custom" => Err(StorageError::Backend(
            "custom preset requires explicit adapter selection".into(),
        )),
        _ => Err(StorageError::Backend(format!("unsupported preset {}", p.id))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_is_rejected_even_if_asked() {
        let err = build_store("google", &Credentials::default()).err().expect("must fail");
        assert!(err.to_string().contains("deferred"));
    }

    #[test]
    fn unknown_preset_is_typed_error() {
        let err = build_store("nope", &Credentials::default()).err().expect("must fail");
        assert!(err.to_string().contains("unknown preset"));
    }

    #[test]
    fn device_requires_root() {
        let err = build_store("device", &Credentials::default()).err().expect("must fail");
        assert!(err.to_string().contains("local_root"));
    }

    #[test]
    fn webdav_builds_with_url() {
        let creds = Credentials {
            url: Some("http://127.0.0.1:1/dav".into()),
            login: Some("u".into()),
            secret: Some("p".into()),
            ..Default::default()
        };
        let store = build_store("webdav", &creds).unwrap();
        assert_eq!(store.caps().kind, storage_api::StoreKind::WebDav);
    }
}
