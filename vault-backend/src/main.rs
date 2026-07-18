use axum::{routing::{delete, get, post}, Extension, Router};
use tower_http::cors::{AllowHeaders, AllowMethods, CorsLayer};
use tracing_subscriber::EnvFilter;

use ws::WsState;

mod auth;
mod avatar;
mod chats;
mod config;
mod crypto;
mod email;
mod email_accounts;
mod error;
mod groups;
mod keys;
mod messages;
mod models;
mod push;
mod sender_keys;
mod ws;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = config::Config::from_env()?;
    let addr = format!("{}:{}", config.host, config.port);

    let pool = config.create_db_pool().await?;
    let ws_state = WsState::new();
    tracing::info!("Connected to PostgreSQL");

    let origins: Vec<_> = config.allowed_origins.iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(AllowMethods::any())
        .allow_headers(AllowHeaders::any());

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::handler::ws_handler))
        .route("/api/auth/register", post(auth::handlers::register))
        .route("/api/auth/login", post(auth::handlers::login))
        .route("/api/chats", get(chats::handlers::list_chats).post(chats::handlers::create_chat))
        .route("/api/chats/:chat_id", get(chats::handlers::get_chat))
        .route("/api/chats/:chat_id/messages", get(messages::handlers::list_messages).post(messages::handlers::create_message))
        .route("/api/groups", get(groups::handlers::list_groups).post(groups::handlers::create_group))
        .route("/api/groups/:group_id", get(groups::handlers::get_group))
        .route("/api/groups/:group_id/members", post(groups::handlers::add_member))
        .route("/api/groups/:group_id/messages", get(messages::handlers::list_group_messages).post(messages::handlers::create_group_message))
        .route("/api/email-accounts", get(email_accounts::handlers::list_email_accounts).post(email_accounts::handlers::create_email_account))
        .route("/api/email-accounts/:account_id", delete(email_accounts::handlers::delete_email_account))
        .route("/api/email-accounts/:account_id/emails", post(email::handlers::fetch_emails))
        .route("/api/email-accounts/:account_id/emails/:uid", get(email::handlers::fetch_email_body))
        .route("/api/email-accounts/:account_id/emails/send", post(email::handlers::send_email))
        .route("/api/keys", get(keys::handlers::list_keys).post(keys::handlers::create_key))
        .route("/api/keys/:key_id", delete(keys::handlers::delete_key))
        .route("/api/push/register", post(push::handlers::register_token))
        .route("/api/push/unregister", post(push::handlers::unregister_token))
        .route("/api/push/vapid-key", get(push::handlers::get_vapid_key))
        .route("/api/push/token", delete(push::handlers::delete_token))
        .route("/api/push/tokens", get(push::handlers::list_tokens))
        .route("/api/avatar", post(avatar::handlers::upload_avatar))
        .route("/api/avatar/:email", get(avatar::handlers::get_avatar).delete(avatar::handlers::delete_avatar))
        .route("/api/groups/:group_id/avatar", post(avatar::group_handlers::upload_group_avatar).delete(avatar::group_handlers::delete_group_avatar))
        .layer(cors)
        .layer(Extension(ws_state))
        .with_state(pool);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("MailCipher backend listening on {}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "OK"
}