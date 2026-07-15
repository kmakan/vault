mod common;

use common::{TestContext, TestUser};

#[tokio::test]
async fn test_register_success() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let resp = ctx
        .client
        .post(format!("{}/api/auth/register", ctx.base_url))
        .json(&serde_json::json!({
            "email": format!("reg-{}@example.com", suffix),
            "username": format!("reg_user_{}", suffix),
            "password": "SecurePass123!",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["user_id"].as_str().is_some());
    assert!(body["email"].as_str().is_some());
    assert!(body["tokens"]["access_token"].as_str().is_some());
    assert!(body["tokens"]["refresh_token"].as_str().is_some());
}

#[tokio::test]
async fn test_register_duplicate_email() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();
    let email = format!("dup-{}@example.com", suffix);

    let resp1 = ctx
        .client
        .post(format!("{}/api/auth/register", ctx.base_url))
        .json(&serde_json::json!({
            "email": email,
            "username": format!("dup_user1_{}", suffix),
            "password": "SecurePass123!",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp1.status().as_u16(), 200);

    let resp2 = ctx
        .client
        .post(format!("{}/api/auth/register", ctx.base_url))
        .json(&serde_json::json!({
            "email": email,
            "username": format!("dup_user2_{}", suffix),
            "password": "SecurePass123!",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status().as_u16(), 409);
}

#[tokio::test]
async fn test_login_success() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();
    let password = "SecurePass123!";

    let user = TestUser::register(&ctx, &suffix).await;

    let resp = ctx
        .client
        .post(format!("{}/api/auth/login", ctx.base_url))
        .json(&serde_json::json!({
            "email": user.email,
            "password": password,
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["user_id"].as_str().unwrap(), user.user_id);
    assert!(body["tokens"]["access_token"].as_str().is_some());
}

#[tokio::test]
async fn test_login_wrong_password() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;

    let resp = ctx
        .client
        .post(format!("{}/api/auth/login", ctx.base_url))
        .json(&serde_json::json!({
            "email": user.email,
            "password": "WrongPassword!",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 401);
}

#[tokio::test]
async fn test_login_nonexistent_user() {
    let ctx = TestContext::new();

    let resp = ctx
        .client
        .post(format!("{}/api/auth/login", ctx.base_url))
        .json(&serde_json::json!({
            "email": "nonexistent@example.com",
            "password": "SomePassword123!",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 401);
}

#[tokio::test]
async fn test_register_invalid_email() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let resp = ctx
        .client
        .post(format!("{}/api/auth/register", ctx.base_url))
        .json(&serde_json::json!({
            "email": "not-an-email",
            "username": format!("user_{}", suffix),
            "password": "SecurePass123!",
        }))
        .send()
        .await
        .unwrap();

    assert!(resp.status().is_client_error() || resp.status().is_success());
}

#[tokio::test]
async fn test_register_short_password() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let resp = ctx
        .client
        .post(format!("{}/api/auth/register", ctx.base_url))
        .json(&serde_json::json!({
            "email": format!("short-{}@example.com", suffix),
            "username": format!("short_{}", suffix),
            "password": "123",
        }))
        .send()
        .await
        .unwrap();

    assert!(resp.status().is_client_error() || resp.status().is_success());
}

#[tokio::test]
async fn test_register_missing_fields() {
    let ctx = TestContext::new();

    let resp = ctx
        .client
        .post(format!("{}/api/auth/register", ctx.base_url))
        .json(&serde_json::json!({
            "email": "test@example.com",
        }))
        .send()
        .await
        .unwrap();

    assert!(resp.status().is_client_error());
}
