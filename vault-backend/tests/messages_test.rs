mod common;

use common::{TestContext, TestUser};

async fn create_chat_between(ctx: &TestContext, user1: &TestUser, user2: &TestUser) -> String {
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

    resp.json::<serde_json::Value>()
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn test_send_message_success() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let resp = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "content": "Hello, this is a test message!",
            "subject": "Test Subject",
            "content_type": "text/plain",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["id"].as_str().is_some());
    assert_eq!(body["sender_id"].as_str().unwrap(), user1.user_id);
    assert_eq!(body["chat_id"].as_str().unwrap(), chat_id);
    assert_eq!(body["subject"].as_str().unwrap(), "Test Subject");
}

#[tokio::test]
async fn test_send_message_no_subject() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let resp = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "content": "No subject message",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["id"].as_str().is_some());
}

#[tokio::test]
async fn test_list_messages() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let _ = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "content": "Message 1",
            "subject": "Subject 1",
        }))
        .send()
        .await
        .unwrap();

    let _ = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user2.access_token))
        .json(&serde_json::json!({
            "content": "Message 2",
            "subject": "Subject 2",
        }))
        .send()
        .await
        .unwrap();

    let resp = ctx
        .client
        .get(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_array());
    let messages = body.as_array().unwrap();
    assert!(messages.len() >= 2);
}

#[tokio::test]
async fn test_list_messages_chat_not_found() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();
    let fake_id = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;

    let resp = ctx
        .client
        .get(format!("{}/api/chats/{}/messages", ctx.base_url, fake_id))
        .headers(ctx.auth_header(&user.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 404);
}

#[tokio::test]
async fn test_message_ordering() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    for i in 0..5 {
        let _ = ctx
            .client
            .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
            .headers(ctx.auth_header(&user1.access_token))
            .json(&serde_json::json!({
                "content": format!("Message {}", i),
            }))
            .send()
            .await
            .unwrap();
    }

    let resp = ctx
        .client
        .get(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .send()
        .await
        .unwrap();

    let body: serde_json::Value = resp.json().await.unwrap();
    let messages = body.as_array().unwrap();
    assert_eq!(messages.len(), 5);

    for i in 0..5 {
        assert!(messages[i]["id"].as_str().is_some());
    }
}

#[tokio::test]
async fn test_encryption_with_key() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let key_resp = ctx
        .client
        .post(format!("{}/api/keys", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "key_type": "combined",
            "alpha_key": "SECRET",
            "columnar_key": "4321",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(key_resp.status().as_u16(), 201);

    let msg_resp = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "content": "Encrypted message content",
            "subject": "Encrypted Subject",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(msg_resp.status().as_u16(), 201);
    let msg_body: serde_json::Value = msg_resp.json().await.unwrap();
    assert!(msg_body["id"].as_str().is_some());

    let list_resp = ctx
        .client
        .get(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .send()
        .await
        .unwrap();
    assert_eq!(list_resp.status().as_u16(), 200);
    let list_body: serde_json::Value = list_resp.json().await.unwrap();
    let messages = list_body.as_array().unwrap();
    assert!(!messages.is_empty());
}

#[tokio::test]
async fn test_encryption_alpha_key() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let _ = ctx
        .client
        .post(format!("{}/api/keys", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "key_type": "alpha",
            "alpha_key": "MAGIC",
        }))
        .send()
        .await
        .unwrap();

    let resp = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "content": "Alpha cipher test",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 201);
}

#[tokio::test]
async fn test_encryption_columnar_key() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let _ = ctx
        .client
        .post(format!("{}/api/keys", ctx.base_url))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "key_type": "columnar",
            "columnar_key": "3124",
        }))
        .send()
        .await
        .unwrap();

    let resp = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user1.access_token))
        .json(&serde_json::json!({
            "content": "Columnar cipher test",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 201);
}

#[tokio::test]
async fn test_key_create_invalid() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;

    let resp = ctx
        .client
        .post(format!("{}/api/keys", ctx.base_url))
        .headers(ctx.auth_header(&user.access_token))
        .json(&serde_json::json!({
            "key_type": "invalid_type",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 400);
}

#[tokio::test]
async fn test_key_list() {
    let ctx = TestContext::new();
    let suffix = uuid::Uuid::new_v4().to_string();

    let user = TestUser::register(&ctx, &suffix).await;

    let _ = ctx
        .client
        .post(format!("{}/api/keys", ctx.base_url))
        .headers(ctx.auth_header(&user.access_token))
        .json(&serde_json::json!({
            "key_type": "alpha",
            "alpha_key": "TESTKEY",
        }))
        .send()
        .await
        .unwrap();

    let resp = ctx
        .client
        .get(format!("{}/api/keys", ctx.base_url))
        .headers(ctx.auth_header(&user.access_token))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_array());
    assert!(!body.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_message_to_chat_not_member() {
    let ctx = TestContext::new();
    let suffix1 = uuid::Uuid::new_v4().to_string();
    let suffix2 = uuid::Uuid::new_v4().to_string();
    let suffix3 = uuid::Uuid::new_v4().to_string();

    let user1 = TestUser::register(&ctx, &suffix1).await;
    let user2 = TestUser::register(&ctx, &suffix2).await;
    let user3 = TestUser::register(&ctx, &suffix3).await;
    let chat_id = create_chat_between(&ctx, &user1, &user2).await;

    let resp = ctx
        .client
        .post(format!("{}/api/chats/{}/messages", ctx.base_url, chat_id))
        .headers(ctx.auth_header(&user3.access_token))
        .json(&serde_json::json!({
            "content": "Unauthorized message",
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 404);
}
