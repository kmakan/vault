//! Сборка wire-конверта сообщения.
//!
//! ADR-005 R1 (эпик W4, `t_821261f7`): «решение о протоколе и формате —
//! в Rust». Формат конверта — это протокол: получатель разбирает его по
//! правилам, и правила должны быть одни и те же на обеих сторонах. Пока
//! сборка жила в JS (App.vue::buildEnvelope), а разбор — в Rust
//! (`incoming::classify`), формат был описан в двух местах: правка одной
//! стороны ломала другую тихо.
//!
//! Здесь — единственное место, где определено, КАКИЕ поля входят в конверт и
//! при каких условиях. JS получает готовую строку через мост и только
//! исполняет.
//!
//! Правила формата:
//!   * всегда: `vault` (маркер версии), `id`, `text`, `name`, `avatar`,
//!     `key` (публичный ключ отправителя), `ts` (момент отправки, мс);
//!   * `gavatar` — аватар ТЕКУЩЕЙ группы, только если он есть (групповое
//!     сообщение; в 1:1 поля нет);
//!   * `pq` — ML-KEM-ключ отправителя, только если у него есть гибрид;
//!   * `tok` — адрес relay-очереди отправителя, только если он есть (в 1:1
//!     поля нет; без токена собеседник не может слать мгновенные пуши);
//!   * `ttl` — время жизни в секундах, только если оно положительное (0 = обычное
//!     сообщение, получатель не ставит таймер удаления).
//!
//! Порядок полей в JSON сохраняется прежним: конверт — байты, которые
//! шифруются, и побайтовое отличие не должно появляться из-за переезда
//! формата (иначе старые и новые сборки дают разные шифротексты на одном тексте).

use serde::Serialize;

/// Данные конверта, собранные вызывающей стороной.
#[derive(Debug, Clone, Default, Serialize)]
pub struct EnvelopeInput {
    /// Идентификатор сообщения (заглушка `pending-…` или настоящий id).
    pub id: String,
    /// Текст сообщения.
    pub text: String,
    /// Отображаемое имя отправителя (пусто — отправляем без имени).
    pub name: String,
    /// Аватар отправителя (data-URL, уже сжатый).
    pub avatar: String,
    /// Аватар ТЕКУЩЕЙ группы (только для группового сообщения).
    pub gavatar: Option<String>,
    /// Публичный ключ отправителя (legacy X25519).
    pub key: String,
    /// Публичный ML-KEM-ключ отправителя (гибрид PQ).
    pub pq_ek: Option<String>,
    /// Relay read-токен отправителя (адрес его очереди).
    pub tok: Option<String>,
    /// Тип сообщения (`profile`, `sos`, `call_*`…): подтип определяет рендер,
    /// а не роутер. В обычном сообщении поля нет.
    pub msg_type: Option<String>,
    /// Время жизни в секундах (0 — обычное сообщение).
    pub ttl_secs: i64,
    /// Момент отправки, мс Unix-времени.
    pub ts_ms: i64,
}

