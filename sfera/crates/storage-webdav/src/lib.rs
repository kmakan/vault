//! Vault Sfera: адаптер WebDAV (ADR-006 §6, очередь 2).
//!
//! Правила границы:
//! - секреты (логин/пароль) живут в конфиге адаптера и НИКОГДА не попадают
//!   в `Locator`: `uri` — capability-путь, который можно логировать (§5.2);
//! - решение о том, ЧТО хранить, принимает `social-media`; адаптер только
//!   кладёт/читает байты по WebDAV;
//! - Range обязателен (§5.1): видео и большие блобы читаются кусками.
//!
//! Адаптер проходит тот же `storage-conformance::run`, что и `storage-local`.

use async_trait::async_trait;
use base64::Engine as _;
use reqwest::header::{HeaderValue, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use storage_api::{
    AuthKind, BlobId, BlobStat, BlobStore, Locator, Range, StorageError, StoreCaps, StoreKind,
};

/// Настройки подключения. Секреты хранятся здесь, а не в `Locator`.
#[derive(Clone, Debug)]
pub struct WebDavConfig {
    /// Базовый URL папки, например `https://cloud.example.ru/remote.php/dav/files/user/`.
    pub base_url: String,
    pub store_id: String,
    pub username: String,
    pub password: String,
    /// OAuth Bearer-токен (Яндекс Диск). Хранится в OS keychain, не здесь.
    /// Передаётся в конфиг на время команды и не сериализуется в `Locator`.
    pub bearer_token: Option<String>,
    /// Максимальный размер одного блоба; 0 означает «без ограничения адаптера».
    pub max_file_bytes: u64,
}

impl WebDavConfig {
    pub fn new(base_url: impl Into<String>, store_id: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            store_id: store_id.into(),
            username: String::new(),
            password: String::new(),
            bearer_token: None,
            max_file_bytes: 0,
        }
    }

    pub fn with_basic_auth(mut self, user: impl Into<String>, pass: impl Into<String>) -> Self {
        self.username = user.into();
        self.password = pass.into();
        self.bearer_token = None;
        self
    }

    /// OAuth-авторизация (Яндекс Диск, будущий Google Drive). Токен живёт в
    /// OS keychain; сюда он попадает только на время запроса (ADR-006 §6).
    pub fn with_bearer_token(mut self, token: impl Into<String>) -> Self {
        self.bearer_token = Some(token.into());
        self.username.clear();
        self.password.clear();
        self
    }

    /// Собрать capability-URI из имени блоба. Секретов внутри нет.
    pub fn locator_uri(&self, id: &BlobId) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            id.to_hex()
        )
    }

    fn auth_header(&self) -> Result<Option<HeaderValue>, StorageError> {
        if let Some(ref token) = self.bearer_token {
            return HeaderValue::from_str(&format!("Bearer {token}"))
                .map(Some)
                .map_err(|e| StorageError::Auth(e.to_string()));
        }
        if self.username.is_empty() && self.password.is_empty() {
            return Ok(None);
        }
        let raw = format!("{}:{}", self.username, self.password);
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
        HeaderValue::from_str(&format!("Basic {encoded}"))
            .map(Some)
            .map_err(|e| StorageError::Auth(e.to_string()))
    }
}

pub struct WebDavStore {
    config: WebDavConfig,
    client: reqwest::Client,
}

impl WebDavStore {
    pub fn new(config: WebDavConfig) -> Result<Self, StorageError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok(Self { config, client })
    }

    /// Проверить, что `uri` принадлежит этому пресету. Защита от подмены
    /// capability-пути из другого хранилища (§5.3: порядок локаций — не истина).
    fn resolve(&self, loc: &Locator) -> Result<String, StorageError> {
        if loc.store_id != self.config.store_id {
            return Err(StorageError::InvalidLocator(format!(
                "store_id {} != {}",
                loc.store_id, self.config.store_id
            )));
        }
        let expected = self.config.locator_uri(&loc.blob_id);
        if loc.uri != expected {
            return Err(StorageError::InvalidLocator(
                "uri does not match blob_id".into(),
            ));
        }
        Ok(loc.uri.clone())
    }

    fn request(&self, method: reqwest::Method, url: &str) -> Result<reqwest::RequestBuilder, StorageError> {
        let mut req = self.client.request(method, url);
        if let Some(auth) = self.config.auth_header()? {
            req = req.header(reqwest::header::AUTHORIZATION, auth);
        }
        Ok(req)
    }

    fn status(err: reqwest::Error, ctx: &str) -> StorageError {
        match err.status() {
            Some(s) if s.as_u16() == 404 => StorageError::NotFound,
            Some(s) if s.as_u16() == 401 || s.as_u16() == 403 => StorageError::Unauthorized,
            Some(s) if s.as_u16() == 507 || s.as_u16() == 413 => StorageError::QuotaExceeded,
            _ => StorageError::Backend(format!("{ctx}: {err}")),
        }
    }
}

