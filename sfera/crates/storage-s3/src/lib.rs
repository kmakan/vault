//! Vault Sfera: S3-совместимый адаптер (Selectel / VK Cloud / MinIO), ADR-006 §6.
//!
//! Почему свой SigV4, а не `aws-sdk-s3`: SDK тянет огромное дерево зависимостей
//! и не используется в запущенном мессенджере. Здесь ровно четыре операции
//! `BlobStore` и подпись AWS Signature V4 на `sha2 0.10` + `hmac 0.12`, которые
//! уже есть в workspace. Никакого рассинхрона версий.
//!
//! Граница та же, что у WebDAV: секреты (access/secret key) живут в конфиге,
//! а не в `Locator`; `uri` — capability-путь, который можно логировать (§5.2).

use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, RANGE};

const X_AMZ_DATE: &str = "x-amz-date";
const X_AMZ_CONTENT_SHA256: &str = "x-amz-content-sha256";
use sha2::{Digest, Sha256};
use storage_api::{
    AuthKind, BlobId, BlobStat, BlobStore, Locator, Range, StorageError, StoreCaps, StoreKind,
};

type HmacSha256 = Hmac<Sha256>;

/// Ключи и endpoint. Секреты НЕ попадают в `Locator`.
#[derive(Clone, Debug)]
pub struct S3Config {
    /// Например `https://s3.mds.cloud` (Selectel) или `http://localhost:9000` (MinIO).
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub store_id: String,
    pub access_key: String,
    pub secret_key: String,
    pub max_file_bytes: u64,
}

impl S3Config {
    pub fn new(endpoint: impl Into<String>, bucket: impl Into<String>, store_id: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            region: "us-east-1".into(),
            store_id: store_id.into(),
            access_key: String::new(),
            secret_key: String::new(),
            max_file_bytes: 0,
        }
    }

    pub fn with_region(mut self, region: impl Into<String>) -> Self {
        self.region = region.into();
        self
    }

    pub fn with_keys(mut self, access: impl Into<String>, secret: impl Into<String>) -> Self {
        self.access_key = access.into();
        self.secret_key = secret.into();
        self
    }

    /// Capability-путь: bucket + hex(bucket_id). Секретов внутри нет.
    pub fn locator_uri(&self, id: &BlobId) -> String {
        format!(
            "{}/{}/{}",
            self.endpoint.trim_end_matches('/'),
            self.bucket,
            id.to_hex()
        )
    }

    fn object_path(&self, id: &BlobId) -> String {
        format!("/{}/{}", self.bucket, id.to_hex())
    }
}

fn hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(Sha256::digest(data).as_slice())
}

fn amz_date(epoch: u64) -> (String, String) {
    // Свой форматировщик: без chrono/time, чтобы не тащить зависимости.
    let secs = epoch as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60
    )
    .pipe(|full| (full.clone(), full[..8].to_string()))
}

// tiny helper to keep amz_date readable without extra traits
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

/// Подпись AWS Signature V4 для одного запроса.
fn sign_request(
    cfg: &S3Config,
    method: &str,
    path: &str,
    query: &str,
    payload_hash: &str,
    epoch: u64,
) -> (String, String) {
    let (amz, short) = amz_date(epoch);
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host_of(&cfg.endpoint), payload_hash, amz
    );
    let canonical_request = format!(
        "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{short}/{}/s3/aws4_request", cfg.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let k_date = hmac(format!("AWS4{}", cfg.secret_key).as_bytes(), &short);
    let k_region = hmac(&k_date, &cfg.region);
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &string_to_sign));
    let auth = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        cfg.access_key
    );
    (auth, amz)
}

fn host_of(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn status(err: reqwest::Error, ctx: &str) -> StorageError {
    match err.status() {
        Some(s) if s.as_u16() == 404 => StorageError::NotFound,
        Some(s) if s.as_u16() == 401 || s.as_u16() == 403 => StorageError::Unauthorized,
        Some(s) if s.as_u16() == 507 || s.as_u16() == 413 => StorageError::QuotaExceeded,
        _ => StorageError::Backend(format!("{ctx}: {err}")),
    }
}

fn now_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub struct S3Store {
    config: S3Config,
    client: reqwest::Client,
}

impl S3Store {
    pub fn new(config: S3Config) -> Result<Self, StorageError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok(Self { config, client })
    }

    fn resolve(&self, loc: &Locator) -> Result<BlobId, StorageError> {
        if loc.store_id != self.config.store_id {
            return Err(StorageError::InvalidLocator(format!(
                "store_id {} != {}", loc.store_id, self.config.store_id
            )));
        }
        if loc.uri != self.config.locator_uri(&loc.blob_id) {
            return Err(StorageError::InvalidLocator("uri does not match blob_id".into()));
        }
        Ok(loc.blob_id)
    }

    fn signed(
        &self,
        method: &str,
        path: &str,
        query: &str,
        payload_hash: &str,
    ) -> Result<reqwest::RequestBuilder, StorageError> {
        let (auth, amz) = sign_request(&self.config, method, path, query, payload_hash, now_epoch());
        let url = format!("{}{}{}", self.config.endpoint.trim_end_matches('/'), path, query);
        Ok(self
            .client
            .request(method.parse::<reqwest::Method>().map_err(|e| StorageError::Backend(e.to_string()))?, url)
            .header(AUTHORIZATION, auth)
            .header(X_AMZ_DATE, amz)
            .header(X_AMZ_CONTENT_SHA256, payload_hash))
    }
}

