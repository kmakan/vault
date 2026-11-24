//! Потоковый HTTP-протокол для своих медиа (ADR-006 §5.2, §7.1).
//!
//! WebView просит `bytes=…` у `sfera-media://…/<blob_id>`. Здесь разбирается
//! HTTP-диапазон, проверяется каталог и отдаётся ОДИН кусок plaintext через
//! `social-library::open_range_at`. Ключ, шифротекст и локальный путь в URL
//! и ответе не участвуют: наружу уходит blob_id и уже расшифрованные байты.

use std::str::FromStr;

use storage_api::{BlobId, Range};

use crate::{CommandError, SferaState};

/// Имя схемы, зарегистрированной в Tauri. JS не знает ни схемы, ни origin:
/// URL отдаёт Rust.
pub const MEDIA_SCHEME: &str = "sfera-media";
/// Один ответ протокола: WebView догрузит следующий кусок отдельным запросом.
pub const MAX_STREAM_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaResponse {
    pub status: u16,
    pub mime: String,
    pub content_range: Option<String>,
    pub bytes: Vec<u8>,
}

impl MediaResponse {
    fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            mime: "text/plain; charset=utf-8".into(),
            content_range: None,
            bytes: message.as_bytes().to_vec(),
        }
    }
}

/// `blob_id` — 64 hex-символа; это адрес блоба в хранилище, а не произвольный
/// путь. Проверка на границе не даёт scheme-запросу выйти за каталог.
pub fn valid_blob_id(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|b| b.is_ascii_hexdigit())
        && BlobId::from_str(value).is_ok()
}

/// HTTP `Range: bytes=…` переводится в полуоткрытый диапазон Rust.
/// HTTP-конец включителен, поэтому `+1`; `u64::MAX` не переполняет.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    From(u64),
    Between(u64, u64),
    Suffix(u64),
}

pub fn parse_http_range(value: &str) -> Result<RangeSpec, ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?.trim();
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        return Ok(if suffix == 0 { RangeSpec::Full } else { RangeSpec::Suffix(suffix) });
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if end.is_empty() {
        Ok(RangeSpec::From(start))
    } else {
        let end = end.parse::<u64>().map_err(|_| ())?;
        if end < start {
            return Err(());
        }
        Ok(RangeSpec::Between(start, end))
    }
}

/// `None` — диапазон вне файла (`416 Requested Range Not Satisfiable`).
pub fn resolve_range(spec: RangeSpec, size: u64) -> Result<Option<Range>, ()> {
    let range = match spec {
        RangeSpec::Full | RangeSpec::Suffix(0) => Range::new(0, None),
        RangeSpec::From(start) => Range::new(start, None),
        RangeSpec::Between(start, end) => Range::new(start, Some(end.saturating_add(1))),
        RangeSpec::Suffix(suffix) => Range::new(size.saturating_sub(suffix), None),
    };
    let range = range.map_err(|_| ())?;
    if range.start >= size && size > 0 {
        return Ok(None);
    }
    Ok(Some(range))
}

/// Отдать один кусок медиа. `range_header` — значение HTTP-заголовка `Range`
/// без имени; `None` трактуется как запрос с начала.
pub async fn serve_range(
    state: &SferaState,
    blob_id: &str,
    range_header: Option<&str>,
) -> MediaResponse {
    if !valid_blob_id(blob_id) {
        return MediaResponse::error(404, "media not found");
    }
    let Ok(store) = state.store_handle() else {
        return MediaResponse::error(500, "storage unavailable");
    };
    // Пустой диапазон читает только 71-байтный заголовок: размер и MIME
    // нужны до разбора `bytes=-N` и для проверки 416.
    let probe = match Range::new(0, Some(0)) {
        Ok(r) => r,
        Err(_) => return MediaResponse::error(500, "bad probe range"),
    };
    let probe = match social_library::open_range_at(
        state.keys_dir(), store.as_ref(), blob_id, probe,
    ).await {
        Ok(Some(v)) => v,
        Ok(None) => return MediaResponse::error(404, "media not found"),
        Err(_) => return MediaResponse::error(500, "media read failed"),
    };
    if probe.size == 0 {
        return MediaResponse {
            status: 416,
            mime: probe.mime,
            content_range: Some("bytes */0".into()),
            bytes: Vec::new(),
        };
    }

    let spec = match range_header {
        None => RangeSpec::Full,
        Some(h) => match parse_http_range(h) {
            Ok(v) => v,
            Err(_) => return MediaResponse::error(400, "bad range"),
        },
    };
    let range = match resolve_range(spec, probe.size) {
        Ok(Some(v)) => v,
        Ok(None) => return MediaResponse {
            status: 416,
            mime: probe.mime,
            content_range: Some(format!("bytes */{}", probe.size)),
            bytes: Vec::new(),
        },
        Err(_) => return MediaResponse::error(400, "bad range"),
    };
    let end = range
        .end
        .unwrap_or(probe.size)
        .min(probe.size)
        .min(range.start.saturating_add(MAX_STREAM_BYTES));
    let range = match Range::new(range.start, Some(end)) {
        Ok(v) if end > range.start => v,
        _ => return MediaResponse::error(416, "empty range"),
    };
    let opened = match social_library::open_range_at(
        state.keys_dir(), store.as_ref(), blob_id, range,
    ).await {
        Ok(Some(v)) => v,
        _ => return MediaResponse::error(500, "media read failed"),
    };
    MediaResponse {
        status: 206,
        mime: opened.mime,
        content_range: Some(format!(
            "bytes {}-{}/{}",
            opened.start,
            opened.end.saturating_sub(1),
            opened.size
        )),
        bytes: opened.bytes,
    }
}

