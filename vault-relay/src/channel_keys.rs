// Ключи подписи постов канала (ADR-002, Этап 2 — серверная часть).
//
// ЗАЧЕМ. Канальный токен — bearer-credential, который сервер проверить не
// может: он выводится клиентом из broadcast-ключа, а ключа у сервера нет
// (docs/design/channels-protocol.md §4.1). И broadcast-ключ ЕСТЬ у
// подписчика (ссылка приглашения несёт `k=`, он нужен для дешифрования),
// поэтому подписчик вычисляет write-токен ЛЕГИТИМНО. Значит «публикует
// только владелец» держится лишь на клиенте.
//
// Закрываем это подписью Ed25519: владелец регистрирует публичный ключ,
// сервер проверяет подпись конверта. Подписчик приватным ключом не владеет.
//
// ИДЕНТИЧНОСТЬ ВЛАДЕЛЬЦА. Сервер не может отличить владельца от подписчика по
// broadcast-ключу — они одинаковы. Опора — ЛИЧНЫЙ токен владельца: сервер
// умеет его проверить (server_key есть только у него), и это доказывает, что
// запрос пришёл от владельца аккаунта, а не от держателя broadcast-ключа.
// Поэтому регистрация привязывает kid к hash личного токена.
//
// МИГРАЦИЯ. kid без регистрации → поведение v1 как сегодня (структура + kid).
// Ничего не ломается, старые каналы живут. Требовать подпись для всех можно
// только когда все живые каналы зарегистрированы — за это отвечает флаг
// REQUIRE_SIG (default off), а не логика по умолчанию.

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};

/// Канонический поток подписи. ОБЯЗАН совпадать с клиентским
/// (src-tauri/src/channel_signing.rs) байт-в-байт. Сборка здесь и там
/// раздельная намеренно: общий код потребовал бы общей зависимости клиента и
/// сервера, а расхождение должно ловиться падающим тестом на общий вектор,
/// а не компиляцией.
pub fn signing_input(kid: u64, env_id: &str, body: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(15 + 8 + env_id.len() + body.len());
    buf.extend_from_slice(b"channel-post:v2\0");
    buf.extend_from_slice(&kid.to_be_bytes());
    buf.extend_from_slice(env_id.as_bytes());
    buf.extend_from_slice(body.as_bytes());
    buf
}

/// Запись о владельце канала.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    /// hash ЛИЧНОГО токена владельца — доказательство права на регистрацию.
    pub owner_hash: String,
    /// Ed25519 public key, hex 32 байта.
    pub pubkey: String,
    pub created_at: u64,
}

/// Итог проверки подписи.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Verdict {
    /// Подпись верна.
    Ok,
    /// Подпись невалидна — публикацию отклонить.
    Invalid,
    /// kid не зарегистрирован: канал в режиме v1 (миграция).
    Unregistered,
}

/// Проверить подпись конверта против зарегистрированного ключа канала.
pub fn verify(entry: &Entry, sig_b64: &str, kid: u64, env_id: &str, body: &str) -> Verdict {
    let Ok(pk) = hex_decode32(&entry.pubkey) else { return Verdict::Invalid };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return Verdict::Invalid };
    let Some(sig_raw) = b64url_decode(sig_b64) else { return Verdict::Invalid };
    if sig_raw.len() != 64 {
        return Verdict::Invalid;
    }
    let Ok(sig) = Signature::from_slice(&sig_raw) else { return Verdict::Invalid };
    if vk
        .verify_strict(&signing_input(kid, env_id, body), &sig)
        .is_ok()
    {
        Verdict::Ok
    } else {
        Verdict::Invalid
    }
}

