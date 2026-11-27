//! Read-only HTTP-витрина публичных каналов.
//!
//! Запуск:
//!   SFERA_PUBLIC_ROOT=/path/to/sfera/public/channels \
//!   SFERA_PUBLIC_BIND=127.0.0.1:8095 social-public-serve
//!
//! Сервер ничего не расшифровывает и не пишет: он отдаёт проверенные
//! `PublicFeed` из каталога. Публикация — отдельный процесс/приложение,
//! которое пишет файлы витрины.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use social_public::{PublicCatalog, PUBLIC_ROOT};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var("SFERA_PUBLIC_ROOT").unwrap_or_else(|_| PUBLIC_ROOT.into());
    let bind = std::env::var("SFERA_PUBLIC_BIND").unwrap_or_else(|_| "127.0.0.1:8095".into());

    let catalog = Arc::new(PublicCatalog::open(&root)?);
    eprintln!(
        "social-public: {} channels from {root} on http://{bind}",
        catalog.len()
    );

    let app = Router::new()
        .fallback(serve_public)
        .with_state(catalog);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// Единственный обработчик: все правила пути живут в `PublicCatalog::handle`,
/// чтобы сервер и тесты не разъезжались.
async fn serve_public(State(catalog): State<Arc<PublicCatalog>>, req: Request) -> Response {
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