/// Tauri на Windows/Android мапит кастомную схему на `http://<scheme>.localhost`,
/// на остальных — на `<scheme>://localhost`. Решение платформенное, живёт в Rust.
pub fn media_url(blob_id: &str) -> String {
    #[cfg(any(windows, target_os = "android"))]
    {
        format!("http://{MEDIA_SCHEME}.localhost/{blob_id}")
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        format!("{MEDIA_SCHEME}://localhost/{blob_id}")
    }
}

/// Информация для UI: тип и размер приходят из каталога. Никаких догадок
/// о mime или origin в JS.
pub async fn stream_info(
    state: &SferaState,
    blob_id: &str,
) -> Result<Option<(String, u64)>, CommandError> {
    if !valid_blob_id(blob_id) {
        return Err(CommandError::input("bad blob id"));
    }
    let store = state.store_handle()?;
    let probe = Range::new(0, Some(0)).map_err(CommandError::input)?;
    let opened = social_library::open_range_at(state.keys_dir(), store.as_ref(), blob_id, probe)
        .await
        .map_err(|e| CommandError::backend(format!("library: {e}")))?;
    Ok(opened.map(|v| (v.mime, v.size)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use social_app::{Identity, SferaApp};
    use social_sync::{Quota, RetryPolicy};
    use storage_local::LocalStore;

    const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";

    fn state_with(keys: &std::path::Path, store: Arc<LocalStore>) -> SferaState {
        let app = SferaApp::new(
            Identity::from_seed(SEED).unwrap(),
            store,
            RetryPolicy::default(),
            Quota::new(60, 10_000, 10, 0),
        );
        SferaState::new(app, None).with_keys_dir(keys)
    }

    #[test]
    fn http_ranges_are_translated_to_half_open() {
        assert_eq!(parse_http_range("bytes=0-99"), Ok(RangeSpec::Between(0, 99)));
        assert_eq!(parse_http_range("bytes=500-"), Ok(RangeSpec::From(500)));
        assert_eq!(parse_http_range("bytes=-256"), Ok(RangeSpec::Suffix(256)));
        assert_eq!(parse_http_range("bytes=0-"), Ok(RangeSpec::From(0)));
        assert_eq!(parse_http_range("bytes=10-5"), Err(()));
        assert_eq!(parse_http_range("0-1"), Err(()));
        assert_eq!(parse_http_range("bytes=a-1"), Err(()));
        assert_eq!(parse_http_range("bytes=1-18446744073709551615"), Ok(RangeSpec::Between(1, u64::MAX)));

        assert_eq!(resolve_range(RangeSpec::Between(0, 99), 25), Ok(Some(Range { start: 0, end: Some(100) })));
        assert_eq!(resolve_range(RangeSpec::From(30), 25), Ok(None));
        assert_eq!(resolve_range(RangeSpec::Suffix(5), 25), Ok(Some(Range { start: 20, end: None })));
        assert_eq!(resolve_range(RangeSpec::Suffix(100), 25), Ok(Some(Range { start: 0, end: None })));
    }

    #[test]
    fn url_uses_registered_scheme() {
        let id = "ab".repeat(32);
        let url = media_url(&id);
        assert!(url.ends_with(&format!("/{id}")));
        assert!(url.contains(MEDIA_SCHEME));
        assert!(!url.contains("file://"));
    }

    #[test]
    fn only_blob_ids_are_accepted() {
        assert!(valid_blob_id(&"ab".repeat(32)));
        assert!(!valid_blob_id(&"ab".repeat(31)));
        assert!(!valid_blob_id(&"zz".repeat(32)));
        assert!(!valid_blob_id("../../etc/passwd"));
    }

    #[tokio::test]
    async fn serve_range_answers_206_with_content_range_and_caps_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalStore::new(dir.path().join("blobs")).unwrap());
        let plaintext: Vec<u8> = (0..25u32).map(|i| (i % 251) as u8).collect();
        let up = social_upload::upload_encrypted(store.as_ref(), "video/mp4", &plaintext)
            .await
            .unwrap();
        social_library::remember_at(dir.path(), &up, 1).unwrap();
        let st = state_with(dir.path(), store);

        let part = serve_range(&st, &up.blob_id, Some("bytes=5-19")).await;
        assert_eq!(part.status, 206);
        assert_eq!(part.mime, "video/mp4");
        assert_eq!(part.content_range.as_deref(), Some("bytes 5-19/25"));
        assert_eq!(part.bytes, plaintext[5..20]);

        let open = serve_range(&st, &up.blob_id, None).await;
        assert_eq!(open.content_range.as_deref(), Some("bytes 0-24/25"));
        assert_eq!(open.bytes, plaintext);

        let bad = serve_range(&st, &up.blob_id, Some("bytes=nope")).await;
        assert_eq!(bad.status, 400);
        let past = serve_range(&st, &up.blob_id, Some("bytes=100-200")).await;
        assert_eq!(past.status, 416);
        assert_eq!(past.content_range.as_deref(), Some("bytes */25"));
        let missing = serve_range(&st, &"0".repeat(64), None).await;
        assert_eq!(missing.status, 404);

        let info = stream_info(&st, &up.blob_id).await.unwrap().unwrap();
        assert_eq!(info, ("video/mp4".into(), 25));
    }
}
