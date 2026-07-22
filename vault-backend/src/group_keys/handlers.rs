use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct GroupKey {
    pub id: Uuid,
    pub group_id: Uuid,
    pub user_id: Uuid,
    pub encrypted_key: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct DistributeGroupKeyRequest {
    pub user_id: Uuid,
    pub encrypted_key: String,
}

#[derive(Debug, Serialize)]
pub struct GroupKeyResponse {
    pub group_id: Uuid,
    pub user_id: Uuid,
    pub encrypted_key: String,
    pub created_at: DateTime<Utc>,
}

/// Distribute encrypted group key to a member
/// Called by the group creator when adding a member
pub async fn distribute_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<DistributeGroupKeyRequest>,
) -> Result<(StatusCode, Json<GroupKeyResponse>), (StatusCode, String)> {
    // Verify the requester is a member of this group
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2)"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::FORBIDDEN, "Not a group member".to_string()));
    }

    // Upsert the encrypted key for the target user
    let key = sqlx::query_as::<_, GroupKey>(
        "INSERT INTO group_keys (group_id, user_id, encrypted_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, user_id) DO UPDATE SET encrypted_key = $3
         RETURNING *"
    )
    .bind(group_id)
    .bind(req.user_id)
    .bind(&req.encrypted_key)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(GroupKeyResponse {
        group_id: key.group_id,
        user_id: key.user_id,
        encrypted_key: key.encrypted_key,
        created_at: key.created_at,
    })))
}

/// Get my encrypted group key
/// The receiving client decrypts this with their private key to get the shared group key
pub async fn get_my_group_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Option<GroupKeyResponse>>, (StatusCode, String)> {
    let key = sqlx::query_as::<_, GroupKey>(
        "SELECT * FROM group_keys WHERE group_id = $1 AND user_id = $2"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(key.map(|k| GroupKeyResponse {
        group_id: k.group_id,
        user_id: k.user_id,
        encrypted_key: k.encrypted_key,
        created_at: k.created_at,
    })))
}

/// Get all group keys for a group (for the group creator to see who has keys)
pub async fn get_group_keys(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Vec<GroupKeyResponse>>, (StatusCode, String)> {
    // Verify the requester is a member of this group
    let member: Option<(Uuid,)> = sqlx::query_as(
        "SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if member.is_none() {
        return Err((StatusCode::FORBIDDEN, "Not a group member".to_string()));
    }

    let keys = sqlx::query_as::<_, GroupKey>(
        "SELECT * FROM group_keys WHERE group_id = $1 ORDER BY created_at ASC"
    )
    .bind(group_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(keys.into_iter().map(|k| GroupKeyResponse {
        group_id: k.group_id,
        user_id: k.user_id,
        encrypted_key: k.encrypted_key,
        created_at: k.created_at,
    }).collect()))
}
