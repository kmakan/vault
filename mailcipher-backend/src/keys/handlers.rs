use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use crate::crypto::{AlphaCipher, ColumnarCipher, CombinedEncryptor, seal, Ed25519Signer};
use super::models::{EncryptionKey, KeyResponse, CreateKeyRequest};

fn get_jwt_secret() -> Result<String, (StatusCode, String)> {
    std::env::var("JWT_SECRET")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "JWT_SECRET not configured".to_string()))
}

pub async fn list_keys(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
) -> Result<Json<Vec<KeyResponse>>, (StatusCode, String)> {
    let keys = sqlx::query_as::<_, EncryptionKey>(
        "SELECT * FROM encryption_keys WHERE user_id = $1 ORDER BY created_at DESC"
    )
    .bind(auth.user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(keys.into_iter().map(KeyResponse::from).collect()))
}

pub async fn create_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<CreateKeyRequest>,
) -> Result<(StatusCode, Json<KeyResponse>), (StatusCode, String)> {
    let jwt_secret = get_jwt_secret()?;

    // Validate key based on key_type
    let (alpha_encrypted, columnar_encrypted, combined_encrypted, ed25519_secret_encrypted, ed25519_public) = match req.key_type.as_str() {
        "alpha" => {
            if let Some(key) = &req.alpha_key {
                AlphaCipher::new(key)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                let enc = Some(seal(key, &jwt_secret).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?);
                (enc, None::<String>, None::<String>, None::<String>, None::<String>)
            } else {
                return Err((StatusCode::BAD_REQUEST, "alpha_key is required for alpha key_type".to_string()));
            }
        }
        "columnar" => {
            if let Some(key) = &req.columnar_key {
                ColumnarCipher::new(key)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                let enc = Some(seal(key, &jwt_secret).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?);
                (None::<String>, enc, None::<String>, None::<String>, None::<String>)
            } else {
                return Err((StatusCode::BAD_REQUEST, "columnar_key is required for columnar key_type".to_string()));
            }
        }
        "combined" => {
            if let (Some(alpha_key), Some(columnar_key)) = (&req.alpha_key, &req.columnar_key) {
                CombinedEncryptor::new(alpha_key, columnar_key)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                let alpha_enc = Some(seal(alpha_key, &jwt_secret).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?);
                let col_enc = Some(seal(columnar_key, &jwt_secret).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?);
                (alpha_enc, col_enc, None::<String>, None::<String>, None::<String>)
            } else {
                return Err((StatusCode::BAD_REQUEST, "alpha_key and columnar_key are required for combined key_type".to_string()));
            }
        }
        "ed25519" => {
            let keypair = Ed25519Signer::generate_keypair();
            let secret_enc = seal(
                &base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &keypair.secret_key),
                &jwt_secret
            ).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            let public = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &keypair.public_key);
            (None::<String>, None::<String>, None::<String>, Some(secret_enc), Some(public))
        }
        _ => {
            return Err((StatusCode::BAD_REQUEST, "Invalid key_type. Must be: alpha, columnar, combined, or ed25519".to_string()));
        }
    };

    let key = sqlx::query_as::<_, EncryptionKey>(
        r#"
        INSERT INTO encryption_keys (user_id, key_type, alpha_key_encrypted, columnar_key_encrypted, combined_key_encrypted, ed25519_secret_key_encrypted, ed25519_public_key, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        "#
    )
    .bind(auth.user_id)
    .bind(&req.key_type)
    .bind(&alpha_encrypted)
    .bind(&columnar_encrypted)
    .bind(&combined_encrypted)
    .bind(&ed25519_secret_encrypted)
    .bind(&ed25519_public)
    .bind(req.expires_at)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(KeyResponse::from(key))))
}

pub async fn delete_key(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(key_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let result = sqlx::query("DELETE FROM encryption_keys WHERE id = $1 AND user_id = $2")
        .bind(key_id)
        .bind(auth.user_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Key not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}