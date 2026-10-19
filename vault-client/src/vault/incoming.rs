//! Incoming envelope classification — Rust core; единственный источник правды
//! о типе входящего письма (ADR-005 R1, эпик W1 `t_2243231f`).
//!
//! `classify` отвечает ровно на один вопрос: **что это за письмо после
//! расшифровки**. Порядок проверок повторяет прод-роутер
//! `vault-desktop/src/features/incoming.js`:
//! `calls.js#parseCallSignal` → `presence.js#ingestSignal` →
//! `message-format.js#parseEnvelope` → `channels.js#isChannelEnvelope` → `hav`.
//! Повторяется намеренно, а не «по здравому смыслу»: цель переноса решения в
//! Rust — не изменить поведение (W1 acceptance), а убрать дубль.
//!
//! Каждое правило закреплено кейсом в общей фикстуре
//! `vault-client/tests/fixtures/m0-wire-contract.json`, её читают оба гейта:
//! `cargo test --test m0_wire_contract` и `npm run smoke:m0-wire`.
//!
//! Типы:
//! - `Message` — `vault=1` и `text` строкой (в т.ч. `text:""`; poll/sos/media —
//!   тоже сообщения: подтип решает рендер, а не роутер);
//! - `Profile` — то же, но `type="profile"` (письмо профиля, не сообщение);
//! - `Call` — `vault=1`, `type` начинается с `call_`, есть `call_id`;
//! - `Presence` — `presence === 1` (точное сравнение, как в JS);
//! - `Channel` — `channel === 1` (канальный конверт живёт вне `vault`);
//! - `GroupService` — `hav === 1` (запрос аватарки группы).
//!
//! Групповой **message**-конверт отличается от 1:1 не байтами, а ключом, которым
//! расшифровался (`group:<id>` знает только JS-адаптер), поэтому в фикстуре он
//! записан как `message` с пояснением — иначе это выглядело бы пробелом.
//!
//! `None` — письмо не наше (legacy plaintext, чужой JSON, мусор).

use serde::{Deserialize, Serialize};

use super::protocol::VaultMsgType;

/// Classification result for a decrypted incoming plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClassifyKind {
    Message,
    Profile,
    Presence,
    Call,
    Channel,
    GroupService,
    KeyExchange,
    Receipt,
    Unknown,
}

impl std::fmt::Display for ClassifyKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                ClassifyKind::Message => "message",
                ClassifyKind::Profile => "profile",
                ClassifyKind::Presence => "presence",
                ClassifyKind::Call => "call",
                ClassifyKind::Channel => "channel",
                ClassifyKind::GroupService => "group-service",
                ClassifyKind::KeyExchange => "keyexchange",
                ClassifyKind::Receipt => "receipt",
                ClassifyKind::Unknown => "unknown",
            }
        )
    }
}

/// Result of classifying an incoming envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifyResult {
    pub kind: ClassifyKind,
    pub msg_type: Option<VaultMsgType>,
    pub env_id: Option<String>,       // envelope id (кросс-канальный дедуп)
    pub chat_key: Option<String>,     // 1:1 email или group:<id>
    pub title: Option<String>,        // display title (name/avatar)
}

impl Default for ClassifyResult {
    fn default() -> Self {
        Self {
            kind: ClassifyKind::Unknown,
            msg_type: None,
            env_id: None,
            chat_key: None,
            title: None,
        }
    }
}

/// Собрать результат одного типа: поля, которые роутеру действительно нужны.
///
/// `chat_key` заполняется только для писем, адресуемых отправителю (1:1):
/// у presence/канала/сервисного письма группы его нет — и врать `from` вместо
/// настоящего ключа (канал, группа) нельзя, иначе адаптер будет искать чат не там.
fn classified(
    kind: ClassifyKind,
    env_id: Option<String>,
    chat_key: Option<&str>,
    title: Option<String>,
) -> ClassifyResult {
    ClassifyResult {
        kind,
        msg_type: None,
        env_id,
        chat_key: chat_key.map(|s| s.to_string()),
        title,
    }
}

