//! Что значит отказ публикации релея: два несходных 429 — одна классификация.
//!
//! ЗАЧЕМ В ЯДРЕ. Сервер отвечает 429 в ДВУХ случаях, которые для клиента
//! значат противоположное: `daily relay limit reached` (суточная квота
//! издателя исчерпана — повторить можно только после полуночи UTC) и
//! `rate limit` (вспышка запросов, 10 rps — через секунду можно снова).
//! Пока во фронте была одна ветка на оба, любой 429 писал в kv «лимит дня»,
//! и релей замолкал на сутки. Звонок шлёт сигналы пачкой (setup + ICE-кандидаты
//! + accept), т.е. вспышка — ШТАТНЫЙ случай: «дозвонился — потерял ускорение до
//! полуночи» было живым поведением. Что значит ответ сервера — решение о
//! протоколе, поэтому оно здесь, а фронт только спрашивает.
//!
//! FAIL-OPEN. Не распознанный текст (чужой или более старый релей, битый JSON)
//! считаем ВСПЫШКОЙ, а не суточным лимитом: ошибка стоит одного лишнего
//! запроса, тогда как обратная ошибка — сутки без ускорения у живого
//! пользователя. Суточный лимит сервер не обходит ни в каком случае, поэтому
//! «недооценить» его безопасно, «переоценить» — нет.

use serde::Serialize;

/// Код, который сервер присылает при любом из лимитов.
pub const HTTP_TOO_MANY: u16 = 429;

/// Суточная квота издателя исчерпана: до конца UTC-дня pub не дёргаем.
pub const REJECTION_DAILY: &str = "daily";
/// Вспышка запросов: повторить можно почти сразу, лимит дня НЕ трогаем.
pub const REJECTION_RATE: &str = "rate";
/// Это не лимит (401/402/403/413 и т.п.) — у вызывающего своя ветка.
pub const REJECTION_OTHER: &str = "other";

/// Классификация отказа публикации. Имя ветки передаётся клиенту как есть,
/// поэтому оно — часть провода (тест держит литерал).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    /// `daily` | `rate` | `other` (см. константы).
    pub kind: &'static str,
    /// Секунд до повтора, если сервер назвал (`retry_after`); None — не сказал.
    pub retry_after: Option<u64>,
}

/// Отделить суточный лимит от вспышки по HTTP-коду и ТЕЛУ ответа.
/// `body` — текст ответа сервера (может быть пустым или не-JSON).
pub fn pub_rejection(status: u16, body: &str) -> Rejection {
    if status != HTTP_TOO_MANY {
        return Rejection {
            kind: REJECTION_OTHER,
            retry_after: None,
        };
    }
    let value = serde_json::from_str::<serde_json::Value>(body).ok();
    let retry_after = value
        .as_ref()
        .and_then(|v| v.get("retry_after").and_then(|r| r.as_u64()));
    // Признак суточного лимита — начало поля `error` (сервер пишет
    // «daily relay limit reached»); сверяем префикс, а не строку целиком,
    // чтобы правка формулировки в конце сообщения не молча превратила
    // лимит во «вспышку».
    let daily = value
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()))
        .map(|e| e.starts_with("daily"))
        .unwrap_or(false);
    Rejection {
        kind: if daily {
            REJECTION_DAILY
        } else {
            REJECTION_RATE
        },
        retry_after,
    }
}

/// 402 — адрес очереди протух. `POST /relay/pub` отвечает «recipient
/// subscription expired», `GET /relay/poll` — «subscription expired».
pub const HTTP_SUBSCRIPTION_EXPIRED: u16 = 402;

/// Общее у обоих ответов: у одного слова «recipient» перед ним.
const SUBSCRIPTION_EXPIRED_MARK: &str = "subscription expired";

/// Из всех отказов релея это единственный, который НЕ лечится повтором
/// запроса: свой токен меняют перерегистрацией, чужой адрес забывают и ждут
/// нового конверта от собеседника. Решение о протоколе живёт здесь, а не в
/// двух клиентах по копии (ADR-005).
pub fn is_subscription_expired(status: u16, body: &str) -> bool {
    status == HTTP_SUBSCRIPTION_EXPIRED && body.contains(SUBSCRIPTION_EXPIRED_MARK)
}

