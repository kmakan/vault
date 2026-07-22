use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use crate::crypto::{AlphaCipher, ColumnarCipher, CombinedEncryptor, CombinedDecryptor, add_noise, remove_noise, Ed25519Signer, verify_signature};
use super::models::{CreateMessageRequest, Message, MessageResponse};

pub async fn list_messages(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<Vec<MessageResponse>>, (StatusCode, String)> {
    let chat = sqlx::query_as::<_, crate::chats::models::Chat>(
        "SELECT * FROM chats WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)"
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if chat.is_none() {
        return Err((StatusCode::NOT_FOUND, "Chat not found".to_string()));
    }

    // Messages are E2E encrypted by the frontend — backend stores and returns as-is
    let messages = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC, id ASC"
    )
    .bind(chat_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let message_responses: Vec<MessageResponse> = messages.into_iter().map(MessageResponse::from).collect();
    Ok(Json(message_responses))
}

pub async fn create_message(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<MessageResponse>), (StatusCode, String)> {
    let chat = sqlx::query_as::<_, crate::chats::models::Chat>(
        "SELECT * FROM chats WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)"
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let chat = chat.ok_or_else(|| (StatusCode::NOT_FOUND, "Chat not found".to_string()))?;

    let content_type = req.content_type.unwrap_or_else(|| "text/plain".to_string());

    // Store the content as-is — frontend handles E2E encryption (X25519 + XChaCha20)
    // Backend does NOT re-encrypt to avoid double-encryption issues
    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (sender_id, chat_id, subject, content_type, encrypted_content, is_sent, sent_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW()) RETURNING *"
    )
    .bind(auth.user_id)
    .bind(chat_id)
    .bind(&req.subject)
    .bind(&content_type)
    .bind(&req.content)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query("UPDATE chats SET updated_at = NOW() WHERE id = $1")
        .bind(chat_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(MessageResponse::from(message))))
}

pub async fn list_group_messages(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Vec<MessageResponse>>, (StatusCode, String)> {
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let messages = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE group_id = $1 ORDER BY created_at ASC, id ASC"
    )
    .bind(group_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let message_responses: Vec<MessageResponse> = messages.into_iter().map(MessageResponse::from).collect();
    Ok(Json(message_responses))
}

pub async fn create_group_message(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<MessageResponse>), (StatusCode, String)> {
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let content_type = req.content_type.unwrap_or_else(|| "text/plain".to_string());

    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (sender_id, group_id, subject, content_type, encrypted_content, is_sent, sent_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW()) RETURNING *"
    )
    .bind(auth.user_id)
    .bind(group_id)
    .bind(&req.subject)
    .bind(&content_type)
    .bind(&req.content)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(MessageResponse::from(message))))
}