/// Classify a decrypted plaintext (the router decision, JS → Rust).
///
/// - `plain`: decrypted payload JSON (body already fetched)
/// - `from`: sender email (canonicalized upstream)
///
/// Returns `None` если письмо не наше (ignore / не vault envelope).
pub fn classify(plain: &str, from: &str) -> Option<ClassifyResult> {
    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;
    if !obj.is_object() {
        return None;
    }

    let is_vault = obj.get("vault").and_then(|v| v.as_i64()) == Some(1);
    let text_is_string = obj.get("text").map(|v| v.is_string()).unwrap_or(false);

    // 1. Call-сигнал (calls.js#parseCallSignal): vault=1 + type="call_*" + call_id.
    //    Именно `type`, а не наличие `call_id`/`signal`: конверт сообщения может
    //    нести `call_id` как данные, и раньше это ошибочно превращало его в Call.
    if is_vault
        && obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|t| t.starts_with("call_"))
            .unwrap_or(false)
        && obj.get("call_id").is_some()
    {
        return Some(classified(
            ClassifyKind::Call,
            object_get_string(&obj, "id"),
            Some(from),
            merge_name(&obj),
        ));
    }

    // 2. Presence (presence.js#ingestSignal): строго `presence === 1`.
    //    `presence:"1"` или `presence:0` — не heartbeat (JS тоже не примет).
    if obj.get("presence").and_then(|v| v.as_i64()) == Some(1) {
        return Some(classified(ClassifyKind::Presence, None, None, None));
    }

    // 3. Конверт vault (message-format.js#parseEnvelope): vault=1 и `text`
    //    строкой. НЕ `text.is_some()`: `text:null`/`text:123` конвертом не
    //    являются, и разбор такого «конверта» дал бы пустое сообщение.
    if is_vault && text_is_string {
        let kind = if obj.get("type").and_then(|v| v.as_str()) == Some("profile") {
            // Письмо профиля несёт `text:""` (features/profiles.js), поэтому
            // проверка стоит ПОСЛЕ требования text-строки, но ДО «это message»:
            // иначе профиль стал бы сообщением с пустым текстом.
            ClassifyKind::Profile
        } else {
            ClassifyKind::Message
        };
        return Some(classified(
            kind,
            object_get_string(&obj, "id"),
            Some(from),
            merge_name(&obj),
        ));
    }

    // 4. Канальный конверт (channels.js#isChannelEnvelope): `channel === 1`.
    //    Канал живёт вне `vault` — это отдельная ветка транспорта.
    if obj.get("channel").and_then(|v| v.as_i64()) == Some(1) {
        return Some(classified(
            ClassifyKind::Channel,
            object_get_string(&obj, "id"),
            None,
            None,
        ));
    }

    // 5. Сервисное письмо группы: `{hav:1}` — запрос аватарки (healing).
    if obj.get("hav").and_then(|v| v.as_i64()) == Some(1) {
        return Some(classified(ClassifyKind::GroupService, None, None, None));
    }

    None
}

