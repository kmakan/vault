use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use super::models::{
    SenderKeyResponse, DistributeKeyRequest, DistributionStatus, DistributionInfo,
};
use super::manager::SenderKeyManager;

/// Get sender keys for a group
pub async fn list_sender_keys(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Vec<SenderKeyResponse>>, (StatusCode, String)> {
    // Verify membership
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL)"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let keys = SenderKeyManager::get_group_sender_keys(&pool, group_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(keys.into_iter().map(SenderKeyResponse::from).collect()))
}

/// Get my sender key for a group
pub async fn get_my_sender_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Option<SenderKeyResponse>>, (StatusCode, String)> {
    let key = SenderKeyManager::get_sender_key(&pool, group_id, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(key.map(SenderKeyResponse::from)))
}

/// Initialize sender key for a group (called when joining)
pub async fn initialize_sender_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<InitializeKeyRequest>,
) -> Result<(StatusCode, Json<SenderKeyResponse>), (StatusCode, String)> {
    // Verify membership
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL)"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    // Check if key already exists
    let existing = SenderKeyManager::get_sender_key(&pool, group_id, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if existing.is_some() {
        return Err((StatusCode::CONFLICT, "Sender key already initialized".to_string()));
    }

    // For now, use a placeholder master key (in production, derive from user's password)
    let master_key = [0u8; 32]; // TODO: Get from user's key derivation

    let key = SenderKeyManager::create_sender_key(
        &pool,
        group_id,
        auth.user_id,
        &req.identity_public_key,
        &master_key,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(SenderKeyResponse::from(key))))
}

/// Distribute sender key to a member
pub async fn distribute_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<DistributeKeyRequest>,
) -> Result<(StatusCode, Json<DistributionInfo>), (StatusCode, String)> {
    // Verify sender has a key
    let sender_key = SenderKeyManager::get_sender_key(&pool, group_id, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "No sender key found. Initialize first.".to_string()))?;

    // Verify recipient is a member
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL)"
    )
    .bind(group_id)
    .bind(req.recipient_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Recipient not found or not a member".to_string()));
    }

    // Get recipient's identity key
    let recipient_key = sqlx::query_scalar::<_, String>(
        "SELECT identity_public_key FROM sender_keys WHERE group_id = $1 AND user_id = $2 AND is_active = TRUE LIMIT 1"
    )
    .bind(group_id)
    .bind(req.recipient_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if recipient_key.is_none() {
        return Err((StatusCode::BAD_REQUEST, "Recipient has not initialized their sender key".to_string()));
    }

    // TODO: In production, use sender's static secret to encrypt for recipient
    // For now, store a placeholder distribution record
    let distribution = sqlx::query_as::<_, DistributionInfo>(
        "INSERT INTO sender_key_distributions (group_id, sender_id, recipient_id, encrypted_chain_key, sender_identity_key, key_version, acknowledged)
         VALUES ($1, $2, $3, 'pending', $4, $5, FALSE)
         RETURNING recipient_id, acknowledged, key_version, created_at as distributed_at"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .bind(req.recipient_id)
    .bind(&sender_key.identity_public_key)
    .bind(sender_key.key_version)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(distribution)))
}

/// Get distribution status for a group
pub async fn distribution_status(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<DistributionStatus>, (StatusCode, String)> {
    // Verify membership
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL)"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let distributions = sqlx::query_as::<_, DistributionInfo>(
        "SELECT recipient_id, acknowledged, key_version, created_at as distributed_at
         FROM sender_key_distributions
         WHERE group_id = $1 AND sender_id = $2
         ORDER BY created_at DESC"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(DistributionStatus {
        group_id,
        distributions,
    }))
}

/// Acknowledge receipt of sender key
pub async fn acknowledge_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path((group_id, sender_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let result = sqlx::query(
        "UPDATE sender_key_distributions 
         SET acknowledged = TRUE 
         WHERE group_id = $1 AND sender_id = $2 AND recipient_id = $3 AND acknowledged = FALSE"
    )
    .bind(group_id)
    .bind(sender_id)
    .bind(auth.user_id)
    .execute(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Distribution not found or already acknowledged".to_string()));
    }

    Ok(StatusCode::OK)
}

/// Rotate sender key (ratchet)
pub async fn rotate_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<SenderKeyResponse>, (StatusCode, String)> {
    // Verify membership
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL)"
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    // TODO: Get master key from user context
    let master_key = [0u8; 32];

    let key = SenderKeyManager::ratchet_key(&pool, group_id, auth.user_id, &master_key)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(SenderKeyResponse::from(key)))
}

#[derive(Debug, Deserialize)]
pub struct InitializeKeyRequest {
    pub identity_public_key: String,
}
