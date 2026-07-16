use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use super::models::{Chat, ChatResponse, CreateChatRequest};

pub async fn list_chats(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
) -> Result<Json<Vec<ChatResponse>>, (StatusCode, String)> {
    let chats = sqlx::query_as::<_, Chat>(
        "SELECT * FROM chats WHERE user1_id = $1 OR user2_id = $1 ORDER BY updated_at DESC"
    )
    .bind(auth.user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(chats.into_iter().map(ChatResponse::from).collect()))
}

pub async fn create_chat(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<CreateChatRequest>,
) -> Result<(StatusCode, Json<ChatResponse>), (StatusCode, String)> {
    if req.user2_id == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "Cannot create chat with yourself".to_string()));
    }

    let user2_exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(req.user2_id)
        .fetch_one(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !user2_exists {
        return Err((StatusCode::NOT_FOUND, "User not found".to_string()));
    }

    let (user1_id, user2_id) = if auth.user_id < req.user2_id {
        (auth.user_id, req.user2_id)
    } else {
        (req.user2_id, auth.user_id)
    };

    let chat = sqlx::query_as::<_, Chat>(
        "INSERT INTO chats (user1_id, user2_id) VALUES ($1, $2) RETURNING *"
    )
    .bind(user1_id)
    .bind(user2_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate key") {
            (StatusCode::CONFLICT, "Chat already exists".to_string())
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    })?;

    Ok((StatusCode::CREATED, Json(ChatResponse::from(chat))))
}

pub async fn get_chat(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    let chat = sqlx::query_as::<_, Chat>(
        "SELECT * FROM chats WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)"
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match chat {
        Some(chat) => Ok(Json(ChatResponse::from(chat))),
        None => Err((StatusCode::NOT_FOUND, "Chat not found".to_string())),
    }
}
