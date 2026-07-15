mod common;

use common::{TestContext, TestUser};

#[tokio::test]
async fn test_create_chat_success() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;

    let resp = ctx
        .client
        .post(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "user2_id": user2.user_id,
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["id"].as_str().is_some());
    assert_eq!(body["user1_id"].as_str().unwrap(), user1.user_id);
    assert_eq!(body["user2_id"].as_str().unwrap(), user2.user_id);
}

#[tokio::test]
async fn test_create_chat_with_self() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;

    let resp = ctx
        .client
        .post(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user.access_token))
        .json(&serde_json::json!({
            "user2_id": user.user_id,
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 400);
}

#[tokio::test]
async fn test_create_chat_nonexistent_user() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;
    let fake_id = uuid::Uuid::new_v4().to_string();

    let resp = ctx
        .client
        .post(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user.access_token))
        .json(&serde_json::json!({
            "user2_id": fake_id,
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 404);
}

#[tokio::test]
async fn test_list_chats() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;

    let _ = ctx
        .client
        .post(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "user2_id": user2.user_id,
        }))
        .send()
        .await
        .unwrap();

    let resp = ctx
        .client
        .get(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_array());
    assert!(!body.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_get_chat() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;

    let create_resp = ctx
        .client
        .post(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "user2_id": user2.user_id,
        }))
        .send()
        .await
        .unwrap();

    let chat_id = create_resp.json::<serde_json::Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let resp = ctx
        .client
        .get(format!("{}/api/chats/{}", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["id"].as_str().unwrap(), chat_id);
}

#[tokio::test]
async fn test_get_chat_not_found() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();
    let fake_id = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;

    let resp = ctx
        .client
        .get(format!("{}/api/chats/{}", ctx.base_url, fake_id))
        .headers(ctx.auth_header(&user.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 404);
}

#[tokio::test]
async fn test_get_chat_unauthorized_user() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();
    let suffix3 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let user3 = TestUser::register(&ctx, &suffix3).await;

    let create_resp = ctx
        .client
        .post(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "user2_id": user2.user_id,
        }))
        .send()
        .await
        .unwrap();

    let chat_id = create_resp.json::<serde_json::Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let resp = ctx
        .client
        .get(format!("{}/api/chats/{}", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user3.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 404);
}

#[tokio::test]
async fn test_unauthenticated_access() {
    let ctx = TestContext::new();

    let resp = ctx
        .client
        .get(format!("{}/api/chats", ctx.base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 401);
}

#[tokio::test]
async fn test_invalid_token() {
    let ctx = TestContext::new();

    let resp = ctx
        .client
        .get(format!("{}/api/chats", ctx.base_url))
        .headers(ctx.auth_header("invalid.token.here"))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 401);
}