/// Формы read-токена (см. `vault-relay/src/tokens.rs`): длина
/// base64url-декодированных байтов.
pub const TOKEN_V1_LEN: usize = 45;
pub const TOKEN_V2_LEN: usize = 63;
/// Смещение поля срока: v1 — `expiry(4)` после key_id(8)+scope(1),
/// v2 — `paid_until(4)` после key_id+scope+ver+plan+sub+dev_nonce.
const TOKEN_V1_EXP: usize = 9;
const TOKEN_V2_EXP: usize = 27;

/// До какой секунды токен остаётся адресом живой очереди. mac не проверяем —
/// ключ сервера клиенту не положен; здесь нужен только срок. None — форма не
/// распознана (новый формат, битая строка).
pub fn token_expiry(token: &str) -> Option<u32> {
    let raw = base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        token.trim(),
    )
    .ok()?;
    let off = match raw.len() {
        TOKEN_V1_LEN => TOKEN_V1_EXP,
        TOKEN_V2_LEN => TOKEN_V2_EXP,
        _ => return None,
    };
    let four = raw.get(off..off + 4)?;
    Some(u32::from_be_bytes(<[u8; 4]>::try_from(four).ok()?))
}

/// Мёртв ли адрес: повторная отправка на такой токен гарантированно получит
/// 402, а заучивать его из истории почты опаснее, чем пропустить — мёртвый
/// адрес в памяти клиента неотличим от живого, пока не придёт тот же 402.
/// НЕИЗВЕСТНУЮ форму считаем ЖИВОЙ (fail-open): ошибка стоит одного лишнего
/// 402 на отправку, ложное «мёртв» — потерянный канал у живого собеседника.
pub fn is_token_dead(token: &str, now: u32) -> bool {
    token_expiry(token).is_some_and(|exp| exp <= now)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Тот текст, который реально отдаёт `vault-relay` (см. `relay_pub`).
    const DAILY_BODY: &str =
        "{\"error\":\"daily relay limit reached\",\"limit\":100,\"retry_after\":18640}";
    const RATE_BODY: &str = "{\"error\":\"rate limit\"}";

    #[test]
    fn daily_and_rate_429_are_different_branches() {
        assert_eq!(
            pub_rejection(429, DAILY_BODY),
            Rejection {
                kind: REJECTION_DAILY,
                retry_after: Some(18_640)
            }
        );
        assert_eq!(
            pub_rejection(429, RATE_BODY),
            Rejection {
                kind: REJECTION_RATE,
                retry_after: None
            }
        );
    }

    #[test]
    fn expired_queue_address_is_recognised_for_both_calls() {
        // 402 приходит и на pub (чужой адрес), и на poll (свой) — текст разный,
        // решение одно: повторять запрос бессмысленно.
        assert!(is_subscription_expired(
            402,
            "{\"error\":\"subscription expired\"}"
        ));
        assert!(is_subscription_expired(
            402,
            "{\"error\":\"recipient subscription expired\"}"
        ));
    }

    #[test]
    fn other_failures_are_not_expiry() {
        // Отзыв и «чужой fp» лечатся по-другому и не должны уходить в ветку
        // перерегистрации: 401/403 с похожим текстом — не протухание.
        assert!(!is_subscription_expired(401, "{\"error\":\"token revoked\"}"));
        assert!(!is_subscription_expired(403, "{\"error\":\"subscription expired\"}"));
        assert!(!is_subscription_expired(402, "{\"error\":\"bad recipient token\"}"));
        assert!(!is_subscription_expired(200, ""));
    }

    fn token(len: usize, exp_off: usize, expiry: u32) -> String {
        use base64::Engine as _;
        // 0xFF в mac-области обязательна: на нулевых байтах стандартный и
        // url-safe алфавиты дают одинаковую строку, и подмена алфавита прошла
        // бы незамеченной.
        let mut raw = vec![0xFFu8; len];
        raw[exp_off..exp_off + 4].copy_from_slice(&expiry.to_be_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&raw)
    }

    #[test]
    fn expiry_is_read_from_both_token_shapes() {
        // v1: key_id(8) scope(1) expiry(4) mac(32); v2: … paid_until(4) mac(32).
        assert_eq!(token_expiry(&token(45, 9, 1_800_000_000)), Some(1_800_000_000));
        assert_eq!(token_expiry(&token(63, 27, 1_900_000_000)), Some(1_900_000_000));
        // Просрочка = мёртвый адрес, ровный счёт «exp <= now»: в ту же секунду
        // сервер уже отвечает 402, а не принимает токен.
        assert!(is_token_dead(&token(45, 9, 100), 100));
        assert!(!is_token_dead(&token(45, 9, 101), 100));
    }

    #[test]
    fn unknown_token_shape_is_alive_not_dead() {
        // Битая строка, другой формат, мусор: считать их мёртвыми — значит
        // выбросить адрес живого собеседника.
        assert_eq!(token_expiry(""), None);
        assert_eq!(token_expiry("не токен!!"), None);
        assert_eq!(token_expiry(&token(44, 9, 1)), None);
        assert!(!is_token_dead(&token(50, 9, 1), 1_000));
    }

    #[test]
    fn unrecognised_429_is_transient_not_daily() {
        // Чужой/старый релей и битый ответ не имеют права гасить ускорение
        // на сутки — ошибка в эту сторону стоит только лишний запрос.
        for body in ["", "not json", "{}", "{\"error\":\"\"}", "[1,2]", "{\"error\":null}"] {
            assert_eq!(
                pub_rejection(429, body).kind,
                REJECTION_RATE,
                "тело {body:?} распознано не как вспышка"
            );
        }
    }

    #[test]
    fn only_the_daily_error_prefix_counts_as_daily() {
        // «daily» должно относиться именно к суточному лимиту: перефразировали
        // на «daily quota used up» — всё ещё daily, «limit reached» без daily —
        // уже не суточный лимит (иначе любое новое сообщение стало бы «днём»).
        assert_eq!(pub_rejection(429, "{\"error\":\"daily quota\"}").kind, REJECTION_DAILY);
        assert_eq!(pub_rejection(429, "{\"error\":\"relay limit reached\"}").kind, REJECTION_RATE);
        assert_eq!(pub_rejection(429, "{\"error\":\"Daily relay limit\"}").kind, REJECTION_RATE);
    }

    #[test]
    fn other_statuses_are_not_our_business() {
        // 401/402/403/413 у клиента собственные ветки (перерегистрация,
        // истёкшая подписка, перелимит тела) — классификатор их не трогает.
        for status in [200u16, 400, 401, 402, 403, 413, 500] {
            assert_eq!(
                pub_rejection(status, DAILY_BODY),
                Rejection {
                    kind: REJECTION_OTHER,
                    retry_after: None
                },
                "статус {status}"
            );
        }
    }

    #[test]
    fn retry_after_is_read_only_when_the_server_named_it() {
        assert_eq!(pub_rejection(429, DAILY_BODY).retry_after, Some(18_640));
        assert_eq!(pub_rejection(429, "{\"error\":\"daily x\"}").retry_after, None);
        // Число в поле, которого нет, строка, отрицательное — не «0» и не паника:
        // 0 означал бы «повтори сейчас» и клиент начал бы долбить сервер.
        for body in [
            "{\"retry_after\":\"soon\"}",
            "{\"retry_after\":-5}",
            "{\"retry_after\":1.5}",
            "{\"retry\":10}",
        ] {
            assert_eq!(pub_rejection(429, body).retry_after, None, "тело {body:?}");
        }
    }

    #[test]
    fn rejection_kinds_are_the_wire_names() {
        // Клиент сравнивает `kind` со строкой — имя ветки часть контракта.
        assert_eq!(REJECTION_DAILY, "daily");
        assert_eq!(REJECTION_RATE, "rate");
        assert_eq!(REJECTION_OTHER, "other");
        assert_eq!(HTTP_TOO_MANY, 429);
    }

    #[test]
    fn serialized_shape_is_camel_case_for_the_bridge() {
        let json = serde_json::to_string(&pub_rejection(429, DAILY_BODY)).expect("serialize");
        assert_eq!(json, "{\"kind\":\"daily\",\"retryAfter\":18640}");
    }
}
