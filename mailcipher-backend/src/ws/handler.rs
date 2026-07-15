use axum::{
    extract::{
        ws::{Message, WebSocket},
        Extension, Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use uuid::Uuid;

use super::WsState;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(pool): State<sqlx::PgPool>,
    Extension(ws_state): Extension<WsState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, query, pool, ws_state))
}

async fn handle_socket(socket: WebSocket, query: WsQuery, pool: sqlx::PgPool, ws_state: WsState) {
    let user_id = match authenticate_ws(&query, &pool).await {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!("WebSocket auth failed: {}", e);
            return;
        }
    };

    let (mut sender, mut receiver) = socket.split();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    ws_state.add_client(user_id, tx.clone()).await;
    ws_state.user_online(user_id).await;

    tracing::info!("User {} connected via WebSocket", user_id);

    let online_msg = serde_json::json!({
        "type": "presence",
        "event": "online",
        "user_id": user_id,
    });
    ws_state.broadcast_to_channel("presence", &online_msg.to_string()).await;

    let user_id_for_task = user_id;
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let ws_state_for_recv = ws_state.clone();
    let tx_for_recv = tx.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Err(e) = handle_client_message(&text, user_id_for_task, &ws_state_for_recv).await {
                        tracing::warn!("Error handling WS message: {}", e);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = tx_for_recv.send("".to_string());
    });

    let mut heartbeat_ws = ws_state.clone();
    let mut heartbeat_tx = tx.clone();
    let heartbeat_user_id = user_id;
    let mut heartbeat_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        let mut last_pong = tokio::time::Instant::now();
        let pong_timeout = tokio::time::Duration::from_secs(60);
        loop {
            interval.tick().await;
            let ping = serde_json::json!({
                "type": "ping",
                "timestamp": chrono::Utc::now().to_rfc3339(),
            });
            if heartbeat_tx.send(ping.to_string()).is_err() {
                break;
            }
            if last_pong.elapsed() > pong_timeout {
                tracing::warn!("Heartbeat timeout for user {}", heartbeat_user_id);
                break;
            }
            let pong = heartbeat_ws.get_last_pong(heartbeat_user_id).await;
            if let Some(_ts) = pong {
                last_pong = tokio::time::Instant::now();
            }
        }
        let _ = heartbeat_tx.send("".to_string());
    });

    tokio::select! {
        _ = &mut send_task => {
            recv_task.abort();
            heartbeat_task.abort();
        }
        _ = &mut recv_task => {
            send_task.abort();
            heartbeat_task.abort();
        }
        _ = &mut heartbeat_task => {
            send_task.abort();
            recv_task.abort();
        }
    }

    ws_state.remove_client(user_id, &tx).await;

    let has_connections = {
        let clients = ws_state.clients.read().await;
        clients.get(&user_id).map_or(false, |c| !c.is_empty())
    };
    if !has_connections {
        ws_state.user_offline(user_id).await;
        let offline_msg = serde_json::json!({
            "type": "presence",
            "event": "offline",
            "user_id": user_id,
        });
        ws_state.broadcast_to_channel("presence", &offline_msg.to_string()).await;
    }

    tracing::info!("User {} disconnected from WebSocket", user_id);
}

async fn authenticate_ws(query: &WsQuery, _pool: &sqlx::PgPool) -> Result<Uuid, String> {
    let token = query.token.as_ref()
        .ok_or_else(|| "Missing token".to_string())?;

    let secret = std::env::var("JWT_SECRET")
        .map_err(|_| "JWT_SECRET not configured".to_string())?;

    let claims = crate::auth::Claims::from_token(token, &secret)
        .map_err(|e| format!("Invalid token: {}", e))?;

    Ok(claims.sub)
}

async fn handle_client_message(text: &str, user_id: Uuid, ws_state: &WsState) -> Result<(), String> {
    let msg: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    match msg["type"].as_str() {
        Some("ping") => {
            ws_state.record_pong(user_id).await;
            let pong = serde_json::json!({
                "type": "pong",
                "timestamp": chrono::Utc::now().to_rfc3339(),
            });
            ws_state.broadcast_to_user(user_id, &pong.to_string()).await;
        }
        Some("subscribe") => {
            if let Some(channel) = msg["channel"].as_str() {
                ws_state.subscribe(user_id, channel).await;
                tracing::debug!("User {} subscribed to channel {}", user_id, channel);
            }
        }
        Some("unsubscribe") => {
            if let Some(channel) = msg["channel"].as_str() {
                ws_state.unsubscribe(user_id, channel).await;
                tracing::debug!("User {} unsubscribed from channel {}", user_id, channel);
            }
        }
        Some("get_online_users") => {
            let online = ws_state.get_online_users().await;
            let response = serde_json::json!({
                "type": "online_users",
                "users": online,
            });
            ws_state.broadcast_to_user(user_id, &response.to_string()).await;
        }
        _ => {}
    }

    Ok(())
}
