use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;

#[derive(Debug, Deserialize)]
pub struct UploadGroupAvatarRequest {
    pub avatar: String, // base64 data URL
}

#[derive(Debug, Serialize)]
pub struct GroupAvatarResponse {
    pub avatar_url: Option<String>,
}

/// POST /api/groups/:group_id/avatar — upload group avatar (admin/owner only)
pub async fn upload_group_avatar(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<UploadGroupAvatarRequest>,
) -> Result<Json<GroupAvatarResponse>, (StatusCode, String)> {
    // Check user is admin or owner
    let is_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND role IN ('admin', 'owner') AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_admin {
        return Err((StatusCode::FORBIDDEN, "Only admins can update group avatar".to_string()));
    }

    // Validate data URL
    if !req.avatar.starts_with("data:image/") {
        return Err((StatusCode::BAD_REQUEST, "Avatar must be a base64 data URL".to_string()));
    }

    if req.avatar.len() > 700_000 {
        return Err((StatusCode::BAD_REQUEST, "Avatar too large (max 500KB)".to_string()));
    }

    let result = sqlx::query("UPDATE groups SET avatar_url = $1 WHERE id = $2")
        .bind(&req.avatar)
        .bind(group_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Group not found".to_string()));
    }

    Ok(Json(GroupAvatarResponse {
        avatar_url: Some(req.avatar),
    }))
}

/// DELETE /api/groups/:group_id/avatar — remove group avatar (admin/owner only)
pub async fn delete_group_avatar(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let is_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND role IN ('admin', 'owner') AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_admin {
        return Err((StatusCode::FORBIDDEN, "Only admins can update group avatar".to_string()));
    }

    let result = sqlx::query("UPDATE groups SET avatar_url = NULL WHERE id = $1")
        .bind(group_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Group not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}
