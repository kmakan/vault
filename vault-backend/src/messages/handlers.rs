use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use crate::crypto::{AlphaCipher, ColumnarCipher, CombinedEncryptor, CombinedDecryptor, add_noise, remove_noise, Ed25519Signer, verify_signature};
use super::models::{CreateMessageRequest, Message, MessageResponse};

pub async fn list_messages(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<Vec<MessageResponse>>, (StatusCode, String)> {
    let chat = sqlx::query_as::<_, crate::chats::models::Chat>(
        "SELECT * FROM chats WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)"
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if chat.is_none() {
        return Err((StatusCode::NOT_FOUND, "Chat not found".to_string()));
    }

    let messages = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC"
    )
    .bind(chat_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Decrypt messages
    let mut decrypted_messages = Vec::new();
    for msg in messages {
        let msg_response = MessageResponse::from(msg.clone());
        
        // Try to decrypt if encrypted_content exists
        if let Some(encrypted_content) = &msg.encrypted_content {
            // Remove noise from encrypted content
            let cleaned_content = match remove_noise(encrypted_content) {
                Ok(content) => content,
                Err(_) => encrypted_content.clone(),
            };

            // Get sender's encryption key
            let key = sqlx::query_as::<_, crate::keys::models::EncryptionKey>(
                "SELECT * FROM encryption_keys WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1"
            )
            .bind(msg.sender_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            if let Some(key) = key {
                let _decrypted = match key.key_type.as_str() {
                    "alpha" => {
                        if let Some(alpha_key) = &key.alpha_key_encrypted {
                            let cipher = AlphaCipher::new(alpha_key)
                                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                            Some(cipher.decrypt(&cleaned_content))
                        } else {
                            None
                        }
                    }
                    "columnar" => {
                        if let Some(columnar_key) = &key.columnar_key_encrypted {
                            let cipher = ColumnarCipher::new(columnar_key)
                                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                            Some(cipher.decrypt(&cleaned_content))
                        } else {
                            None
                        }
                    }
                    "combined" => {
                        if let (Some(alpha_key), Some(columnar_key)) = 
                            (&key.alpha_key_encrypted, &key.columnar_key_encrypted) {
                            let decryptor = CombinedDecryptor::new(alpha_key, columnar_key)
                                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                            Some(decryptor.decrypt(&cleaned_content))
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                
                // For now, we'll just return the encrypted content
                // In a real implementation, we'd need to store the decrypted content
                // or return it separately
            }
        }
        
        decrypted_messages.push(msg_response);
    }

    Ok(Json(decrypted_messages))
}

pub async fn create_message(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(chat_id): Path<Uuid>,
    Json(req): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<MessageResponse>), (StatusCode, String)> {
    let chat = sqlx::query_as::<_, crate::chats::models::Chat>(
        "SELECT * FROM chats WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)"
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let chat = chat.ok_or_else(|| (StatusCode::NOT_FOUND, "Chat not found".to_string()))?;

    let content_type = req.content_type.unwrap_or_else(|| "text/plain".to_string());

    // Get sender's active encryption key
    let key = sqlx::query_as::<_, crate::keys::models::EncryptionKey>(
        "SELECT * FROM encryption_keys WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1"
    )
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Encrypt content if key is available
    let encrypted_content = if let Some(key) = key {
        let content = &req.content;
        let encrypted = match key.key_type.as_str() {
            "alpha" => {
                if let Some(alpha_key) = &key.alpha_key_encrypted {
                    let cipher = AlphaCipher::new(alpha_key)
                        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                    Some(cipher.encrypt(content))
                } else {
                    None
                }
            }
            "columnar" => {
                if let Some(columnar_key) = &key.columnar_key_encrypted {
                    let cipher = ColumnarCipher::new(columnar_key)
                        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                    Some(cipher.encrypt(content))
                } else {
                    None
                }
            }
            "combined" => {
                if let (Some(alpha_key), Some(columnar_key)) = 
                    (&key.alpha_key_encrypted, &key.columnar_key_encrypted) {
                    let encryptor = CombinedEncryptor::new(alpha_key, columnar_key)
                        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                    Some(encryptor.encrypt(content))
                } else {
                    None
                }
            }
            _ => None,
        };
        // Add noise to encrypted content before storage
        encrypted.map(|enc| add_noise(&enc, 0.3))
    } else {
        None
    };

    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (sender_id, chat_id, subject, content_type, encrypted_content) 
         VALUES ($1, $2, $3, $4, $5) RETURNING *"
    )
    .bind(auth.user_id)
    .bind(chat_id)
    .bind(&req.subject)
    .bind(&content_type)
    .bind(&encrypted_content)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query("UPDATE chats SET updated_at = NOW() WHERE id = $1")
        .bind(chat_id)
        .execute(&pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let other_user_id = if auth.user_id == chat.user1_id {
        chat.user2_id
    } else {
        chat.user1_id
    };

    Ok((StatusCode::CREATED, Json(MessageResponse::from(message))))
}

pub async fn list_group_messages(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Vec<MessageResponse>>, (StatusCode, String)> {
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let messages = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE group_id = $1 ORDER BY created_at ASC"
    )
    .bind(group_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let message_responses: Vec<MessageResponse> = messages.into_iter().map(MessageResponse::from).collect();
    Ok(Json(message_responses))
}

pub async fn create_group_message(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<MessageResponse>), (StatusCode, String)> {
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let content_type = req.content_type.unwrap_or_else(|| "text/plain".to_string());

    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (sender_id, group_id, subject, content_type, encrypted_content, is_sent, sent_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW()) RETURNING *"
    )
    .bind(auth.user_id)
    .bind(group_id)
    .bind(&req.subject)
    .bind(&content_type)
    .bind(&req.content)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(MessageResponse::from(message))))
}
