pub mod handler;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;
use chrono::{DateTime, Utc};

pub type WsClients = Arc<RwLock<HashMap<Uuid, Vec<WsConnection>>>>;

#[derive(Clone)]
pub struct WsConnection {
    pub user_id: Uuid,
    pub sender: tokio::sync::mpsc::UnboundedSender<String>,
    pub channels: HashSet<String>,
}

#[derive(Clone)]
pub struct WsState {
    pub clients: WsClients,
    pub online_users: Arc<RwLock<HashSet<Uuid>>>,
    pub last_pongs: Arc<RwLock<HashMap<Uuid, DateTime<Utc>>>>,
}

impl WsState {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            online_users: Arc::new(RwLock::new(HashSet::new())),
            last_pongs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_client(&self, user_id: Uuid, sender: tokio::sync::mpsc::UnboundedSender<String>) {
        let mut clients = self.clients.write().await;
        clients.entry(user_id)
            .or_insert_with(Vec::new)
            .push(WsConnection { user_id, sender, channels: HashSet::new() });
    }

    pub async fn remove_client(&self, user_id: Uuid, sender: &tokio::sync::mpsc::UnboundedSender<String>) {
        let mut clients = self.clients.write().await;
        if let Some(conns) = clients.get_mut(&user_id) {
            conns.retain(|c| !c.sender.same_channel(sender));
            if conns.is_empty() {
                clients.remove(&user_id);
            }
        }
    }

    pub async fn broadcast_to_user(&self, user_id: Uuid, message: &str) {
        let clients = self.clients.read().await;
        if let Some(conns) = clients.get(&user_id) {
            for conn in conns {
                let _ = conn.sender.send(message.to_string());
            }
        }
    }

    pub async fn send_chat_update(&self, user_id: Uuid, chat_id: Uuid, event: &str) {
        let msg = serde_json::json!({
            "type": "chat_update",
            "event": event,
            "chat_id": chat_id,
        });
        self.broadcast_to_user(user_id, &msg.to_string()).await;
    }

    pub async fn send_new_message(&self, user_id: Uuid, chat_id: Uuid, message_id: Uuid) {
        let msg = serde_json::json!({
            "type": "new_message",
            "chat_id": chat_id,
            "message_id": message_id,
        });
        self.broadcast_to_user(user_id, &msg.to_string()).await;
    }

    pub async fn subscribe(&self, user_id: Uuid, channel: &str) {
        let mut clients = self.clients.write().await;
        if let Some(conns) = clients.get_mut(&user_id) {
            for conn in conns.iter_mut() {
                conn.channels.insert(channel.to_string());
            }
        }
    }

    pub async fn unsubscribe(&self, user_id: Uuid, channel: &str) {
        let mut clients = self.clients.write().await;
        if let Some(conns) = clients.get_mut(&user_id) {
            for conn in conns.iter_mut() {
                conn.channels.remove(channel);
            }
        }
    }

    pub async fn broadcast_to_channel(&self, channel: &str, message: &str) {
        let clients = self.clients.read().await;
        for conns in clients.values() {
            for conn in conns {
                if conn.channels.contains(channel) {
                    let _ = conn.sender.send(message.to_string());
                }
            }
        }
    }

    pub async fn broadcast_to_users(&self, user_ids: &[Uuid], message: &str) {
        let clients = self.clients.read().await;
        for user_id in user_ids {
            if let Some(conns) = clients.get(user_id) {
                for conn in conns {
                    let _ = conn.sender.send(message.to_string());
                }
            }
        }
    }

    pub async fn user_online(&self, user_id: Uuid) {
        let mut online = self.online_users.write().await;
        online.insert(user_id);
    }

    pub async fn user_offline(&self, user_id: Uuid) {
        let mut online = self.online_users.write().await;
        online.remove(&user_id);
    }

    pub async fn is_online(&self, user_id: Uuid) -> bool {
        let online = self.online_users.read().await;
        online.contains(&user_id)
    }

    pub async fn get_online_users(&self) -> Vec<Uuid> {
        let online = self.online_users.read().await;
        online.iter().cloned().collect()
    }

    pub async fn record_pong(&self, user_id: Uuid) {
        let mut pongs = self.last_pongs.write().await;
        pongs.insert(user_id, Utc::now());
    }

    pub async fn get_last_pong(&self, user_id: Uuid) -> Option<DateTime<Utc>> {
        let pongs = self.last_pongs.read().await;
        pongs.get(&user_id).cloned()
    }
}
