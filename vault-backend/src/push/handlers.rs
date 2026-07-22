use axum::{
    extract::State,
    http::StatusCode,
    Json,
};
use sqlx::PgPool;

use crate::auth::middleware::AuthExtractor;
use super::models::{PushTokenResponse, RegisterTokenRequest, UnregisterTokenRequest, VapidKeyResponse};
use super::PushService;

pub async fn register_token(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<RegisterTokenRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let service = PushService::new(pool)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    service
        .register_token(auth.user_id, &req.device_token, &req.platform)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::OK)
}

pub async fn unregister_token(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<UnregisterTokenRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let service = PushService::new(pool)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    service
        .unregister_token(auth.user_id, &req.device_token)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::OK)
}

pub async fn get_vapid_key() -> Result<Json<VapidKeyResponse>, (StatusCode, String)> {
    let public_key = std::env::var("VAPID_PUBLIC_KEY")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "VAPID_PUBLIC_KEY not configured".to_string()))?;

    Ok(Json(VapidKeyResponse { public_key }))
}

pub async fn delete_token(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<UnregisterTokenRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let service = PushService::new(pool)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    service
        .unregister_token(auth.user_id, &req.device_token)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_tokens(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
) -> Result<Json<Vec<PushTokenResponse>>, (StatusCode, String)> {
    let service = PushService::new(pool)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let tokens = service
        .get_tokens_by_user(auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let responses: Vec<PushTokenResponse> = tokens
        .into_iter()
        .map(|t| PushTokenResponse {
            id: t.id,
            platform: t.platform,
            created_at: t.created_at,
        })
        .collect();

    Ok(Json(responses))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_request_deserialize() {
        let json = r#"{"device_token":"abc123","platform":"android"}"#;
        let req: RegisterTokenRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.device_token, "abc123");
        assert_eq!(req.platform, Platform::Android);
    }

    #[test]
    fn test_unregister_request_deserialize() {
        let json = r#"{"device_token":"abc123"}"#;
        let req: UnregisterTokenRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.device_token, "abc123");
    }

    #[test]
    fn test_vapid_key_response_serialize() {
        let resp = VapidKeyResponse {
            public_key: "test_key".to_string(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("test_key"));
    }
}
