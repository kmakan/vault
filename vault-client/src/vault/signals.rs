//! Wire-форматы сервисных сигналов и data-писем — Rust core.
//!
//! ADR-005 R1 (эпик W4, `t_821261f7`): «решение о протоколе и формате — в
//! Rust». Здесь живут форматы, которые раньше разбирались в JS:
//!
//! * **data-письмо (download-on-demand)** — `{vault_dod_data: 1, ref, data}`.
//!   Тело вложения (десятки МБ) едет отдельным письмом; получатель тянет его
//!   по требованию (клик по карточке), а не автоматически.
//! * **сигнал звонка** — живёт в соседнем модуле `call` (`parse_call_signal`),
//!   потому что у него своя модель (`CallSignal`).
//!
//! Почему формат должен быть в ядре, а не в JS: отправитель и получатель
//! разбирают его на двух разных концах протокола. Пока правило было описано в
//! JS, «что считается data-письмом» знал только фронт — а разбор в Rust
//! (`incoming::classify`) о таком письме не знал вовсе и принимал его за
//! обычный конверт.

use serde::Serialize;

/// Разобранное data-письмо (download-on-demand).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DodData {
    /// Ссылка на исходное вложение (Message-ID мета-карточки).
    #[serde(rename = "ref")]
    pub reference: String,
    /// Содержимое вложения (base64).
    pub data: String,
}

/// Разобрать data-письмо. `None` — это не data-письмо.
///
/// Правила (те же, что были в JS):
///   * `vault_dod_data` строго равно 1 (не «truthy»): `0`/`2` — другой формат;
///   * `ref` — строка (пустая, если нет);
///   * `data` — непустая строка (пустое тело — не payload, а мусор: получатель
///     не сможет подставить файл, и карточка вложения останется битой).
pub fn parse_dod_data(plain: &str) -> Option<DodData> {
    if plain.is_empty() {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;
    if !obj.is_object() {
        return None;
    }
    if obj.get("vault_dod_data").and_then(|v| v.as_i64()) != Some(1) {
        return None;
    }
    let reference = obj
        .get("ref")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let data = obj.get("data").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if data.is_empty() {
        return None;
    }
    Some(DodData { reference, data })
}

/// Собрать data-письмо.
///
/// Порядок полей прежний (`vault_dod_data`, `ref`, `data`) — тело письма
/// шифруется, и побайтовое отличие из-за переезда формата недопустимо.
pub fn build_dod_data(reference: &str, data: &str) -> String {
    #[derive(Serialize)]
    struct Dod<'a> {
        vault_dod_data: u8,
        #[serde(rename = "ref")]
        reference: &'a str,
        data: &'a str,
    }
    let env = Dod {
        vault_dod_data: 1,
        reference,
        data,
    };
    serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string())
}

/// Разобранный сервисный сигнал — то, что НЕ является сообщением.
///
/// Это «второй слой» протокола рядом с конвертом: письма-сигналы (реакция,
/// правка, квитанция, голос, presence) и групповые служебные (meta, hav).
/// Раньше JS разбирал их сам, одинаково в двух местах (личные чаты и группы),
/// и местами РАЗНЫМИ правилами — например, квитанцию о доставке личные чаты
/// скрывали, а групповые показывали как обычный текст.
///
/// Порядок проверок зафиксирован и совпадает с тем, что был в JS:
/// реакция → правка → квитанция → голос → presence → meta → hav.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalEnvelope {
    /// Реакция на сообщение: `{react:1, msg_id, emoji, action?}`.
    Reaction {
        msg_id: String,
        emoji: String,
        /// `add` или `remove` (любое другое значение — как `add`).
        action: String,
    },
    /// Правка или удаление сообщения: `{edit:1, msg_id, text?, action?, ts?, sender?}`.
    Edit {
        msg_id: String,
        text: String,
        /// `edit` или `delete` (любое другое значение — как `edit`).
        action: String,
        ts: i64,
        sender: String,
    },
    /// Квитанция получателя: `{read:1|delivered:1, msg_ids:[...]}`.
    Ack {
        /// `read` или `delivered`.
        level: String,
        msg_ids: Vec<String>,
    },
    /// Голос в опросе: `{poll:1, poll_id, option}`.
    PollVote { poll_id: String, option: i64 },
    /// Heartbeat собеседника: `{presence:1, ts?}`.
    Presence { ts: i64 },
    /// Мета группы: `{meta:1, avatar?, name?, ts?}`.
    ///
    /// Аватар и имя — по отдельности необязательные: личные чаты берут из
    /// меты аватар, скан мета-группы — ещё и имя. Что именно применять —
    /// решение вызывающего (это отображение, а не формат).
    GroupMeta {
        avatar: String,
        name: String,
        ts: i64,
    },
    /// Запрос аватарки группы: `{hav:1}`.
    GroupAvatarHeal,
}

