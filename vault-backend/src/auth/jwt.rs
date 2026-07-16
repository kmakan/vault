use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: Uuid,
    pub email: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

impl Claims {
    pub fn new(user_id: Uuid, email: &str) -> Self {
        let now = Utc::now();
        Claims {
            sub: user_id,
            email: email.to_string(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(24)).timestamp(),
        }
    }

    pub fn from_token(token: &str, secret: &str) -> Result<Self, jsonwebtoken::errors::Error> {
        let token_data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &Validation::default(),
        )?;
        Ok(token_data.claims)
    }
}

pub fn create_token_pair(user_id: Uuid, email: &str, secret: &str) -> Result<TokenPair, jsonwebtoken::errors::Error> {
    let access_claims = Claims::new(user_id, email);
    let access_token = encode(
        &Header::default(),
        &access_claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;

    let refresh_claims = Claims {
        sub: user_id,
        email: email.to_string(),
        iat: Utc::now().timestamp(),
        exp: (Utc::now() + Duration::days(30)).timestamp(),
    };
    let refresh_token = encode(
        &Header::default(),
        &refresh_claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;

    Ok(TokenPair {
        access_token,
        refresh_token,
    })
}