fn object_get_string(obj: &serde_json::Value, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn merge_name(obj: &serde_json::Value) -> Option<String> {
    obj.get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_message() {
        let plain = r#"{"vault":1,"id":"msg-1","text":"привет","name":"Аня","ts":1700000000}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Message);
        assert_eq!(r.env_id.as_deref(), Some("msg-1"));
        assert_eq!(r.chat_key.as_deref(), Some("alice@test.com"));
        assert_eq!(r.title.as_deref(), Some("Аня"));
    }

    /// Письмо профиля — как его собирает `features/profiles.js`: `text:""`.
    #[test]
    fn test_classify_profile() {
        let plain = r#"{"vault":1,"id":"prof-1","type":"profile","text":"","name":"Bob","avatar":"data","bio":"hi","ts":123}"#;
        let r = classify(plain, "bob@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Profile);
        assert_eq!(r.env_id.as_deref(), Some("prof-1"));
        assert_eq!(r.title.as_deref(), Some("Bob"));
    }

    /// Профиль с текстом — всё равно профиль: роутер смотрит на `type` раньше,
    /// чем решает «это сообщение» (иначе письмо профиля стало бы сообщением).
    #[test]
    fn test_classify_profile_beats_text() {
        let plain = r#"{"vault":1,"type":"profile","text":"x","name":"Bob"}"#;
        let r = classify(plain, "bob@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Profile);
    }

    /// Без `text` письмо не является vault-конвертом вовсе: прод-парсер
    /// `parseEnvelope` требует `typeof text === "string"`, и роутер его не видит.
    /// Настоящие письма профиля всегда несут `text:""` — кейс фиксирует
    /// паритет, а не разрешает слать такие письма.
    #[test]
    fn test_classify_profile_without_text_is_not_envelope() {
        assert!(classify(r#"{"vault":1,"type":"profile","name":"Bob"}"#, "x@test.com").is_none());
        assert!(classify(r#"{"vault":1,"name":"Bob","avatar":"a","bio":"b"}"#, "x@test.com").is_none());
    }

    #[test]
    fn test_classify_presence() {
        let plain = r#"{"presence":1,"ts":12345}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Presence);
        assert_eq!(r.chat_key, None, "presence адресуется не чату, а карточке контакта");
    }

    /// `presence` сравнивается строго с числом 1 (JS: `robj.presence !== 1`).
    #[test]
    fn test_classify_presence_is_strict() {
        assert!(classify(r#"{"presence":"1"}"#, "x@test.com").is_none());
        assert!(classify(r#"{"presence":0}"#, "x@test.com").is_none());
        assert!(classify(r#"{"presence":true}"#, "x@test.com").is_none());
    }

    /// Presence проверяется до конверта — как в прод-роутере.
    #[test]
    fn test_classify_presence_beats_message() {
        let r = classify(r#"{"vault":1,"text":"hi","presence":1}"#, "x@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Presence);
    }

    #[test]
    fn test_classify_call() {
        // signals звонка: type="call_*" + call_id (calls.js#parseCallSignal)
        let plain = r#"{"vault":1,"id":"call-1","type":"call_request","call_id":"c1","ts":1}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Call);
        assert_eq!(r.env_id.as_deref(), Some("call-1"));
        assert_eq!(r.chat_key.as_deref(), Some("alice@test.com"));
    }

    /// Call — это `type: "call_*"`, а не любое письмо с полем `call_id`:
    /// иначе обычное сообщение с метаданными звонка уходило бы в state machine.
    #[test]
    fn test_classify_call_requires_type_prefix() {
        let r = classify(r#"{"vault":1,"text":"x","call_id":"c1"}"#, "x@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Message);
        assert!(classify(r#"{"vault":1,"call_id":"c1"}"#, "x@test.com").is_none());
        assert!(classify(r#"{"vault":1,"type":"call_request"}"#, "x@test.com").is_none());
    }

    /// Голосование — сообщение со своим подтипом, не сигнал управления.
    #[test]
    fn test_classify_poll_is_message() {
        let plain = r#"{"vault":1,"id":"p1","text":"q?","type":"poll","poll":{"id":"p1","question":"q?","options":["a","b"]}}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Message);
    }

    /// `text` обязан быть строкой; `text:""` — валидное (пустое) сообщение.
    #[test]
    fn test_classify_text_must_be_string() {
        assert!(classify(r#"{"vault":1,"text":null}"#, "x@test.com").is_none());
        assert!(classify(r#"{"vault":1,"text":123}"#, "x@test.com").is_none());
        let r = classify(r#"{"vault":1,"text":""}"#, "x@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Message);
    }

    #[test]
    fn test_classify_channel() {
        // channels.js: {channel:1, chan, post, id, ts} — вне vault
        let plain = r#"{"channel":1,"chan":"ch1","post":{"body":"hello"},"id":"chp-1","ts":2}"#;
        let r = classify(plain, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::Channel);
        assert_eq!(r.env_id.as_deref(), Some("chp-1"));
        assert_eq!(
            r.chat_key, None,
            "канал адресуется channel:<id>, а не отправителю — ключ строит адаптер"
        );
    }

    #[test]
    fn test_classify_group_service() {
        // group-avatars.js: {hav:1} — запрос аватарки группы
        let r = classify(r#"{"hav":1}"#, "alice@test.com").unwrap();
        assert_eq!(r.kind, ClassifyKind::GroupService);
        assert_eq!(r.chat_key, None);
    }

    #[test]
    fn test_classify_non_vault_returns_none() {
        assert!(classify("plain text", "x@test.com").is_none());
        assert!(classify(r#"{"foo":"bar"}"#, "x@test.com").is_none());
        assert!(classify(r#"[]"#, "x@test.com").is_none());
        // vault=1 без `text` строкой — не конверт (даже если есть name/avatar)
        assert!(classify(r#"{"vault":1,"name":"X"}"#, "x@test.com").is_none());
        assert!(classify(r#"{"vault":1}"#, "x@test.com").is_none());
        // meta группы обрабатывает group-meta.js, а не роутер
        assert!(classify(r#"{"meta":1,"name":"G","avatar":"a"}"#, "x@test.com").is_none());
    }

    #[test]
    fn test_classify_kind_vocabulary() {
        // Словарь обязан совпадать с ожиданиями фикстуры (`kind`).
        assert_eq!(ClassifyKind::Channel.to_string(), "channel");
        assert_eq!(ClassifyKind::GroupService.to_string(), "group-service");
    }

    #[test]
    fn test_classify_default() {
        let def = ClassifyResult::default();
        assert_eq!(def.kind, ClassifyKind::Unknown);
        assert!(def.msg_type.is_none());
    }
}