/// Разобрать сервисный сигнал. `None` — это не сигнал (обычное письмо).
///
/// Правила (те же, что были в JS):
///   * реакция: `react` строго 1, есть `msg_id` и `emoji`;
///   * правка: `edit` строго 1, есть `msg_id`; `text` — строка (иначе пусто),
///     `action` — `delete` иначе `edit`, `ts` — число, `sender` — строка;
///   * квитанция: `read` или `delivered` строго 1 и `msg_ids` — массив строк
///     (пустой массив — квитанция без адресатов: разбирается, но адресатов нет);
///   * голос: `poll` строго 1 и есть `poll_id`; `option` — число (0 иначе);
///   * presence: `presence` строго 1; `ts` — число;
///   * meta: `meta` строго 1 и непустой `avatar`;
///   * hav: `hav` строго 1.
pub fn parse_signal(plain: &str) -> Option<SignalEnvelope> {
    if plain.is_empty() {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;
    if !obj.is_object() {
        return None;
    }
    let is_one = |key: &str| obj.get(key).and_then(|v| v.as_i64()) == Some(1);

    // 1. Реакция
    if is_one("react") {
        let msg_id = string_field(&obj, "msg_id");
        let emoji = string_field(&obj, "emoji");
        if !msg_id.is_empty() && !emoji.is_empty() {
            return Some(SignalEnvelope::Reaction {
                msg_id,
                emoji,
                action: if string_field(&obj, "action") == "remove" {
                    "remove".to_string()
                } else {
                    "add".to_string()
                },
            });
        }
    }

    // 2. Правка
    if is_one("edit") {
        let msg_id = string_field(&obj, "msg_id");
        if !msg_id.is_empty() {
            return Some(SignalEnvelope::Edit {
                msg_id,
                text: string_field(&obj, "text"),
                action: if string_field(&obj, "action") == "delete" {
                    "delete".to_string()
                } else {
                    "edit".to_string()
                },
                ts: obj.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
                sender: string_field(&obj, "sender"),
            });
        }
    }

    // 3. Квитанция получателя
    if is_one("read") || is_one("delivered") {
        if let Some(arr) = obj.get("msg_ids").and_then(|v| v.as_array()) {
            let msg_ids: Vec<String> = arr
                .iter()
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();
            return Some(SignalEnvelope::Ack {
                level: if is_one("read") { "read" } else { "delivered" }.to_string(),
                msg_ids,
            });
        }
    }

    // 4. Голос в опросе
    if is_one("poll") {
        let poll_id = string_field(&obj, "poll_id");
        if !poll_id.is_empty() {
            return Some(SignalEnvelope::PollVote {
                poll_id,
                option: obj.get("option").and_then(|v| v.as_f64()).map(|v| v as i64).unwrap_or(0),
            });
        }
    }

    // 5. Presence
    if is_one("presence") {
        return Some(SignalEnvelope::Presence {
            ts: obj.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
        });
    }

    // 6. Мета группы (аватар)
    if is_one("meta") {
        return Some(SignalEnvelope::GroupMeta {
            avatar: string_field(&obj, "avatar"),
            name: string_field(&obj, "name"),
            ts: obj.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
        });
    }

    // 7. Запрос аватарки группы
    if is_one("hav") {
        return Some(SignalEnvelope::GroupAvatarHeal);
    }

    None
}

fn string_field(obj: &serde_json::Value, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_ref_and_data() {
        let plain = r#"{"vault_dod_data":1,"ref":"vault-abc@x","data":"BASE64"}"#;
        let d = parse_dod_data(plain).expect("data-письмо разобрано");
        assert_eq!(d.reference, "vault-abc@x");
        assert_eq!(d.data, "BASE64");
    }

    #[test]
    fn parse_rejects_not_dod() {
        assert!(parse_dod_data("").is_none());
        assert!(parse_dod_data("не json").is_none());
        assert!(parse_dod_data("[]").is_none());
        assert!(
            parse_dod_data(r#"{"ref":"x","data":"y"}"#).is_none(),
            "без метки vault_dod_data — не data-письмо"
        );
        assert!(
            parse_dod_data(r#"{"vault_dod_data":0,"ref":"x","data":"y"}"#).is_none(),
            "метка не равна 1 — другой формат"
        );
        assert!(
            parse_dod_data(r#"{"vault_dod_data":2,"ref":"x","data":"y"}"#).is_none(),
            "метка не равна 1 — другой формат"
        );
    }

    #[test]
    fn parse_rejects_empty_data() {
        // Пустое тело — не payload: получатель подставит пустой файл, и
        // карточка вложения останется битой.
        assert!(parse_dod_data(r#"{"vault_dod_data":1,"ref":"x","data":""}"#).is_none());
        assert!(parse_dod_data(r#"{"vault_dod_data":1,"ref":"x"}"#).is_none());
    }

    #[test]
    fn parse_missing_ref_is_empty() {
        let d = parse_dod_data(r#"{"vault_dod_data":1,"data":"B"}"#).expect("разобрано");
        assert_eq!(d.reference, "", "нет ref — пустая ссылка");
        assert_eq!(d.data, "B");
    }

    #[test]
    fn build_roundtrips_parse() {
        let json = build_dod_data("vault-abc@x", "BASE64");
        let d = parse_dod_data(&json).expect("собранное разбирается обратно");
        assert_eq!(d.reference, "vault-abc@x");
        assert_eq!(d.data, "BASE64");
    }

    // ── Роутер сервисных сигналов ──────────────────────────────────────
    #[test]
    fn signal_reaction() {
        let s = parse_signal(r#"{"react":1,"msg_id":"m1","emoji":"👍"}"#).expect("сигнал");
        match s {
            SignalEnvelope::Reaction { msg_id, emoji, action } => {
                assert_eq!(msg_id, "m1");
                assert_eq!(emoji, "👍");
                assert_eq!(action, "add", "без action — это добавление");
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_reaction_remove() {
        let s = parse_signal(r#"{"react":1,"msg_id":"m1","emoji":"👍","action":"remove"}"#)
            .expect("сигнал");
        match s {
            SignalEnvelope::Reaction { action, .. } => assert_eq!(action, "remove"),
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_reaction_requires_id_and_emoji() {
        assert!(parse_signal(r#"{"react":1,"emoji":"👍"}"#).is_none(), "нет msg_id");
        assert!(parse_signal(r#"{"react":1,"msg_id":"m1"}"#).is_none(), "нет emoji");
        assert!(parse_signal(r#"{"react":2,"msg_id":"m1","emoji":"x"}"#).is_none(), "метка не 1");
    }

    #[test]
    fn signal_edit() {
        let s = parse_signal(r#"{"edit":1,"msg_id":"m1","text":"новый","action":"edit","ts":42,"sender":"a@x"}"#)
            .expect("сигнал");
        match s {
            SignalEnvelope::Edit { msg_id, text, action, ts, sender } => {
                assert_eq!(msg_id, "m1");
                assert_eq!(text, "новый");
                assert_eq!(action, "edit");
                assert_eq!(ts, 42);
                assert_eq!(sender, "a@x");
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_edit_delete_defaults() {
        let s = parse_signal(r#"{"edit":1,"msg_id":"m1","action":"delete"}"#).expect("сигнал");
        match s {
            SignalEnvelope::Edit { text, action, ts, sender, .. } => {
                assert_eq!(text, "", "нет текста — пустой");
                assert_eq!(action, "delete");
                assert_eq!(ts, 0);
                assert_eq!(sender, "");
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_edit_requires_msg_id() {
        // Правка без msg_id ни к чему не привязана — это мусор, а не правка.
        assert!(parse_signal(r#"{"edit":1,"text":"x"}"#).is_none());
    }

    #[test]
    fn signal_poll_vote_requires_poll_id() {
        // Голос без poll_id не привязан к опросу.
        assert!(parse_signal(r#"{"poll":1,"option":1}"#).is_none());
    }

    #[test]
    fn signal_ack_read_and_delivered() {
        let s = parse_signal(r#"{"read":1,"msg_ids":["m1","m2"]}"#).expect("сигнал");
        match s {
            SignalEnvelope::Ack { level, msg_ids } => {
                assert_eq!(level, "read");
                assert_eq!(msg_ids, vec!["m1".to_string(), "m2".to_string()]);
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
        let d = parse_signal(r#"{"delivered":1,"msg_ids":["m1"]}"#).expect("сигнал");
        match d {
            SignalEnvelope::Ack { level, msg_ids } => {
                assert_eq!(level, "delivered");
                assert_eq!(msg_ids.len(), 1);
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_ack_requires_msg_ids_array() {
        assert!(parse_signal(r#"{"read":1}"#).is_none(), "без msg_ids — не квитанция");
        assert!(parse_signal(r#"{"read":1,"msg_ids":"m1"}"#).is_none(), "msg_ids не массив");
    }

    #[test]
    fn signal_poll_vote() {
        let s = parse_signal(r#"{"poll":1,"poll_id":"p1","option":2}"#).expect("сигнал");
        match s {
            SignalEnvelope::PollVote { poll_id, option } => {
                assert_eq!(poll_id, "p1");
                assert_eq!(option, 2);
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_presence() {
        let s = parse_signal(r#"{"presence":1,"ts":7}"#).expect("сигнал");
        match s {
            SignalEnvelope::Presence { ts } => assert_eq!(ts, 7),
            other => panic!("не тот сигнал: {:?}", other),
        }
    }

    #[test]
    fn signal_group_meta_and_hav() {
        let m = parse_signal(r#"{"meta":1,"avatar":"data:image/png;base64,A","ts":5}"#)
            .expect("сигнал");
        match m {
            SignalEnvelope::GroupMeta { avatar, name, ts } => {
                assert_eq!(avatar, "data:image/png;base64,A");
                assert_eq!(name, "");
                assert_eq!(ts, 5);
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
        // Мета без аватара, но с именем — тоже мета (имя применяет скан группы).
        let n = parse_signal(r#"{"meta":1,"name":"Команда"}"#).expect("сигнал");
        match n {
            SignalEnvelope::GroupMeta { avatar, name, .. } => {
                assert_eq!(avatar, "");
                assert_eq!(name, "Команда");
            }
            other => panic!("не тот сигнал: {:?}", other),
        }
        let h = parse_signal(r#"{"hav":1}"#).expect("сигнал");
        assert_eq!(h, SignalEnvelope::GroupAvatarHeal);
    }

    #[test]
    fn signal_ordinary_message_is_not_a_signal() {
        // Обычный конверт — не сигнал: роутер не должен проглатывать сообщения.
        assert!(parse_signal(r#"{"vault":1,"id":"m1","text":"привет"}"#).is_none());
        assert!(parse_signal("привет").is_none());
        assert!(parse_signal("").is_none());
        assert!(parse_signal("[]").is_none());
    }

    #[test]
    fn signal_order_reaction_wins_over_edit() {
        // Если в письме есть и react, и edit — это реакция (порядок прежний).
        let s = parse_signal(r#"{"react":1,"msg_id":"m1","emoji":"x","edit":1,"msg_id":"m1"}"#)
            .expect("сигнал");
        assert!(matches!(s, SignalEnvelope::Reaction { .. }));
    }

    #[test]
    fn build_keeps_field_order() {
        let json = build_dod_data("r", "d");
        let i_ref = json.find("\"ref\"").expect("есть ref");
        let i_data = json.find("\"data\"").expect("есть data");
        assert!(i_ref < i_data, "порядок полей прежний: ref, затем data");
        assert!(json.starts_with("{\"vault_dod_data\":1"), "маркер формата первым");
    }
}
