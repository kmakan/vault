use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub allowed_origins: Vec<String>,
    // Push notification config (optional)
    pub fcm_project_id: Option<String>,
    pub vapid_public_key: Option<String>,
    pub vapid_private_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        let database_url = std::env::var("DATABASE_URL")
            .context("DATABASE_URL must be set")?;

        let jwt_secret = std::env::var("JWT_SECRET")
            .context("JWT_SECRET must be set")?;

        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:3000,http://localhost:8080".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        Ok(Config {
            host: std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "8081".to_string())
                .parse()?,
            database_url,
            jwt_secret,
            allowed_origins,
            fcm_project_id: std::env::var("FCM_PROJECT_ID").ok(),
            vapid_public_key: std::env::var("VAPID_PUBLIC_KEY").ok(),
            vapid_private_key: std::env::var("VAPID_PRIVATE_KEY").ok(),
        })
    }

    pub async fn create_db_pool(&self) -> Result<PgPool> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&self.database_url)
            .await?;
        Ok(pool)
    }
}