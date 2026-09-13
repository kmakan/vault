// Broadcast channels (M2, t_m2_channels) — storage and CRUD.
// Design doc: docs/design/channels-protocol.md. A channel is a broadcast
// group by the Delta Chat pattern: a shared symmetric key ("broadcast
// secret"), one emitter (the owner), unlimited read-only subscribers that
// join via a QR link and never reveal their address to the owner.
//
// Storage follows the groups.rs pattern (a JSON file in ~/.vault), with the
// same atomic write (tmp + rename) and the same env-var override for tests.
// The wire format reuses group envelopes: the channel key decrypts
// channel_post/channel_meta/hello payloads (see features/incoming.js).

use anyhow::Result;
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const CHANNELS_FILE: &str = "channels.json";

fn get_channels_dir() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault"))
}

fn get_channels_path() -> Result<PathBuf> {
    // Tests can redirect the storage file; keeps the real
    // `~/.vault/channels.json` untouched.
    if let Ok(p) = std::env::var("VAULT_CHANNELS_FILE") {
        return Ok(PathBuf::from(p));
    }
    let dir = get_channels_dir()?;
    Ok(dir.join(CHANNELS_FILE))
}

/// A broadcast channel. `id` uses the `chn_` prefix so the router and the UI
/// can tell channels from groups without extra flags.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    /// Owner account email (creator). Empty for imported channels whose owner
    /// is only known by fingerprint (subscribed side).
    pub created_by: String,
    pub created_at: String,
    /// Owner key fingerprint (128-hex) from the join link — the stable owner
    /// identity that survives an email change.
    #[serde(default)]
    pub owner_fpr: String,
    /// Short description shown in the channel header.
    #[serde(default)]
    pub about: String,
    /// 32-byte symmetric broadcast key (64 hex) — same role as group_key.
    pub key: String,
    /// Incremented on a key migration; MVP always 1.
    #[serde(default = "default_key_version")]
    pub key_version: u32,
    /// True for the channel this account owns (can emit posts).
    #[serde(default)]
    pub is_owner: bool,
    /// Subscribed channels: last seen post timestamp (unix ms) — for unread
    /// badges and history fetch cursors.
    #[serde(default)]
    pub last_ts: i64,
    /// Known-subscriber emails (opt-in via hello or manual add). The owner
    /// duplicates posts to these addresses by email besides the relay.
    #[serde(default)]
    pub known_subscribers: Vec<String>,
}

fn default_key_version() -> u32 {
    1
}

pub fn load_channels() -> Result<HashMap<String, Channel>> {
    let path = get_channels_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data = fs::read_to_string(&path)?;
    let channels: HashMap<String, Channel> = serde_json::from_str(&data)?;
    Ok(channels)
}

pub fn save_channels(channels: &HashMap<String, Channel>) -> Result<()> {
    let path = get_channels_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(channels)?;
    // Atomic write: tmp + rename (same rationale as groups.rs — a truncated
    // file would silently wipe all channels on the next load).
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Create a channel owned by this account. Generates the `chn_` id and the
/// 32-byte broadcast secret.
pub fn create_channel(name: &str, owner: &str, owner_fpr: &str, about: &str) -> Result<Channel> {
    let name_trimmed = name.trim();
    if name_trimmed.is_empty() {
        anyhow::bail!("Channel name cannot be empty");
    }
    let mut id_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let id = format!("chn_{}", hex::encode(id_bytes));

    let mut key_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key_bytes);
    let key = hex::encode(key_bytes);

    let channel = Channel {
        id,
        name: name_trimmed.to_string(),
        created_by: owner.to_string(),
        created_at: Utc::now().to_rfc3339(),
        owner_fpr: owner_fpr.to_string(),
        about: about.trim().to_string(),
        key,
        key_version: 1,
        is_owner: true,
        last_ts: 0,
        known_subscribers: Vec::new(),
    };

    let mut channels = load_channels()?;
    channels.insert(channel.id.clone(), channel.clone());
    save_channels(&channels)?;
    Ok(channel)
}

/// Import (subscribe to) a channel from a join link. `owner_fpr` is taken
/// from the link and kept even when the owner email is unknown — it is the
/// stable identity used to verify hello senders.
pub fn import_channel(
    channel_id: &str,
    name: &str,
    key: &str,
    owner: &str,
    owner_fpr: &str,
) -> Result<Channel> {
    if !channel_id.starts_with("chn_") {
        anyhow::bail!("Invalid channel id");
    }
    if key.len() != 64 {
        anyhow::bail!("Invalid channel key length");
    }
    let mut channels = load_channels()?;
    let now = Utc::now().to_rfc3339();
    let channel = Channel {
        id: channel_id.to_string(),
        name: name.to_string(),
        created_by: owner.to_string(),
        created_at: now,
        owner_fpr: owner_fpr.to_string(),
        about: String::new(),
        key: key.to_string(),
        key_version: 1,
        is_owner: false,
        last_ts: 0,
        known_subscribers: Vec::new(),
    };
    channels.insert(channel.id.clone(), channel.clone());
    save_channels(&channels)?;
    Ok(channel)
}

