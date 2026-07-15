use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use super::models::{EmailAccount, EmailAccountResponse, CreateEmailAccountRequest};

pub async fn list_email_accounts(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
) -> Result<Json<Vec<EmailAccountResponse>>, (StatusCode, String)> {
    let accounts = sqlx::query_as::<_, EmailAccount>(
        "SELECT * FROM email_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC"
    )
    .bind(auth.user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(accounts.into_iter().map(EmailAccountResponse::from).collect()))
}

pub async fn create_email_account(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<CreateEmailAccountRequest>,
) -> Result<(StatusCode, Json<EmailAccountResponse>), (StatusCode, String)> {
    let imap_port = req.imap_port.unwrap_or(993);
    let smtp_port = req.smtp_port.unwrap_or(587);
    let use_tls = req.use_tls.unwrap_or(true);
    let is_default = req.is_default.unwrap_or(false);

    // If this is marked as default, unset other defaults
    if is_default {
        sqlx::query("UPDATE email_accounts SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE")
            .bind(auth.user_id)
            .execute(&pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let account = sqlx::query_as::<_, EmailAccount>(
        "INSERT INTO email_accounts (user_id, email, imap_server, imap_port, smtp_server, smtp_port, username, password_encrypted, use_tls, is_default) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
         RETURNING *"
    )
    .bind(auth.user_id)
    .bind(&req.email)
    .bind(&req.imap_server)
    .bind(imap_port)
    .bind(&req.smtp_server)
    .bind(smtp_port)
    .bind(&req.username)
    .bind(&req.password_encrypted)
    .bind(use_tls)
    .bind(is_default)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate key") {
            (StatusCode::CONFLICT, "Email account already exists".to_string())
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    })?;

    Ok((StatusCode::CREATED, Json(EmailAccountResponse::from(account))))
}

pub async fn delete_email_account(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(account_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let result = sqlx::query("DELETE FROM email_accounts WHERE id = $1 AND user_id = $2")
        .bind(account_id)
        .bind(auth.user_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Email account not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}