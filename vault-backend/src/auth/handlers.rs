use axum::{extract::State, http::StatusCode, Json};
use argon2::{password_hash::{rand_core::OsRng, PasswordHasher, SaltString}, Argon2, PasswordHash, PasswordVerifier};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use super::jwt::{create_token_pair, TokenPair};

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub user_id: Uuid,
    pub email: String,
    pub username: String,
    pub tokens: TokenPair,
}

pub async fn register(
    State(pool): State<PgPool>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    let existing = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)")
        .bind(&req.email)
        .fetch_one(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if existing {
        return Err((StatusCode::CONFLICT, "Email already registered".to_string()));
    }

    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .to_string();

    let user = sqlx::query_as::<_, crate::models::User>(
        "INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING *"
    )
    .bind(&req.email)
    .bind(&req.username)
    .bind(&password_hash)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let secret = std::env::var("JWT_SECRET")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "JWT_SECRET not configured".to_string()))?;
    let tokens = create_token_pair(user.id, &user.email, &secret)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(AuthResponse {
        user_id: user.id,
        email: user.email,
        username: user.username,
        tokens,
    }))
}

pub async fn login(
    State(pool): State<PgPool>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    let user = sqlx::query_as::<_, crate::models::User>(
        "SELECT * FROM users WHERE email = $1"
    )
    .bind(&req.email)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let user = user.ok_or_else(|| (StatusCode::UNAUTHORIZED, "Invalid credentials".to_string()))?;

    let parsed_hash = PasswordHash::new(&user.password_hash)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Argon2::default()
        .verify_password(req.password.as_bytes(), &parsed_hash)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid credentials".to_string()))?;

    let secret = std::env::var("JWT_SECRET")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "JWT_SECRET not configured".to_string()))?;
    let tokens = create_token_pair(user.id, &user.email, &secret)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(AuthResponse {
        user_id: user.id,
        email: user.email,
        username: user.username,
        tokens,
    }))
}