/// Update mutable fields (name/about/avatar meta, key migration, last_ts).
/// Idempotent; unknown id is an error (a channel must be joined first).
pub fn update_channel(channel_id: &str, patch: &ChannelPatch) -> Result<Channel> {
    let mut channels = load_channels()?;
    let ch = channels
        .get_mut(channel_id)
        .ok_or_else(|| anyhow::anyhow!("Channel not found: {channel_id}"))?;
    if let Some(name) = &patch.name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            anyhow::bail!("Channel name cannot be empty");
        }
        ch.name = trimmed.to_string();
    }
    if let Some(about) = &patch.about {
        ch.about = about.clone();
    }
    if let Some(owner_fpr) = &patch.owner_fpr {
        if !owner_fpr.is_empty() {
            ch.owner_fpr = owner_fpr.clone();
        }
    }
    if let Some(key) = &patch.key {
        if key.len() != 64 {
            anyhow::bail!("Invalid channel key length");
        }
        ch.key = key.clone();
    }
    if let Some(kv) = patch.key_version {
        ch.key_version = kv;
    }
    if let Some(ts) = patch.last_ts {
        if ts > ch.last_ts {
            ch.last_ts = ts;
        }
    }
    let cloned = ch.clone();
    save_channels(&channels)?;
    Ok(cloned)
}

#[derive(Debug, Default, Deserialize)]
pub struct ChannelPatch {
    pub name: Option<String>,
    pub about: Option<String>,
    pub owner_fpr: Option<String>,
    pub key: Option<String>,
    pub key_version: Option<u32>,
    pub last_ts: Option<i64>,
}

/// Owner-side: remember a known subscriber (opt-in hello or manual add).
/// Idempotent; enforced by the caller (owner only).
pub fn add_known_subscriber(channel_id: &str, email: &str) -> Result<()> {
    let mut channels = load_channels()?;
    let ch = channels
        .get_mut(channel_id)
        .ok_or_else(|| anyhow::anyhow!("Channel not found: {channel_id}"))?;
    let email = email.trim().to_lowercase();
    if !email.is_empty() && !ch.known_subscribers.iter().any(|s| *s == email) {
        ch.known_subscribers.push(email);
        save_channels(&channels)?;
    }
    Ok(())
}

/// Delete a channel (owner deletes, subscriber unsubscribes — same action:
/// remove local state; the wire side is fire-and-forget).
pub fn delete_channel(channel_id: &str) -> Result<()> {
    let mut channels = load_channels()?;
    if channels.remove(channel_id).is_none() {
        anyhow::bail!("Channel not found");
    }
    save_channels(&channels)?;
    Ok(())
}

/// Wipe all local channels (duress wipe path).
pub fn delete_all_local() -> Result<()> {
    let path = get_channels_path()?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpfile(tag: &str) -> String {
        let mut b = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut b);
        format!("/tmp/vault-channels-test-{}-{}.json", tag, hex::encode(b))
    }

    #[test]
    fn create_import_update_delete_roundtrip() {
        std::env::set_var("VAULT_CHANNELS_FILE", tmpfile("rt"));
        // Owner creates
        let ch = create_channel("News", "a@x.y", "fpr123", "about text").unwrap();
        assert!(ch.id.starts_with("chn_"));
        assert_eq!(ch.key.len(), 64);
        assert!(ch.is_owner);
        // Subscriber imports the same id from a link
        let sub = import_channel(&ch.id, "News", &ch.key, "a@x.y", "fpr123").unwrap();
        assert!(!sub.is_owner);
        // Update meta + monotonic last_ts
        let upd = update_channel(
            &ch.id,
            &ChannelPatch {
                name: Some("News 2".into()),
                about: Some("new about".into()),
                last_ts: Some(123),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(upd.name, "News 2");
        update_channel(&ch.id, &ChannelPatch { last_ts: Some(50), ..Default::default() }).unwrap();
        assert_eq!(load_channels().unwrap()[&ch.id].last_ts, 123);
        // Known subscribers: idempotent add
        add_known_subscriber(&ch.id, "B@X.Y").unwrap();
        add_known_subscriber(&ch.id, "b@x.y").unwrap();
        assert_eq!(load_channels().unwrap()[&ch.id].known_subscribers.len(), 1);
        // Delete
        delete_channel(&ch.id).unwrap();
        assert!(load_channels().unwrap().get(&ch.id).is_none());
    }

    #[test]
    fn rejects_bad_input() {
        std::env::set_var("VAULT_CHANNELS_FILE", tmpfile("bad"));
        assert!(create_channel("  ", "a", "f", "b").is_err());
        assert!(import_channel("grp_123", "n", &"k".repeat(64), "a", "f").is_err());
        assert!(import_channel("chn_123", "n", "short", "a", "f").is_err());
        assert!(update_channel("chn_missing", &ChannelPatch::default()).is_err());
    }
}