#[async_trait]
impl BlobStore for S3Store {
    fn caps(&self) -> StoreCaps {
        StoreCaps {
            kind: StoreKind::S3,
            auth: AuthKind::Keys,
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
        let path = self.config.object_path(id);
        let hash = sha256_hex(&bytes);
        self.signed("PUT", &path, "", &hash)?
            .header(CONTENT_LENGTH, size)
            .body(bytes)
            .send()
            .await
            .map_err(|e| status(e, "PUT"))?
            .error_for_status()
            .map_err(|e| status(e, "PUT"))?;
        Ok(Locator {
            store_id: self.config.store_id.clone(),
            uri: self.config.locator_uri(id),
            blob_id: *id,
        })
    }

    async fn get(
        &self,
        loc: &Locator,
        range: Option<Range>,
    ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, StorageError> {
        let id = self.resolve(loc)?;
        let path = self.config.object_path(&id);
        let query = match range {
            Some(r) => {
                let end = r.end.map(|e| e.saturating_sub(1).to_string()).unwrap_or_default();
                format!("?range=bytes={}-{}", r.start, end)
            }
            None => String::new(),
        };
        // S3: подпись считается с пустым payload для GET; Range передаётся
        // заголовком, который входит в signed headers только при явном задании.
        let (auth, amz) = sign_request(
            &self.config,
            "GET",
            &path,
            if query.is_empty() { "" } else { &query },
            &sha256_hex(b""),
            now_epoch(),
        );
        let url = format!("{}{}{}", self.config.endpoint.trim_end_matches('/'), path, query);
        let mut req = self
            .client
            .get(url)
            .header(AUTHORIZATION, auth)
            .header(X_AMZ_DATE, amz)
            .header(X_AMZ_CONTENT_SHA256, sha256_hex(b""));
        if let Some(r) = range {
            let end = r.end.map(|e| e.saturating_sub(1).to_string()).unwrap_or_default();
            req = req.header(RANGE, format!("bytes={}-{}", r.start, end));
        }
        let bytes = req
            .send()
            .await
            .map_err(|e| status(e, "GET"))?
            .error_for_status()
            .map_err(|e| status(e, "GET"))?
            .bytes()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok(Box::new(std::io::Cursor::new(bytes.to_vec())))
    }

    async fn stat(&self, loc: &Locator) -> Result<BlobStat, StorageError> {
        let id = self.resolve(loc)?;
        let path = self.config.object_path(&id);
        let resp = self
            .signed("HEAD", &path, "", &sha256_hex(b""))?
            .send()
            .await
            .map_err(|e| status(e, "HEAD"))?
            .error_for_status()
            .map_err(|e| status(e, "HEAD"))?;
        let size = resp
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| StorageError::Backend("HEAD without Content-Length".into()))?;
        Ok(BlobStat { blob_id: id, size, modified_unix: None })
    }

    async fn delete(&self, loc: &Locator) -> Result<(), StorageError> {
        let id = self.resolve(loc)?;
        let path = self.config.object_path(&id);
        self.signed("DELETE", &path, "", &sha256_hex(b""))?
            .send()
            .await
            .map_err(|e| status(e, "DELETE"))?
            .error_for_status()
            .map_err(|e| status(e, "DELETE"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_has_no_secrets() {
        let cfg = S3Config::new("https://s3.example.ru", "vault", "selectel")
            .with_keys("AKIAKEY", "s3cr3tsecret");
        let id = BlobId::from_bytes([7u8; 32]);
        let uri = cfg.locator_uri(&id);
        assert!(!uri.contains("AKIAKEY"));
        assert!(!uri.contains("s3cr3tsecret"));
    }

    #[test]
    fn signing_is_deterministic_and_covers_scope() {
        let cfg = S3Config::new("https://s3.example.ru", "vault", "selectel")
            .with_region("ru-central1")
            .with_keys("AKIAKEY", "secret");
        let (a1, _) = sign_request(&cfg, "GET", "/vault/abc", "", &sha256_hex(b""), 1_700_000_000);
        let (a2, _) = sign_request(&cfg, "GET", "/vault/abc", "", &sha256_hex(b""), 1_700_000_000);
        assert_eq!(a1, a2, "подпись детерминирована");
        assert!(a1.contains("ru-central1/s3/aws4_request"));
        assert!(a1.contains("AKIAKEY"));
    }

    #[test]
    fn tampered_path_changes_signature() {
        let cfg = S3Config::new("https://s3.example.ru", "vault", "selectel")
            .with_keys("AKIAKEY", "secret");
        let (a1, _) = sign_request(&cfg, "GET", "/vault/aaa", "", &sha256_hex(b""), 1_700_000_000);
        let (a2, _) = sign_request(&cfg, "GET", "/vault/bbb", "", &sha256_hex(b""), 1_700_000_000);
        assert_ne!(a1, a2);
    }

    #[test]
    fn caps_are_honest() {
        let store = S3Store::new(S3Config::new("https://s3.example.ru", "vault", "selectel")).unwrap();
        let caps = store.caps();
        assert_eq!(caps.kind, StoreKind::S3);
        assert_eq!(caps.auth, AuthKind::Keys);
        assert!(caps.range);
        assert!(!caps.public_link);
    }
}