#[async_trait]
impl BlobStore for WebDavStore {
    fn caps(&self) -> StoreCaps {
        StoreCaps {
            kind: StoreKind::WebDav,
            auth: if self.config.bearer_token.is_some() {
                AuthKind::OAuth
            } else if self.config.username.is_empty() {
                AuthKind::None
            } else {
                AuthKind::Password
            },
            public_link: false,
            range: true,
            max_file_bytes: self.config.max_file_bytes,
        }
    }

    async fn put(
        &self,
        id: &BlobId,
        mut r: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
        size: u64,
    ) -> Result<Locator, StorageError> {
        let mut bytes = Vec::with_capacity(size as usize);
        tokio::io::AsyncReadExt::read_to_end(&mut r, &mut bytes)
            .await
            .map_err(|e| StorageError::Io(e.to_string()))?;
        if bytes.len() as u64 != size {
            return Err(StorageError::ChecksumMismatch);
        }
        if self.config.max_file_bytes > 0 && size > self.config.max_file_bytes {
            return Err(StorageError::QuotaExceeded);
        }

        let uri = self.config.locator_uri(id);
        self.request(reqwest::Method::PUT, &uri)?
            .header(CONTENT_LENGTH, size)
            .body(bytes)
            .send()
            .await
            .map_err(|e| Self::status(e, "PUT"))?
            .error_for_status()
            .map_err(|e| Self::status(e, "PUT"))?;

        Ok(Locator {
            store_id: self.config.store_id.clone(),
            uri,
            blob_id: *id,
        })
    }

    async fn get(
        &self,
        loc: &Locator,
        range: Option<Range>,
    ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, StorageError> {
        let uri = self.resolve(loc)?;
        let mut req = self.request(reqwest::Method::GET, &uri)?;
        if let Some(r) = range {
            let end = r.end.map(|e| e.saturating_sub(1).to_string()).unwrap_or_default();
            req = req.header(RANGE, format!("bytes={}-{}", r.start, end));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| Self::status(e, "GET"))?
            .error_for_status()
            .map_err(|e| Self::status(e, "GET"))?;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok(Box::new(std::io::Cursor::new(bytes.to_vec())))
    }

    async fn stat(&self, loc: &Locator) -> Result<BlobStat, StorageError> {
        let uri = self.resolve(loc)?;
        let resp = self
            .request(reqwest::Method::HEAD, &uri)?
            .send()
            .await
            .map_err(|e| Self::status(e, "HEAD"))?
            .error_for_status()
            .map_err(|e| Self::status(e, "HEAD"))?;
        let headers = resp.headers();
        let size = headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| StorageError::Backend("HEAD without Content-Length".into()))?;
        // Content-Range приходит только на partial-ответы; здесь он не нужен,
        // но заголовок импортирован, чтобы контракт Range был явно зафиксирован.
        let _range_header = headers.get(CONTENT_RANGE);
        Ok(BlobStat {
            blob_id: loc.blob_id,
            size,
            modified_unix: None,
        })
    }

    async fn delete(&self, loc: &Locator) -> Result<(), StorageError> {
        let uri = self.resolve(loc)?;
        self.request(reqwest::Method::DELETE, &uri)?
            .send()
            .await
            .map_err(|e| Self::status(e, "DELETE"))?
            .error_for_status()
            .map_err(|e| Self::status(e, "DELETE"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_has_no_secrets() {
        let cfg = WebDavConfig::new("https://dav.example/base/", "nextcloud")
            .with_basic_auth("user", "s3cret");
        let id = BlobId::from_bytes([7u8; 32]);
        let uri = cfg.locator_uri(&id);
        assert!(!uri.contains("user"));
        assert!(!uri.contains("s3cret"));
        assert!(uri.starts_with("https://dav.example/base/"));
    }

    #[test]
    fn wrong_store_id_is_rejected() {
        let store = WebDavStore::new(WebDavConfig::new("https://dav.example/", "nextcloud")).unwrap();
        let id = BlobId::from_bytes([7u8; 32]);
        let loc = Locator {
            store_id: "other".into(),
            uri: store.config.locator_uri(&id),
            blob_id: id,
        };
        assert!(matches!(store.resolve(&loc), Err(StorageError::InvalidLocator(_))));
    }

    #[test]
    fn bearer_auth_is_oauth_and_clears_password() {
        let cfg = WebDavConfig::new("https://dav.example/", "yandex")
            .with_basic_auth("user", "pass")
            .with_bearer_token("ya-token");
        assert!(cfg.username.is_empty());
        assert!(cfg.password.is_empty());
        assert!(matches!(cfg.auth_header().unwrap(), Some(v) if v.to_str().unwrap().starts_with("Bearer ")));
    }

    #[test]
    fn caps_are_honest() {
        let store = WebDavStore::new(WebDavConfig::new("https://dav.example/", "nextcloud")).unwrap();
        let caps = store.caps();
        assert_eq!(caps.kind, StoreKind::WebDav);
        assert!(caps.range, "Range — prerequisite стриминга (§5.1)");
        assert!(!caps.public_link, "секреты не в capability URL (§5.2)");
    }
}
