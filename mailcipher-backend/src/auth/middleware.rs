use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

use super::Claims;

#[derive(Debug, Clone)]
pub struct AuthExtractor {
    pub user_id: Uuid,
    pub email: String,
}

impl AuthExtractor {
    pub async fn extract_from_request(request: &mut axum::http::request::Parts) -> Result<Self, (StatusCode, String)> {
        let auth_header = request
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Missing authorization header".to_string()))?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Invalid authorization header format".to_string()))?;

        let secret = std::env::var("JWT_SECRET")
            .map_err(|_| (StatusCode::UNAUTHORIZED, "JWT_SECRET not configured".to_string()))?;
        let claims = Claims::from_token(token, &secret)
            .map_err(|e| (StatusCode::UNAUTHORIZED, format!("Invalid token: {}", e)))?;

        Ok(AuthExtractor {
            user_id: claims.sub,
            email: claims.email,
        })
    }
}

#[axum::async_trait]
impl<S> FromRequestParts<S> for AuthExtractor
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, String);

    async fn from_request_parts(parts: &mut axum::http::request::Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Self::extract_from_request(parts).await
    }
}

pub async fn auth_middleware(request: axum::extract::Request, next: Next) -> Result<Response, StatusCode> {
    let (parts, body) = request.into_parts();

    let auth_header = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    Claims::from_token(token, &secret).map_err(|_| StatusCode::UNAUTHORIZED)?;

    let request = axum::extract::Request::from_parts(parts, body);
    Ok(next.run(request).await)
}
