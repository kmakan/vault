//! Authenticated author upload for the public vitrine.
//!
//! Read endpoints remain public and read-only. Upload is enabled only when
//! SFERA_PUBLIC_UPLOAD_TOKEN is configured at process start. Every request
//! reloads the catalog so a publication becomes visible without a restart.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use social_paid::PublicFeed;
use crate::{CatalogError, PublicCatalog, PUBLIC_FEED_MAX_POSTS};

pub const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct PublicServerState {
    root: PathBuf,
    upload_token: Option<Arc<str>>,
    write_lock: Arc<Mutex<()>>,
    max_posts: usize,
}

impl PublicServerState {
    pub fn from_env(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            upload_token: std::env::var("SFERA_PUBLIC_UPLOAD_TOKEN")
                .ok()
                .filter(|value| !value.is_empty())
                .map(Arc::from),
            write_lock: Arc::new(Mutex::new(())),
            max_posts: PUBLIC_FEED_MAX_POSTS,
        }
    }

    pub fn router(self) -> Router {
        Router::new()
            .fallback(any(dispatch))
            .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
            .with_state(self)
    }
}

async fn dispatch(State(state): State<PublicServerState>, req: Request) -> Response {
    let is_channel = req.uri().path().starts_with("/sfera/public/channels/")
        && req.uri().path() != "/sfera/public/channels/";
    if is_channel && req.method() == axum::http::Method::PUT {
        upload(State(state), req).await
    } else {
        read_public(State(state), req).await
    }
}

async fn read_public(State(state): State<PublicServerState>, req: Request) -> Response {
    let catalog = match PublicCatalog::open_with_limit(&state.root, state.max_posts) {
        Ok(catalog) => catalog,
        Err(_) => return json_response(503, serde_json::json!({"error": "catalog_unavailable"})),
    };
    let target = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| req.uri().path());
    let result = catalog.handle(req.method().as_str(), target);
    let status = StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, result.body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(result.content_type),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=30"),
    );
    response
}

async fn upload(State(state): State<PublicServerState>, req: Request) -> Response {
    let Some(expected) = state.upload_token.as_deref() else {
        return json_response(404, serde_json::json!({"error": "not_found"}));
    };
    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| constant_time_eq(token.as_bytes(), expected.as_bytes()));
    if !authorized {
        return json_response(401, serde_json::json!({"error": "unauthorized"}));
    }
    let id = req
        .uri()
        .path()
        .strip_prefix("/sfera/public/channels/")
        .unwrap_or_default()
        .to_string();
    if !social_paid::is_valid_channel_id(&id) {
        return json_response(404, serde_json::json!({"error": "not_found"}));
    }
    let body = match axum::body::to_bytes(req.into_body(), MAX_UPLOAD_BYTES).await {
        Ok(body) => body,
        Err(_) => return json_response(413, serde_json::json!({"error": "payload_too_large"})),
    };
    sync_json(&state, &id, &body)
}

fn sync_json(state: &PublicServerState, id: &str, body: &Bytes) -> Response {
    let incoming: PublicFeed = match serde_json::from_slice(body) {
        Ok(feed) => feed,
        Err(_) => return json_response(400, serde_json::json!({"error": "invalid_feed"})),
    };
    if incoming.channel.id != id {
        return json_response(400, serde_json::json!({"error": "channel_mismatch"}));
    }
    let _guard = match state.write_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return json_response(500, serde_json::json!({"error": "write_lock"})),
    };
    let mut catalog = match PublicCatalog::open_with_limit(&state.root, state.max_posts) {
        Ok(catalog) => catalog,
        Err(_) => return json_response(503, serde_json::json!({"error": "catalog_unavailable"})),
    };
    match catalog.sync_feed(incoming, state.max_posts) {
        Ok(report) => {
            let status = if report.inserted == 0 && report.duplicates > 0 { 200 } else { 201 };
            match serde_json::to_vec(&report) {
                Ok(body) => {
                    let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json; charset=utf-8"),
                    );
                    response
                }
                Err(_) => json_response(500, serde_json::json!({"error": "serialization"})),
            }
        }
        Err(CatalogError::CreatorMismatch) => {
            json_response(403, serde_json::json!({"error": "creator_mismatch"}))
        }
        Err(CatalogError::TooLarge(_)) => {
            json_response(413, serde_json::json!({"error": "feed_too_large"}))
        }
        Err(CatalogError::Feed(_)) => {
            json_response(422, serde_json::json!({"error": "signature_or_form_invalid"}))
        }
        Err(CatalogError::Io(_)) => {
            json_response(500, serde_json::json!({"error": "storage_failed"}))
        }
        Err(_) => json_response(400, serde_json::json!({"error": "invalid_feed"})),
    }
}

fn json_response(status: u16, value: serde_json::Value) -> Response {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(a ^ b);
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use social_paid::PublicChannel;
    use social_post::PostAudience;
    use social_rights::Audience;
    use tower::ServiceExt;

    const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000001";

    fn feed() -> PublicFeed {
        let channel = PublicChannel::create("pub-1", SEED, "Публичный", "Описание", 100).unwrap();
        let mut feed = PublicFeed::new(channel).unwrap();
        feed.publish(
            social_post::compose(
                SEED,
                100,
                "первый",
                PostAudience { id: "pub-1".into(), epoch: 1, spec: Audience::Public },
                vec![],
            )
            .unwrap(),
        )
        .unwrap();
        feed
    }

    async fn response(router: Router, request: HttpRequest<Body>) -> (u16, String) {
        let response = router.oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), MAX_UPLOAD_BYTES).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn upload_requires_auth_and_publishes_without_restart() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::env::set_var("SFERA_PUBLIC_UPLOAD_TOKEN", "test-token");
        let router = PublicServerState::from_env(&root).router();
        std::env::remove_var("SFERA_PUBLIC_UPLOAD_TOKEN");
        let body = serde_json::to_vec(&feed()).unwrap();

        let unauthorized = HttpRequest::put("/sfera/public/channels/pub-1")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.clone()))
            .unwrap();
        assert_eq!(response(router.clone(), unauthorized).await.0, 401);

        for expected_status in [201, 200] {
            let authorized = HttpRequest::put("/sfera/public/channels/pub-1")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.clone()))
                .unwrap();
            let (status, _) = response(router.clone(), authorized).await;
            assert_eq!(status, expected_status);
        }

        let get = HttpRequest::get("/sfera/public/channels/pub-1").body(Body::empty()).unwrap();
        let (status, body) = response(router, get).await;
        assert_eq!(status, 200);
        assert!(body.contains("первый"));
    }

    #[tokio::test]
    async fn upload_is_hidden_without_token() {
        let dir = tempfile::tempdir().unwrap();
        std::env::remove_var("SFERA_PUBLIC_UPLOAD_TOKEN");
        let router = PublicServerState::from_env(dir.path()).router();
        let request = HttpRequest::put("/sfera/public/channels/pub-1")
            .body(Body::from(serde_json::to_vec(&feed()).unwrap()))
            .unwrap();
        assert_eq!(response(router, request).await.0, 404);
    }
}