/// Политика приёма запроса регистрации — ЧИСТАЯ функция ради тестов.
/// Хендлер в main.rs обязан звать ровно её: иначе политика живёт в двух
/// местах и расходится тихо (как уже было с kid/token).
#[derive(Debug, PartialEq, Eq)]
pub enum RegisterDecision {
    /// Зарегистрировать: kid (канонической строкой) — ключ для карты.
    Accept { kid: String },
    /// Отклонить: HTTP-код + текст ошибки для клиента.
    Reject { status: u16, error: &'static str },
}

/// Параметры:
/// - owner_scope: 'r' | 'w' — личный токен владельца; None — токен не
///   разобран или это канальный токен (не доказательство владения).
/// - owner_expired — личный токен протух (parse его отдаёт, а не отбрасывает).
/// - chan_scope: 'c' — read-токен канала (адрес очереди), 'C' — write.
///   Write отвергаем: это право publish, а не адрес очереди.
/// - chan_kid: key_id канала из токена; None — токен не разобрался.
pub fn decide_registration(
    owner_scope: Option<char>,
    owner_expired: bool,
    chan_scope: Option<char>,
    chan_kid: Option<u64>,
    pubkey: &str,
) -> RegisterDecision {
    use RegisterDecision::{Accept, Reject};
    let bad = |status, error| Reject { status, error };
    let Some(os) = owner_scope else {
        return bad(401, "bad token");
    };
    if !matches!(os, 'r' | 'w') {
        return bad(403, "personal token required");
    }
    if owner_expired {
        return bad(402, "token expired");
    }
    let Some(cs) = chan_scope else {
        return bad(400, "bad channel token");
    };
    if cs != 'c' {
        return bad(400, "channel read token required");
    }
    let Some(kid) = chan_kid else {
        return bad(400, "bad channel token");
    };
    let pk = pubkey.trim();
    if pk.len() != 64 || !pk.chars().all(|c| c.is_ascii_hexdigit()) {
        return bad(400, "bad pubkey");
    }
    // Честное ограничение проверки: ed25519-dalek 2.1 принимает в from_bytes
    // почти любую 32-байтовую строку (включая точки малого порядка) — строгую
    // проверку делает verify_strict в момент verify. Здесь требуем только hex
    // форму: подпись под слабым ключом всё равно не пройдёт verify.
    Accept { kid: kid.to_string() }
}

/// Проверка для пути, где регистрации может не быть.
pub fn verify_optional(
    entry: Option<&Entry>,
    sig_b64: Option<&str>,
    kid: u64,
    env_id: &str,
    body: &str,
    require_sig: bool,
) -> Verdict {
    match entry {
        None => {
            if require_sig {
                // Канал не зарегистрирован, а режим «требуем подпись»:
                // публиковать нечем — иначе это дыра, которую флаг закрывает.
                Verdict::Invalid
            } else {
                Verdict::Unregistered
            }
        }
        Some(e) => match sig_b64 {
            None => Verdict::Invalid,
            Some(sig) => verify(e, sig, kid, env_id, body),
        },
    }
}

fn hex_decode32(s: &str) -> Result<[u8; 32], ()> {
    let s = s.trim();
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(());
    }
    let v = hex::decode(s).map_err(|_| ())?;
    let arr: [u8; 32] = v.try_into().map_err(|_| ())?;
    Ok(arr)
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Вектор общий с клиентом: seed=01×32, kid=AABBCCDDEFF0011, env=env-42,
    // body=body. Клиентский тест channel_signing::shared_vector_with_relay
    // ждёт ровно это значение. Если стороны разойдутся — упадёт здесь.
    const SIG: &str = "NHE134KLpo62R751EV6odt33b6Y1rdHZOL_d_f8GD3ogFQVQZWVyMSSXm5QJdUqMMJxVxNlvhe_h74dMlv7yAw";
    const KID: u64 = 0xAABBCCDDEEFF0011;

    fn entry() -> Entry {
        // Публичный ключ, соответствующий seed=01×32 (выведен на клиенте).
        Entry {
            owner_hash: "deadbeef".into(),
            pubkey: "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c".into(),
            created_at: 0,
        }
    }

    #[test]
    fn shared_vector_matches_client() {
        match verify(&entry(), SIG, KID, "env-42", "body") {
            Verdict::Ok => {}
            v => panic!("общий вектор не сошёлся с клиентом: {v:?}"),
        }
    }

    #[test]
    fn signature_bound_to_kid_env_and_body() {
        assert!(matches!(verify(&entry(), SIG, KID ^ 1, "env-42", "body"), Verdict::Invalid));
        assert!(matches!(verify(&entry(), SIG, KID, "env-43", "body"), Verdict::Invalid));
        assert!(matches!(verify(&entry(), SIG, KID, "env-42", "B"), Verdict::Invalid));
    }

    #[test]
    fn unregistered_is_not_a_failure_in_migration_mode() {
        assert!(matches!(
            verify_optional(None, None, KID, "e", "b", false),
            Verdict::Unregistered
        ));
        // С REQUIRE_SIG незарегистрированный канал публиковать не может.
        assert!(matches!(
            verify_optional(None, None, KID, "e", "b", true),
            Verdict::Invalid
        ));
    }

    #[test]
    fn registered_channel_requires_a_signature() {
        // Подпись отсутствует → отказ, даже когда подпись вообще не требуется
        // для остальных каналов (это режим v2 для конкретного kid).
        assert!(matches!(
            verify_optional(Some(&entry()), None, KID, "env-42", "body", false),
            Verdict::Invalid
        ));
        assert!(matches!(
            verify_optional(Some(&entry()), Some(SIG), KID, "env-42", "body", false),
            Verdict::Ok
        ));
    }

    #[test]
    fn malformed_public_key_is_rejected() {
        let mut e = entry();
        e.pubkey = "zz".into();
        assert!(matches!(verify(&e, SIG, KID, "env-42", "body"), Verdict::Invalid));
        e.pubkey = "ff".into();
        assert!(matches!(verify(&e, SIG, KID, "env-42", "body"), Verdict::Invalid));
    }

