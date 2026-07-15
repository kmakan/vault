use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use crate::email_accounts::models::EmailAccount;
use super::imap::ImapClient;
use super::smtp::SmtpClient;

#[derive(Debug, Deserialize)]
pub struct SendEmailRequest {
    pub to: String,
    pub subject: String,
    pub body: String,
    pub is_html: Option<bool>,
    pub reply_to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EmailResponse {
    pub uid: u32,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub is_read: bool,
}

#[derive(Debug, Deserialize)]
pub struct FetchEmailsParams {
    pub limit: Option<u32>,
    pub folder: Option<String>,
}

async fn get_account(
    pool: &PgPool,
    user_id: Uuid,
    account_id: Uuid,
) -> Result<EmailAccount, (StatusCode, String)> {
    sqlx::query_as::<_, EmailAccount>(
        "SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2"
    )
    .bind(account_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "Email account not found".to_string()))
}

pub async fn fetch_emails(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(account_id): Path<Uuid>,
    Json(params): Json<FetchEmailsParams>,
) -> Result<Json<Vec<EmailResponse>>, (StatusCode, String)> {
    let account = get_account(&pool, auth.user_id, account_id).await?;
    let folder = params.folder.unwrap_or_else(|| "INBOX".to_string());
    let limit = params.limit.unwrap_or(50);

    let mut client = ImapClient::new(
        &account.imap_server,
        account.imap_port as u16,
        &account.username,
        &account.password_encrypted,
        account.use_tls,
    );

    client.connect().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("IMAP connect failed: {}", e)))?;

    let emails = client.fetch_messages(&folder, Some(limit)).await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("IMAP fetch failed: {}", e)))?;

    client.disconnect().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("IMAP disconnect failed: {}", e)))?;

    let result: Vec<EmailResponse> = emails.into_iter().map(|e| EmailResponse {
        uid: e.uid,
        subject: e.subject,
        from: e.from,
        date: e.date,
        body: e.body,
        is_read: e.is_read,
    }).collect();

    Ok(Json(result))
}

pub async fn fetch_email_body(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path((account_id, uid)): Path<(Uuid, u32)>,
) -> Result<Json<EmailResponse>, (StatusCode, String)> {
    let account = get_account(&pool, auth.user_id, account_id).await?;

    let mut client = ImapClient::new(
        &account.imap_server,
        account.imap_port as u16,
        &account.username,
        &account.password_encrypted,
        account.use_tls,
    );

    client.connect().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("IMAP connect failed: {}", e)))?;

    client.select_mailbox("INBOX").await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Failed to select mailbox: {}", e)))?;

    let body = client.fetch_message_body(uid).await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("IMAP fetch body failed: {}", e)))?;

    client.disconnect().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("IMAP disconnect failed: {}", e)))?;

    Ok(Json(EmailResponse {
        uid,
        subject: None,
        from: None,
        date: None,
        body,
        is_read: true,
    }))
}

pub async fn send_email(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(account_id): Path<Uuid>,
    Json(req): Json<SendEmailRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let account = get_account(&pool, auth.user_id, account_id).await?;

    let mut client = SmtpClient::new(
        &account.smtp_server,
        account.smtp_port as u16,
        &account.username,
        &account.password_encrypted,
        account.use_tls,
    );

    client.connect().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("SMTP connect failed: {}", e)))?;

    let to_addrs: Vec<&str> = req.to.split(',').map(|s| s.trim()).collect();
    let is_html = req.is_html.unwrap_or(false);

    client.send_email(&account.email, &to_addrs, &req.subject, &req.body, is_html).await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("SMTP send failed: {}", e)))?;

    client.disconnect().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("SMTP disconnect failed: {}", e)))?;

    Ok(Json(serde_json::json!({
        "status": "sent",
        "to": req.to,
        "subject": req.subject,
    })))
}
