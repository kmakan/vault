use once_cell::sync::Lazy;
use reqwest::Client;
use std::env;

static BASE_URL: Lazy<String> = Lazy::new(|| {
    env::var("TEST_API_URL").unwrap_or_else(|_| "http://localhost:8080".to_string())
});

pub struct TestContext {
    pub client: Client,
    pub base_url: String,
}

impl TestContext {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            base_url: BASE_URL.clone(),
        }
    }

    pub fn auth_header(&self, token: &str) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", token).parse().unwrap(),
        );
        headers
    }
}

pub struct TestUser {
    pub user_id: String,
    pub email: String,
    pub username: String,
    pub access_token: String,
    pub refresh_token: String,
}

impl TestUser {
    pub async fn register(ctx: &TestContext, suffix: &str) -> Self {
        let email = format!("test-{}@example.com", suffix);
        let username = format!("user_{}", suffix);
        let password = "SecurePass123!";

        let resp = ctx
            .client
            .post(format!("{}/api/auth/register", ctx.base_url))
            .json(&serde_json::json!({
                "email": email,
                "username": username,
                "password": password,
            }))
            .send()
            .await
            .expect("Failed to send register request");

        assert_eq!(resp.status().as_u16(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();

        Self {
            user_id: body["user_id"].as_str().unwrap().to_string(),
            email,
            username,
            access_token: body["tokens"]["access_token"].as_str().unwrap().to_string(),
            refresh_token: body["tokens"]["refresh_token"].as_str().unwrap().to_string(),
        }
    }

    pub async fn login(ctx: &TestContext, email: &str, password: &str) -> Self {
        let resp = ctx
            .client
            .post(format!("{}/api/auth/login", ctx.base_url))
            .json(&serde_json::json!({
                "email": email,
                "password": password,
            }))
            .send()
            .await
            .expect("Failed to send login request");

        assert_eq!(resp.status().as_u16(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();

        Self {
            user_id: body["user_id"].as_str().unwrap().to_string(),
            email: email.to_string(),
            username: body["username"].as_str().unwrap().to_string(),
            access_token: body["tokens"]["access_token"].as_str().unwrap().to_string(),
            refresh_token: body["tokens"]["refresh_token"].as_str().unwrap().to_string(),
        }
    }
}