    // Политика регистрации (ADR-002): единственный источник истины —
    // decide_registration. Хендлер обязан звать её, а не дублировать.
    use super::{decide_registration, RegisterDecision};

    const PUB: &str =
        "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

    #[test]
    fn registration_accepts_owner_read_or_write_with_channel_read() {
        // /register выдаёт read — владелец с ним ОБЯЗАН регистрироваться.
        assert!(matches!(
            decide_registration(Some('r'), false, Some('c'), Some(KID), PUB),
            RegisterDecision::Accept { .. }
        ));
        assert!(matches!(
            decide_registration(Some('w'), false, Some('c'), Some(KID), PUB),
            RegisterDecision::Accept { .. }
        ));
    }

    #[test]
    fn registration_kid_is_canonical_u64_string() {
        // Ключ карты — kid из токена строкой u64: без hex-вариантов '00ab'/'AB'.
        match decide_registration(Some('r'), false, Some('c'), Some(KID), PUB) {
            RegisterDecision::Accept { kid } => assert_eq!(kid, KID.to_string()),
            r => panic!("ожидали Accept, получили {r:?}"),
        }
    }

    #[test]
    fn registration_rejects_channel_write_token() {
        // Write-токен — право publish, а не адрес очереди: регистрировать по
        // нему нельзя (иначе подписчик привязал бы очередь к своему ключу).
        assert_eq!(
            decide_registration(Some('r'), false, Some('C'), Some(KID), PUB),
            RegisterDecision::Reject { status: 400, error: "channel read token required" }
        );
    }

    #[test]
    fn registration_rejects_channel_or_personal_tokens() {
        // Канальный токен вместо личного — не доказательство владения.
        assert_eq!(
            decide_registration(Some('c'), false, Some('c'), Some(KID), PUB),
            RegisterDecision::Reject { status: 403, error: "personal token required" }
        );
        // Протухший личный токен — тоже не доказательство.
        assert_eq!(
            decide_registration(Some('r'), true, Some('c'), Some(KID), PUB),
            RegisterDecision::Reject { status: 402, error: "token expired" }
        );
        // Битый токен канала.
        assert_eq!(
            decide_registration(Some('r'), false, None, None, PUB),
            RegisterDecision::Reject { status: 400, error: "bad channel token" }
        );
        // Read-токен канала без key_id: очередь не названа — привязывать ключ
        // не к чему. Без этой пробы `unwrap_or(0)` в этом месте не поймать.
        assert_eq!(
            decide_registration(Some('r'), false, Some('c'), None, PUB),
            RegisterDecision::Reject { status: 400, error: "bad channel token" }
        );
    }

    #[test]
    fn registration_rejects_off_curve_pubkey() {
        // ed25519-dalek 2.1 НЕ проверяет точку на кривой в from_bytes (принял
        // даже ff×32) — но verify_strict отвергает подписи под точками малого
        // порядка. Поэтому здесь честно два уровня:
        //  (а) мусор вместо hex — отказ сразу на регистрации;
        assert_eq!(
            decide_registration(Some('r'), false, Some('c'), Some(KID), "zz"),
            RegisterDecision::Reject { status: 400, error: "bad pubkey" }
        );
        //  (б) точка малого порядка (все-нули) — регистрация проходит, но
        //  verify под ней обязан отвергать (иначе это был бы вечный Invalid
        //  без понимания причины — см. verify ниже).
        let zero = "00".repeat(32);
        assert!(matches!(
            decide_registration(Some('r'), false, Some('c'), Some(KID), &zero),
            RegisterDecision::Accept { .. }
        ));
        let e = Entry { owner_hash: "x".into(), pubkey: zero, created_at: 0 };
        assert!(matches!(verify(&e, SIG, KID, "env-42", "body"), Verdict::Invalid));
    }

    #[test]
    fn whitespace_around_a_public_key_is_tolerated_on_both_sides() {
        // Ключ вставляют из буфера обмена / читают из JSON — пробелы и перевод
        // строки вокруг значения НЕ должны ни отклонять регистрацию, ни ломать
        // проверку уже сохранённого ключа. Без этой пробы `trim()` на обеих
        // сторонах — незамечаемый код (набор rust-relay-channel-keys).
        let spaced = format!("  {PUB}\n ");
        assert!(matches!(
            decide_registration(Some('r'), false, Some('c'), Some(KID), &spaced),
            RegisterDecision::Accept { .. }
        ));
        let e = Entry { owner_hash: "x".into(), pubkey: spaced, created_at: 0 };
        assert!(matches!(verify(&e, SIG, KID, "env-42", "body"), Verdict::Ok));
    }
}
