//! Канальный конверт — Rust core (ADR-005 R1, эпик W4 `t_821261f7`).
//!
//! Канал — не «наше» письмо: у него нет метки `vault`, своя рамка
//! `{channel:1, chan, ...}` и три вида содержимого (meta / post / hello).
//! Формат описан здесь, чтобы правило «что это за канальное письмо» не
//! расходилось между JS и ядром: разбор в `incoming::classify` (вид
//! `channel`) и разбор полей — в этом модуле.
//!
//! Разбор полей и применение — разные вещи: формат живёт в ядре, а
//! последствия (обновить аватар, показать пост, запомнить подписчика)
//! применяет JS.

use serde::Serialize;

/// Разобранный канальный конверт.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChannelEnvelope {
    /// Идентификатор канала (`chan`).
    pub chan: String,
    /// Идентификатор письма (`id`) — по нему дедуплицируются посты.
    pub id: String,
    /// `meta === 1` — обновление метаданных канала (имя/описание/аватар).
    pub is_meta: bool,
    /// `hello === 1` — подписчик поздоровался владельцу канала.
    pub is_hello: bool,
    /// `post` — присутствует пост (тело поста может быть пустым).
    pub has_post: bool,
    /// Тело поста (`post.body`).
    pub post_body: String,
    /// Картинки поста (`post.images`).
    pub post_images: Vec<String>,
    /// Имя канала (meta).
    pub name: String,
    /// Описание канала (meta). `None` — поля не было вовсе (важно: «не
    /// прислали» и «прислали пустое» — разные вещи).
    ///
    /// Поле ОТСУТСТВУЕТ в JSON, а не равно null: вызывающий проверяет
    /// «поле было?» через `about !== undefined` — и null прошёл бы эту
    /// проверку, хотя означает «не прислали».
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// Аватар канала (meta).
    pub avatar: String,
    /// Отпечаток владельца канала (meta).
    pub owner_fpr: String,
    /// Время поста (мс).
    pub ts: i64,
}

/// Разобрать канальный конверт. `None` — это не канальное письмо.
///
/// Правило «это канал»: поле `channel` строго равно 1 (как в прежнем JS:
/// `payload.channel === 1`). Всё остальное — поля содержимого.
pub fn parse_channel_envelope(plain: &str) -> Option<ChannelEnvelope> {
    if plain.is_empty() {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;
    if !obj.is_object() {
        return None;
    }
    if obj.get("channel").and_then(|v| v.as_i64()) != Some(1) {
        return None;
    }

    let mut env = ChannelEnvelope {
        chan: str_field(&obj, "chan"),
        id: str_field(&obj, "id"),
        is_meta: obj.get("meta").and_then(|v| v.as_i64()) == Some(1),
        is_hello: obj.get("hello").and_then(|v| v.as_i64()) == Some(1),
        name: str_field(&obj, "name"),
        about: obj
            .get("about")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        avatar: str_field(&obj, "avatar"),
        owner_fpr: str_field(&obj, "owner_fpr"),
        ts: obj.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
        ..Default::default()
    };

    if let Some(post) = obj.get("post") {
        // Пост присутствует, даже если тело пустое: «пост без текста» и
        // «поста нет» — разные вещи (первое увеличивает счётчик).
        env.has_post = !post.is_null() && post != &serde_json::Value::Bool(false);
        if post.is_object() {
            env.post_body = post
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            env.post_images = post
                .get("images")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|v| match v {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
        }
    }

    Some(env)
}

fn str_field(obj: &serde_json::Value, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meta_envelope() {
        let plain = r#"{"channel":1,"chan":"ch1","meta":1,"name":"Канал","about":"О нас","avatar":"AV","owner_fpr":"FP"}"#;
        let e = parse_channel_envelope(plain).expect("канальный конверт разобран");
        assert_eq!(e.chan, "ch1");
        assert!(e.is_meta);
        assert!(!e.is_hello);
        assert_eq!(e.name, "Канал");
        assert_eq!(e.about.as_deref(), Some("О нас"));
        assert_eq!(e.avatar, "AV");
        assert_eq!(e.owner_fpr, "FP");
    }

    #[test]
    fn absent_about_is_none_not_empty() {
        // «не прислали описание» и «прислали пустое» — разные вещи.
        let e = parse_channel_envelope(r#"{"channel":1,"chan":"ch1","meta":1}"#).expect("разобрано");
        assert!(e.about.is_none());
        let e2 = parse_channel_envelope(r#"{"channel":1,"chan":"ch1","meta":1,"about":""}"#)
            .expect("разобрано");
        assert_eq!(e2.about.as_deref(), Some(""), "пустая строка — это значение");
    }

    #[test]
    fn parses_post_envelope() {
        let plain = r#"{"channel":1,"chan":"ch1","id":"p1","post":{"body":"текст","images":["a","b"]},"ts":42}"#;
        let e = parse_channel_envelope(plain).expect("разобрано");
        assert!(e.has_post);
        assert_eq!(e.id, "p1");
        assert_eq!(e.post_body, "текст");
        assert_eq!(e.post_images, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(e.ts, 42);
    }

    #[test]
    fn post_without_body_is_still_a_post() {
        let e = parse_channel_envelope(r#"{"channel":1,"chan":"ch1","post":{}}"#).expect("разобрано");
        assert!(e.has_post, "пост есть, хоть и без тела");
        assert_eq!(e.post_body, "");
        assert!(e.post_images.is_empty());
    }

    #[test]
    fn missing_post_is_not_a_post() {
        let e = parse_channel_envelope(r#"{"channel":1,"chan":"ch1"}"#).expect("разобрано");
        assert!(!e.has_post);
    }

    #[test]
    fn parses_hello_envelope() {
        let e = parse_channel_envelope(r#"{"channel":1,"chan":"ch1","hello":1}"#).expect("разобрано");
        assert!(e.is_hello);
        assert!(!e.is_meta);
    }

    #[test]
    fn rejects_non_channel_payloads() {
        assert!(parse_channel_envelope("").is_none());
        assert!(parse_channel_envelope("не json").is_none());
        assert!(parse_channel_envelope("[]").is_none());
        assert!(parse_channel_envelope(r#"{"chan":"ch1"}"#).is_none(), "нет метки channel");
        assert!(
            parse_channel_envelope(r#"{"channel":0,"chan":"ch1"}"#).is_none(),
            "метка не равна 1"
        );
        assert!(
            parse_channel_envelope(r#"{"vault":1,"id":"m1","text":"x"}"#).is_none(),
            "обычный конверт — не канальный"
        );
    }
}
