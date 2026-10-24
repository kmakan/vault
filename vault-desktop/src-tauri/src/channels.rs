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
// Форматные предикаты канала (префикс id, длина ключа, имя, last_ts) —
// правила ядра, здесь только применение (ADR-005 §W4, `t_502b6c90`).
use vault_client::vault::channels::{
    is_valid_channel_id, is_valid_channel_key, next_last_ts, normalize_channel_name,
};
use vault_client::vault::identity;

const CHANNELS_FILE: &str = "channels.json";

fn get_channels_dir() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault"))
}

thread_local! {
    /// Tests redirect the storage file per-thread (see `tests::tmpfile`):
    /// a process-global `std::env::var` raced between tests running in one
    /// binary — a test could see another test's path and read a file that
    /// its own fixture never created. Thread-local keeps the same public
    /// redirect seam without the cross-test leak.
    static TEST_CHANNELS_FILE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

fn get_channels_path() -> Result<PathBuf> {
    // Test redirect: per-thread, keeps the real `~/.vault/channels.json`
    // untouched. Precedence over the env var — tests set this, the env var
    // stays a manual override for ad-hoc runs.
    if let Some(p) = TEST_CHANNELS_FILE.with(|c| c.borrow().clone()) {
        return Ok(p);
    }
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
    if !is_valid_channel_id(channel_id) {
        anyhow::bail!("Invalid channel id");
    }
    if !is_valid_channel_key(key) {
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
        ch.name = normalize_channel_name(name).map_err(|e| anyhow::anyhow!(e))?;
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
        if !is_valid_channel_key(key) {
            anyhow::bail!("Invalid channel key length");
        }
        ch.key = key.clone();
    }
    if let Some(kv) = patch.key_version {
        ch.key_version = kv;
    }
    if let Some(ts) = patch.last_ts {
        ch.last_ts = next_last_ts(ch.last_ts, ts);
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
/// Idempotent; enforced by the caller (owner only). Форма адреса и «тот ли это
/// подписчик» — правила ядра ([`identity`]), иначе «Боб@Почта.ру» заводился
/// вторым подписчиком рядом с `боб@почта.ру` и пост уходил дважды.
pub fn add_known_subscriber(channel_id: &str, email: &str) -> Result<()> {
    let mut channels = load_channels()?;
    let ch = channels
        .get_mut(channel_id)
        .ok_or_else(|| anyhow::anyhow!("Channel not found: {channel_id}"))?;
    let email = identity::normalize(email);
    let known = ch
        .known_subscribers
        .iter()
        .any(|s| identity::same_address(s, &email));
    if !email.is_empty() && !known {
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

// ── Capability-токены канала (ADR-001: крипто-математика уходит из JS) ──
//
// Раньше пара токенов считалась в features/channels.js через WebCrypto
// (crypto.subtle HMAC-SHA256) и раскладка 45-байтового токена была описана
// в двух местах: здесь и в релее (~/vault-relay-src/src/tokens.rs,
// channel_tokens). Две реализации одного формата — это тихий риск: правка
// на одной стороне ломает другую и всплывает как «каналы перестали работать».
// Источник истины теперь один — этот код, а второй экземпляр на сервере
// запинен общими тест-векторами (см. relay_tokens_vectors_match_known_good).
//
// Формат v1 (45 Б), base64url без паддинга:
//     key_id(8) ‖ scope(1) ‖ expiry(4) ‖ mac(32)
//   mac      = HMAC-SHA256(broadcast_key, label)
//   key_id   = первые 8 байт mac от read-подписи
//   scope    = 'c' (read) / 'C' (write)
//   expiry   = u32::MAX — СЕНТИНЕЛ «бессрочно». Релей отклоняет канальный
//              токен с любым другим expiry (parse_v1: is_channel() → сверка
//              u32::MAX), поэтому здесь он жёстко зашит, а не берётся из аргументов.
pub fn channel_tokens(broadcast_key: &[u8; 32]) -> (String, String) {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mac_of = |label: &[u8]| -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(broadcast_key).expect("32B key");
        mac.update(label);
        mac.finalize().into_bytes().into()
    };
    let read_mac = mac_of(b"vault-relay-channel-read");
    let write_mac = mac_of(b"vault-relay-channel-write");

    // key_id — link-связка: write-токен принимается релеем только если его
    // key_id == key_id очереди, а очередь адресована read-токеном.
    let mut kid = [0u8; 8];
    kid.copy_from_slice(&read_mac[..8]);

    let pack = |byte: u8, mac: &[u8; 32]| -> String {
        let mut raw = Vec::with_capacity(45);
        raw.extend_from_slice(&kid);
        raw.push(byte);
        raw.extend_from_slice(&u32::MAX.to_be_bytes());
        raw.extend_from_slice(mac);
        base64url(&raw)
    };
    (pack(b'c', &read_mac), pack(b'C', &write_mac))
}

fn base64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// Tauri-обёртка: hex-ключ канала (как приходит из JS) → пара токенов.
#[tauri::command]
pub fn channel_tokens_cmd(key_hex: String) -> Result<(String, String), String> {
    let trimmed = key_hex.trim();
    if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad channel key: expected 64 hex chars".into());
    }
    let mut key = [0u8; 32];
    hex::decode_to_slice(trimmed, &mut key).map_err(|e| format!("bad channel key: {e}"))?;
    Ok(channel_tokens(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpfile(tag: &str) -> String {
        let mut b = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut b);
        format!("/tmp/vault-channels-test-{}-{}.json", tag, hex::encode(b))
    }

    /// Устанавливает thread-local файл хранилища для теста и возвращает
    /// его путь (тест видит свой файл и только свой).
    fn redirect(tag: &str) -> PathBuf {
        let p = PathBuf::from(tmpfile(tag));
        TEST_CHANNELS_FILE.with(|c| *c.borrow_mut() = Some(p.clone()));
        p
    }

    #[test]
    fn create_import_update_delete_roundtrip() {
        let _path = redirect("rt");
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
        update_channel(
            &ch.id,
            &ChannelPatch {
                last_ts: Some(50),
                ..Default::default()
            },
        )
        .unwrap();
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
    fn known_subscriber_is_deduped_by_normalised_address() {
        let _path = redirect("subs");
        let ch = create_channel("News", "a@x.y", "fpr1", "about").unwrap();
        add_known_subscriber(&ch.id, " Боб@Почта.РУ ").unwrap();
        add_known_subscriber(&ch.id, "боб@почта.ру").unwrap();
        let subs = &load_channels().unwrap()[&ch.id].known_subscribers;
        assert_eq!(
            subs.len(),
            1,
            "тот же адрес в другом регистре — не второй подписчик"
        );
        assert_eq!(subs[0], "боб@почта.ру");
        add_known_subscriber(&ch.id, "").unwrap();
        assert_eq!(load_channels().unwrap()[&ch.id].known_subscribers.len(), 1);
    }
    // ── Общие тест-векторы клиента и релея ───────────────────────────
    //
    // Эталон зафиксирован сверкой с ~/vault-relay-src/src/tokens.rs
    // (функция channel_tokens, ревизия 14.10). Ключ [7u8; 32] — тот же,
    // что в релеевом channel_tokens_roundtrip, так что векторы обязаны
    // совпасть. Если кто-то поменяет раскладку на одной стороне — тест
    // на этой покраснеет, и «каналы перестали работать» не станет
    // сюрпризом в проде.
    const VEC_KEY: [u8; 32] = [7u8; 32];
    const VEC_READ: &str = "KNCVvmo4Tz1j_____yjQlb5qOE89lbysuEHHW-wSbSJVc4W5gCAIM5cRNzG9";
    const VEC_WRITE: &str = "KNCVvmo4Tz1D_____-_z_qnZjNcGJrfF91VU_0h3g96hTAI2uR70lQYl9LNh";

    /// Копия функции релея, дословно. Живёт здесь как исполняемый
    /// «контракт»: пока эта копия и channel_tokens дают один результат на
    /// эталонном ключе, раскладка не разошлась.
    fn relay_reference_impl(broadcast_key: &[u8; 32]) -> (String, String) {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        type HmacSha256 = Hmac<Sha256>;
        let mac_of = |label: &[u8]| -> [u8; 32] {
            let mut mac = HmacSha256::new_from_slice(broadcast_key).expect("32B key");
            mac.update(label);
            mac.finalize().into_bytes().into()
        };
        let read_mac = mac_of(b"vault-relay-channel-read");
        let write_mac = mac_of(b"vault-relay-channel-write");
        let pack = |kid: u64, byte: u8, mac: &[u8; 32]| -> String {
            let mut raw = Vec::with_capacity(45);
            raw.extend_from_slice(&kid.to_be_bytes());
            raw.push(byte);
            raw.extend_from_slice(&u32::MAX.to_be_bytes());
            raw.extend_from_slice(mac);
            base64url(&raw)
        };
        let read_kid = u64::from_be_bytes(read_mac[..8].try_into().expect("8"));
        (
            pack(read_kid, b'c', &read_mac),
            pack(read_kid, b'C', &write_mac),
        )
    }

    #[test]
    fn channel_tokens_match_shared_vectors() {
        let (rd, wr) = channel_tokens(&VEC_KEY);
        assert_eq!(rd, VEC_READ, "read-токен разошёлся с эталоном");
        assert_eq!(wr, VEC_WRITE, "write-токен разошёлся с эталоном");
    }

    #[test]
    fn channel_tokens_match_relay_reference_impl() {
        assert_eq!(
            channel_tokens(&VEC_KEY),
            relay_reference_impl(&VEC_KEY),
            "клиент и релей разошлись в раскладке токена"
        );
    }

    #[test]
    fn channel_token_layout_is_exact() {
        use base64::Engine;
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let read_raw = enc.decode(VEC_READ).expect("b64url");
        for (tok, scope) in [(VEC_READ, b'c'), (VEC_WRITE, b'C')] {
            let raw = enc.decode(tok).expect("b64url");
            assert_eq!(raw.len(), 45, "раскладка должна быть 45 байт");
            assert_eq!(raw[8], scope);
            assert_eq!(&raw[9..13], &u32::MAX.to_be_bytes(), "sentinel expiry");
            assert_eq!(
                raw[..8],
                read_raw[..8],
                "key_id обоих токенов = первые 8 байт mac подписи read"
            );
        }
    }

    #[test]
    fn channel_tokens_are_deterministic_and_key_dependent() {
        assert_eq!(channel_tokens(&VEC_KEY).0, channel_tokens(&VEC_KEY).0);
        assert_ne!(channel_tokens(&VEC_KEY).0, channel_tokens(&[8u8; 32]).0);
    }

    #[test]
    fn channel_tokens_cmd_validates_key_hex() {
        assert!(channel_tokens_cmd("zz".into()).is_err(), "не-hex");
        assert!(channel_tokens_cmd("07".into()).is_err(), "короткий ключ");
        let hex = hex::encode(VEC_KEY);
        let (rd, wr) = channel_tokens_cmd(hex.clone()).expect("валидный ключ");
        assert_eq!((rd.as_str(), wr.as_str()), (VEC_READ, VEC_WRITE));
        // Пробелы вокруг — норма (ключ приходит из полей ввода).
        let (rd2, _) = channel_tokens_cmd(format!("  {hex}  ")).expect("trim");
        assert_eq!(rd2, VEC_READ);
    }

    #[test]
    fn rejects_bad_input() {
        let _path = redirect("bad");
        assert!(create_channel("  ", "a", "f", "b").is_err());
        assert!(import_channel("grp_123", "n", &"k".repeat(64), "a", "f").is_err());
        assert!(import_channel("chn_123", "n", "short", "a", "f").is_err());
        assert!(update_channel("chn_missing", &ChannelPatch::default()).is_err());
    }
}