/// Собрать конверт по правилам формата.
///
/// Возвращает JSON-строку. Порядок полей: `vault`, `id`, `text`, `name`,
/// `avatar`, `gavatar` (если есть), `key`, `ts`, `pq` (если есть), `tok`
/// (если есть), `ttl` (если положителен).
pub fn build(input: &EnvelopeInput) -> String {
    // serde_json с structs сохраняет порядок объявления полей — это и есть
    // требуемый порядок. Опциональные поля через `skip_serializing_if` дают
    // «поле отсутствует», а не «поле с null»: получатель отличает «нет
    // аватара» от «аватар null».
    #[derive(Serialize)]
    struct Envelope<'a> {
        vault: u8,
        id: &'a str,
        text: &'a str,
        name: &'a str,
        avatar: &'a str,
        #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
        msg_type: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gavatar: Option<&'a str>,
        key: &'a str,
        ts: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pq: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tok: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ttl: Option<i64>,
    }

    fn nonempty(s: &Option<String>) -> Option<&str> {
        s.as_deref().filter(|v| !v.is_empty())
    }

    let env = Envelope {
        vault: 1,
        id: &input.id,
        text: &input.text,
        name: &input.name,
        avatar: &input.avatar,
        msg_type: nonempty(&input.msg_type),
        gavatar: nonempty(&input.gavatar),
        key: &input.key,
        ts: input.ts_ms,
        pq: nonempty(&input.pq_ek),
        tok: nonempty(&input.tok),
        ttl: if input.ttl_secs > 0 {
            Some(input.ttl_secs)
        } else {
            None
        },
    };
    serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> EnvelopeInput {
        EnvelopeInput {
            id: "m1".into(),
            text: "привет".into(),
            name: "Аня".into(),
            avatar: "data:image/png;base64,AAA".into(),
            gavatar: None,
            key: "PUB".into(),
            pq_ek: None,
            tok: None,
            msg_type: None,
            ttl_secs: 0,
            ts_ms: 1700000000,
        }
    }

    #[test]
    fn minimal_envelope_fields() {
        let json = build(&sample());
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["vault"], 1);
        assert_eq!(v["id"], "m1");
        assert_eq!(v["text"], "привет");
        assert_eq!(v["name"], "Аня");
        assert_eq!(v["key"], "PUB");
        assert_eq!(v["ts"], 1700000000);
    }

    #[test]
    fn message_type_is_optional_but_kept_when_set() {
        let mut inp = sample();
        inp.msg_type = Some("sos".into());
        let v: serde_json::Value = serde_json::from_str(&build(&inp)).unwrap();
        assert_eq!(v["type"], "sos", "подтип сообщения доезжает до получателя");
        // В обычном сообщении поля нет — получатель сам поймёт, что это
        // обычное сообщение, а не «sos».
        let v2: serde_json::Value = serde_json::from_str(&build(&sample())).unwrap();
        assert!(v2.get("type").is_none(), "у обычного сообщения поля type нет");
    }

    #[test]
    fn optional_fields_absent_when_empty() {
        let v: serde_json::Value = serde_json::from_str(&build(&sample())).unwrap();
        assert!(v.get("gavatar").is_none(), "нет аватара группы — поля нет");
        assert!(v.get("pq").is_none(), "нет PQ-ключа — поля нет");
        assert!(v.get("tok").is_none(), "нет relay-токена — поля нет");
        assert!(v.get("ttl").is_none(), "ttl=0 — поля нет");
    }

    #[test]
    fn optional_fields_present_when_set() {
        let mut inp = sample();
        inp.gavatar = Some("data:image/png;base64,GGG".into());
        inp.pq_ek = Some("PQEK".into());
        inp.tok = Some("TOK".into());
        inp.ttl_secs = 3600;
        let v: serde_json::Value = serde_json::from_str(&build(&inp)).unwrap();
        assert_eq!(v["gavatar"], "data:image/png;base64,GGG");
        assert_eq!(v["pq"], "PQEK");
        assert_eq!(v["tok"], "TOK");
        assert_eq!(v["ttl"], 3600);
    }

    #[test]
    fn empty_optional_strings_are_treated_as_absent() {
        let mut inp = sample();
        inp.gavatar = Some(String::new());
        inp.pq_ek = Some(String::new());
        inp.tok = Some(String::new());
        let v: serde_json::Value = serde_json::from_str(&build(&inp)).unwrap();
        assert!(v.get("gavatar").is_none());
        assert!(v.get("pq").is_none());
        assert!(v.get("tok").is_none());
    }

    #[test]
    fn negative_ttl_is_absent() {
        let mut inp = sample();
        inp.ttl_secs = -5;
        let v: serde_json::Value = serde_json::from_str(&build(&inp)).unwrap();
        assert!(v.get("ttl").is_none(), "отрицательный ttl — поля нет");
    }

    #[test]
    fn field_order_is_stable() {
        // Порядок полей = байты конверта; переезд формата не должен менять
        // шифротекст на одном и том же содержимом.
        let json = build(&sample());
        let order: Vec<&str> = ["\"vault\"", "\"id\"", "\"text\"", "\"name\"", "\"avatar\"",
            "\"key\"", "\"ts\""].to_vec();
        let mut last = 0usize;
        for k in order {
            let pos = json.find(k).unwrap_or_else(|| panic!("нет поля {}", k));
            assert!(pos >= last, "порядок нарушен на {}", k);
            last = pos;
        }
    }

    #[test]
    fn text_with_quotes_is_escaped() {
        let mut inp = sample();
        inp.text = "кавычки \" и \\ и перенос\nстроки".into();
        let json = build(&inp);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["text"], "кавычки \" и \\ и перенос\nстроки");
    }
}
