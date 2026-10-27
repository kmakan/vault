//! TURN REST API: ВРЕМЕННЫЕ креды для нашего coturn (`use-auth-secret`).
//!
//! Зачем не статический пароль: кред, вшитый в APK, вытаскивается из бинаря
//! за минуты — и чужие пользователи получают безлимитный relay-трафик за наш
//! счёт (в `media.rs` до этого `VAULT_TURN_CRED` просто не был задан ни в
//! одной сборке, поэтому TURN не работал вообще и звонки не жили вне одной
//! подсети). Схема coturn «RESTRICTED AUTH»: секрет живёт ТОЛЬКО на сервере,
//! клиенту выдаётся пара `(username, credential)`, где
//! `username = "<истечение>:<метка аккаунта>"`, а
//! `credential = base64(HMAC-SHA1(секрет, username))`. Coturn сам сверяет
//! срок из username и сам пересчитывает HMAC — подделать пару без секрета
//! нельзя, а украденная пара протухает через `CRED_TTL`.
//!
//! Квота — НЕ здесь: выдача кредитов тратит общий суточный бюджет релея
//! токена (тот же счётчик `t:<hash>` и тот же порог `daily_limit_for_token`,
//! что у конвертов) — так в тарифной сетке остаётся одно число, а не второе
//! необъяснимое. Одна выдача покрывает `CRED_TTL` часов разговора: клиент
//! кэширует пару, поэтому лимит конвертов расходуется звонками медленно.
//! Здесь — только формула пары и URL'ы.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;

/// Срок жизни выданной пары, сек. Coturn отклоняет Allocate, если
/// `<истечение>` в username уже прошло, — продлевать её нельзя по замыслу.
pub const CRED_TTL: u64 = 3600;

/// Хост coturn по умолчанию (VAULT_TURN_HOST перебивает — dev/переезд).
pub const DEFAULT_HOST: &str = "185.180.199.237";

/// Конфиг выдачи: секрет (`VAULT_TURN_SECRET`, он же `static-auth-secret`
/// coturn) и хост. Нет секрета — конфигурации нет, эндпоинт отвечает 503, а не
/// выдаёт пустые креды: «TURN выключен» должно быть видно клиенту.
#[derive(Debug, Clone)]
pub struct TurnConfig {
    pub secret: String,
    pub host: String,
}

impl TurnConfig {
    /// Поднять конфиг из окружения. Пустой/пробельный секрет = не задан.
    pub fn from_env() -> Option<Self> {
        let secret = std::env::var("VAULT_TURN_SECRET").ok()?;
        if secret.trim().is_empty() {
            return None;
        }
        let host = std::env::var("VAULT_TURN_HOST")
            .ok()
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_owned());
        Some(Self { secret, host })
    }
}

/// username по схеме coturn: `<unix-истечение>:<метка>`. Метка — хэш токена
/// (в лог coturn уходит метка, а не токен: по ней видно, кто жрёт relay,
/// не раскрывая ничего восстанавливаемого).
pub fn username(now: u64, ttl: u64, tag: &str) -> String {
    format!("{}:{}", now + ttl, tag)
}

/// credential = base64(HMAC-SHA1(secret, username)) — ровно то, что ждёт
/// coturn при `use-auth-secret`.
pub fn credential(secret: &str, username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC принимает ключ любой длины");
    mac.update(username.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

/// TURN-URL'ы для клиента. UDP — основной путь, TCP — страховка для сетей,
/// где UDP режут (офисы, часть мобильных операторов). TLS-порт (5349) не
/// включаем: на coturn он не настроен, а битый URL в конфиге ICE стоит
/// лишних секунд gathering.
pub fn uris(host: &str) -> Vec<String> {
    vec![
        format!("turn:{host}:3478"),
        format!("turn:{host}:3478?transport=tcp"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_neset_isteczenie_i_metku() {
        // Схема coturn: «<истечение>:<метка>» — срок берётся из username,
        // поэтому протухшую пару сервер отвергает сам, без нашего кода.
        assert_eq!(username(1_000, 60, "abc"), "1060:abc");
    }

    #[test]
    fn credential_sovpadaet_s_izvestnym_hmac_sha1() {
        // Независимая проверка формулы (REST-креды coturn): HMAC-SHA1("key",
        // "The quick brown fox jumps over the lazy dog") в base64 — сверено с
        // `openssl dgst -sha1 -hmac key`. Если формула уедет — тест падает
        // первым, до живого coturn.
        assert_eq!(
            credential("key", "The quick brown fox jumps over the lazy dog"),
            "3nybhbi3iqa8ino29wqQcBydtNk="
        );
    }

    #[test]
    fn credential_zavisit_ot_sekreta_i_username() {
        let u = username(0, 60, "tag");
        assert_ne!(credential("s1", &u), credential("s2", &u));
        assert_ne!(credential("s1", &u), credential("s1", "другой"));
    }

    #[test]
    fn uri_udp_i_tcp_na_odin_host() {
        let u = uris("203.0.113.7");
        assert_eq!(u.len(), 2, "UDP + TCP страховка");
        assert_eq!(u[0], "turn:203.0.113.7:3478");
        assert_eq!(u[1], "turn:203.0.113.7:3478?transport=tcp");
    }
}
