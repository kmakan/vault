//! HTTP-витрина публичных каналов.
//!
//! Запуск:
//!   SFERA_PUBLIC_ROOT=/path/to/sfera/public/channels \
//!   SFERA_PUBLIC_BIND=127.0.0.1:8095 social-public-serve
//!
//! Чтение открыто. Upload включается только явным
//! SFERA_PUBLIC_UPLOAD_TOKEN и принимает подписанный PublicFeed через
//! PUT /sfera/public/channels/{id} с Authorization: Bearer <token>.

use social_public::server::PublicServerState;
use social_public::PUBLIC_ROOT;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var("SFERA_PUBLIC_ROOT").unwrap_or_else(|_| PUBLIC_ROOT.into());
    let bind = std::env::var("SFERA_PUBLIC_BIND").unwrap_or_else(|_| "127.0.0.1:8095".into());
    let app = PublicServerState::from_env(&root).router();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("social-public: serving {root} on http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
