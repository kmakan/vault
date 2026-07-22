use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub base_url: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:9443".to_string(),
            access_token: None,
            refresh_token: None,
            email: None,
            server: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub username: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub user_id: Uuid,
    pub email: String,
    pub username: String,
    pub tokens: TokenPair,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chat {
    pub id: Uuid,
    pub user1_id: Uuid,
    pub user2_id: Uuid,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub chat_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub subject: Option<String>,
    pub content_type: Option<String>,
    pub is_read: bool,
    pub is_sent: bool,
    pub sent_at: Option<String>,
    pub received_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: Uuid,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateChatRequest {
    pub user2_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageRequest {
    pub content: String,
    pub subject: Option<String>,
    pub content_type: Option<String>,
}

pub struct ApiClient {
    client: Client,
    config: Config,
}

impl ApiClient {
    pub fn new(config: Config) -> Self {
        let client = Client::new();
        Self { client, config }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    fn auth_header(&self) -> Option<String> {
        self.config
            .access_token
            .as_ref()
            .map(|t| format!("Bearer {}", t))
    }

    pub async fn health_check(&self) -> Result<bool> {
        let url = format!("{}/health", self.config.base_url);
        let resp = self.client.get(&url).send().await?;
        Ok(resp.status().is_success())
    }

    pub async fn register(&mut self, email: &str, username: &str, password: &str) -> Result<()> {
        let url = format!("{}/api/auth/register", self.config.base_url);
        let body = RegisterRequest {
            email: email.to_string(),
            username: username.to_string(),
            password: password.to_string(),
        };
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("Failed to send register request")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Register failed ({}): {}", status, text);
        }

        let data: AuthResponse = resp
            .json()
            .await
            .context("Failed to parse register response")?;
        self.config.access_token = Some(data.tokens.access_token);
        self.config.refresh_token = Some(data.tokens.refresh_token);
        Ok(())
    }

    pub async fn login(&mut self, email: &str, password: &str) -> Result<()> {
        let url = format!("{}/api/auth/login", self.config.base_url);
        let body = LoginRequest {
            email: email.to_string(),
            password: password.to_string(),
        };
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("Failed to send login request")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Login failed ({}): {}", status, text);
        }

        let data: AuthResponse = resp
            .json()
            .await
            .context("Failed to parse login response")?;
        self.config.access_token = Some(data.tokens.access_token);
        self.config.refresh_token = Some(data.tokens.refresh_token);
        Ok(())
    }

    pub async fn get_chats(&self) -> Result<Vec<Chat>> {
        let url = format!("{}/api/chats", self.config.base_url);
        let mut req = self.client.get(&url);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await.context("Failed to fetch chats")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Get chats failed ({}): {}", status, text);
        }
        resp.json().await.context("Failed to parse chats")
    }

    pub async fn create_chat(&self, user2_id: &Uuid) -> Result<Chat> {
        let url = format!("{}/api/chats", self.config.base_url);
        let body = CreateChatRequest {
            user2_id: *user2_id,
        };
        let mut req = self.client.post(&url).json(&body);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await.context("Failed to create chat")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Create chat failed ({}): {}", status, text);
        }
        resp.json().await.context("Failed to parse created chat")
    }

    pub async fn get_chat(&self, chat_id: &Uuid) -> Result<Chat> {
        let url = format!("{}/api/chats/{}", self.config.base_url, chat_id);
        let mut req = self.client.get(&url);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await.context("Failed to fetch chat")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Get chat failed ({}): {}", status, text);
        }
        resp.json().await.context("Failed to parse chat")
    }

    pub async fn get_messages(&self, chat_id: &Uuid) -> Result<Vec<Message>> {
        let url = format!("{}/api/chats/{}/messages", self.config.base_url, chat_id);
        let mut req = self.client.get(&url);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await.context("Failed to fetch messages")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Get messages failed ({}): {}", status, text);
        }
        resp.json().await.context("Failed to parse messages")
    }

    pub async fn send_message(
        &self,
        chat_id: &Uuid,
        content: &str,
        subject: Option<&str>,
    ) -> Result<Message> {
        let url = format!("{}/api/chats/{}/messages", self.config.base_url, chat_id);
        let body = CreateMessageRequest {
            content: content.to_string(),
            subject: subject.map(|s| s.to_string()),
            content_type: Some("text/plain".to_string()),
        };
        let mut req = self.client.post(&url).json(&body);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await.context("Failed to send message")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Send message failed ({}): {}", status, text);
        }
        resp.json().await.context("Failed to parse sent message")
    }

    pub async fn get_groups(&self) -> Result<Vec<Group>> {
        let url = format!("{}/api/groups", self.config.base_url);
        let mut req = self.client.get(&url);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await.context("Failed to fetch groups")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Get groups failed ({}): {}", status, text);
        }
        resp.json().await.context("Failed to parse groups")
    }
}
