use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::middleware::AuthExtractor;

#[derive(Debug, Deserialize)]
pub struct UploadAvatarRequest {
    pub email: String,
    pub avatar: String, // base64 data URL
}

#[derive(Debug, Serialize)]
pub struct AvatarResponse {
    pub avatar_url: Option<String>,
}

/// POST /api/avatar — upload or update avatar for the authenticated user
pub async fn upload_avatar(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<UploadAvatarRequest>,
) -> Result<Json<AvatarResponse>, (StatusCode, String)> {
    // Only allow uploading your own avatar
    if req.email != auth.email {
        return Err((StatusCode::FORBIDDEN, "Can only upload your own avatar".to_string()));
    }

    // Validate it's a data URL
    if !req.avatar.starts_with("data:image/") {
        return Err((StatusCode::BAD_REQUEST, "Avatar must be a base64 data URL".to_string()));
    }

    // Validate size (rough check: base64 overhead ~33%, so 500KB raw ≈ 667KB base64)
    if req.avatar.len() > 700_000 {
        return Err((StatusCode::BAD_REQUEST, "Avatar too large (max 500KB)".to_string()));
    }

    let result = sqlx::query("UPDATE users SET avatar_url = $1 WHERE id = $2")
        .bind(&req.avatar)
        .bind(auth.user_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "User not found".to_string()));
    }

    Ok(Json(AvatarResponse {
        avatar_url: Some(req.avatar),
    }))
}

/// GET /api/avatar/:email — get avatar URL for any user
pub async fn get_avatar(
    State(pool): State<PgPool>,
    Path(email): Path<String>,
) -> Result<Json<AvatarResponse>, (StatusCode, String)> {
    let avatar_url = sqlx::query_scalar::<_, Option<String>>(
        "SELECT avatar_url FROM users WHERE email = $1",
    )
    .bind(&email)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // fetch_optional returns Option<Option<String>>: outer = row exists, inner = NULL
    let avatar_url = avatar_url.flatten();

    Ok(Json(AvatarResponse { avatar_url }))
}

/// DELETE /api/avatar/:email — remove avatar for the authenticated user
pub async fn delete_avatar(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(email): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Only allow deleting your own avatar
    if email != auth.email {
        return Err((StatusCode::FORBIDDEN, "Can only delete your own avatar".to_string()));
    }

    let result = sqlx::query("UPDATE users SET avatar_url = NULL WHERE id = $1")
        .bind(auth.user_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "User not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}
