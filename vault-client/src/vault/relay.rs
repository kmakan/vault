// Push-релей (M2): дубль отправки на relay-сервер = мгновенная доставка
// (~1с вместо 30-60с email-транзита) + ntfy-пуш получателю.
// Дизайн — как в Desktop relay-client.js: релей НЕ заменяет почту,
// а дублирует; любая ошибка тихая, email — источник истины.
//
// Wire: POST /pub {v:1, to, id, exp, body(b64), from, tok, fp, wake}
//       POST /register {fp} → {token, topic, exp}
// Токены: myToken (моя очередь) + peer-токены {chatId: token} — получатель
// передаёт свой tok в конверте (M2.4 автообмен), CLI учитывает его в /read.
//
// HTTP: микро-клиент поверх native-tls (уже в дереве через lettre) —
// без reqwest/hyper: два POST'а не стоят 30+ крейтов.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

pub const DEFAULT_RELAY_URL: &str = "https://vault-msg.ru/relay";
/// Пейсинг между pub'ами разным адресатам: сервер релея ограничивает
/// 10 rps по адресату (§5.4) и считает суточный лимит на каждый pub.
const PUB_PACING_MS: u64 = 120;

// ───────────────────────── Персист (~/.vault/relay.json) ─────────────────────────

#[derive(Serialize, Deserialize, Default)]
pub struct RelayState {
    /// Релей включён — дублировать отправки.
    pub enabled: bool,
    /// Мой read-токен (адрес моей очереди; передаётся в конверте как
    /// `tok`, чтобы собеседник смог отвечать мгновенными пушами).
    pub my_token: String,
    /// Токены собеседников {chatId(lowercase): token} — куда публиковать.
    pub peers: HashMap<String, String>,
    /// UTC-день исчерпания лимита (429) — до конца дня не дёргаем pub.
    pub limit_day: Option<u64>,
    /// fp, к которому привязан my_token (токен привязан сервером к первому fp).
    pub fp_bound: Option<String>,
}

impl RelayState {
    fn path() -> std::path::PathBuf {
        dirs::home_dir()
            .map(|h| h.join(".vault/relay.json"))
            .unwrap_or_else(|| std::path::PathBuf::from(".vault/relay.json"))
    }

    pub fn load() -> Self {
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create ~/.vault dir")?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(self)?)
            .context("Failed to write relay.json")?;
        Ok(())
    }

    /// Обезличенный дамп для /relay status (без токенов).
    pub fn describe(&self) -> String {
        format!(
            "enabled: {} | myToken: {} | peers: {} | fp: {}",
            self.enabled,
            if self.my_token.is_empty() {
                "none"
            } else {
                "yes"
            },
            self.peers.len(),
            self.fp_bound.as_deref().unwrap_or("unbound")
        )
    }
}

// ───────────────────────── Микро-HTTP поверх native-tls ─────────────────────────

struct HttpResponse {
    status: u16,
    body: String,
}

/// Минимальный HTTPS POST (application/json). Соединение закрывается сразу
/// (Connection: close) — для 1-2 запросов на отправку keep-alive не нужен.
fn https_post_json(url: &str, body: &str) -> Result<HttpResponse> {
    let (host, path) = parse_url(url)?;
    let tls = native_tls::TlsConnector::new().context("TLS connector")?;
    let stream = std::net::TcpStream::connect((host.as_str(), 443u16))
        .with_context(|| format!("connect {host}:443"))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut tls = tls
        .connect(&host, stream)
        .with_context(|| format!("TLS handshake {host}"))?;
    use std::io::{Read, Write};
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    tls.write_all(req.as_bytes()).context("write request")?;
    let mut raw = String::new();
    tls.read_to_string(&mut raw).context("read response")?;
    parse_http_response(&raw)
}

/// `https://host/relay` → ("host", "/relay"); порт всегда 443.
fn parse_url(url: &str) -> Result<(String, String)> {
    let rest = url
        .strip_prefix("https://")
        .context("relay URL must be https://")?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    anyhow::ensure!(!host.is_empty(), "empty relay host");
    Ok((host.to_string(), format!("/{path}")))
}

fn parse_http_response(raw: &str) -> Result<HttpResponse> {
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("bad HTTP response"))?;
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .context("bad HTTP status line")?;
    // Chunked: собираем чанки без taille-анализа заголовков —
    // вырезаем только строку-размер перед каждым куском.
    let body = if head.to_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_string()
    };
    Ok(HttpResponse { status, body })
}

/// Склейка chunked-частей: каждая — `<hex-size>\r\n<данные>\r\n`, конец `0\r\n\r\n`.
fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some((size_line, tail)) = rest.split_once("\r\n") else {
            break;
        };
        let Ok(size) = usize::from_str_radix(size_line.trim(), 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        if tail.len() < size {
            out.push_str(tail);
            break;
        }
        let (chunk, next) = tail.split_at(size);
        out.push_str(chunk);
        rest = next.strip_prefix("\r\n").unwrap_or(next);
    }
    out
}

// ───────────────────────── Register / Publish ─────────────────────────

#[derive(Deserialize)]
struct RegisterOk {
    token: String,
}

/// Выдать свежий read-токен на нашем релее (3/день по IP; 30 дней free).
/// Токен привязывается к fp —Desktop-клиент с тем же ключом получит 403,
/// это анти-шаринг by design (один ключ = один токен = один аккаунт).
pub fn register(fp: &str) -> Result<String> {
    let body = serde_json::json!({ "fp": fp }).to_string();
    let res = https_post_json(&format!("{DEFAULT_RELAY_URL}/register"), &body)?;
    anyhow::ensure!(res.status == 200, "register: HTTP {}", res.status);
    let ok: RegisterOk = serde_json::from_str(&res.body).context("register: bad JSON response")?;
    Ok(ok.token)
}

/// Итог publish для вызывавшего (тихий — печать решает REPL).
#[derive(Debug, PartialEq)]
pub enum PubOutcome {
    Published,
    Disabled,
    NoMyToken,
    NoPeerToken,
    DailyLimit,
    /// Адрес получателя протух (402): peer забыт, ждём новый конверт от него.
    PeerExpired,
    Error(String),
}

/// Дубль конверта на релей (вызывается ПОСЛЕ SMTP-отправки).
/// `from` — email аккаунта (для серверной метрики и M2.4-автообмена),
/// `tok` в конверте получатель сохранит и сможет отвечать пушами.
pub fn publish(
    state: &mut RelayState,
    chat_id: &str,
    envelope_id: &str,
    encrypted_body: &str,
    from_email: &str,
    fp: &str,
) -> PubOutcome {
    if !state.enabled {
        return PubOutcome::Disabled;
    }
    if state.my_token.is_empty() {
        return PubOutcome::NoMyToken;
    }
    // Тихий фолбэк до конца UTC-дня после 429 (как в Desktop):
    // проверяем ДО peer-токена — лимит не зависит от адресата.
    let today = utc_day();
    if state.limit_day == Some(today) {
        return PubOutcome::DailyLimit;
    }
    let Some(peer_tok) = state.peers.get(&chat_id.to_lowercase()).cloned() else {
        return PubOutcome::NoPeerToken;
    };
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let body_b64 = B64.encode(encrypted_body);
    let exp = unix_now() + 24 * 3600;
    let req = serde_json::json!({
        "v": 1,
        "to": peer_tok,
        "id": envelope_id,
        "exp": exp,
        "body": body_b64,
        "from": from_email,
        "tok": state.my_token,
        "fp": fp,
        "wake": true,
    });
    match https_post_json(&format!("{DEFAULT_RELAY_URL}/pub"), &req.to_string()) {
        Ok(res) => match res.status {
            200 => PubOutcome::Published,
            429 => {
                // 429 бывает за суточную квоту ИЗДАТЕЛЯ и за вспышку запросов
                // (10 rps). Различает ядро — та же мера, что у десктопа; до
                // неё пачка сигналов звонка гасила pub до полуночи UTC.
                if vault_core::relay::pub_rejection(res.status, &res.body).kind
                    == vault_core::relay::REJECTION_DAILY
                {
                    state.limit_day = Some(today);
                    let _ = state.save();
                    PubOutcome::DailyLimit
                } else {
                    PubOutcome::Error("HTTP 429 rate limit".into())
                }
            }
            other => {
                if vault_core::relay::is_subscription_expired(other, &res.body) {
                    // Адрес получателя мёртв: держать его в peers = молчаливый
                    // 402 на каждой отправке. Забываем — слушатель выучит новый
                    // токен из первого же входящего конверта (автоонбординг).
                    state.peers.remove(&chat_id.to_lowercase());
                    let _ = state.save();
                    PubOutcome::PeerExpired
                } else {
                    PubOutcome::Error(format!("HTTP {other} {}", res.body))
                }
            }
        },
        Err(e) => PubOutcome::Error(e.to_string()),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn utc_day() -> u64 {
    unix_now() / 86400
}

// ───────────────────────── Приём (poll) ─────────────────────────

/// Конверт из relay-очереди (поле body декодировано из base64).
#[derive(Debug, Clone, PartialEq)]
pub struct RelayEnvelope {
    pub id: String,
    pub body: String,
    pub from: String,
}

/// GET /relay/poll?wait=0 с Authorization: VaultRelay <myToken> —
/// destructive read: забранное удаляется из очереди. 204 = очередь пуста.
pub fn poll(my_token: &str) -> Result<Vec<RelayEnvelope>> {
    let res = poll_http(my_token)?;
    parse_poll_envelopes(&res)
}

/// То же, но с различением протухания адреса: 402 от релея значит, что мёртв
/// НАШ read-токен и очередь не доживёт до следующего тика. Повтор запроса
/// бессмысленен — лечится только перерегистрацией.
pub enum PollOutcome {
    Envelopes(Vec<RelayEnvelope>),
    Expired,
    Failed(String),
}

pub fn poll_checked(my_token: &str) -> PollOutcome {
    let res = match poll_http(my_token) {
        Ok(res) => res,
        Err(e) => return PollOutcome::Failed(format!("{e:#}")),
    };
    if vault_core::relay::is_subscription_expired(res.status, &res.body) {
        return PollOutcome::Expired;
    }
    match parse_poll_envelopes(&res) {
        Ok(envs) => PollOutcome::Envelopes(envs),
        Err(e) => PollOutcome::Failed(format!("{e:#}")),
    }
}

fn poll_http(my_token: &str) -> Result<HttpResponse> {
    // Микро-GET поверх того же TLS-стека (код выше — POST; GET не несёт тела).
    let (host, path) = parse_url(&format!("{DEFAULT_RELAY_URL}/poll?wait=0"))?;
    let tls = native_tls::TlsConnector::new().context("TLS connector")?;
    let stream = std::net::TcpStream::connect((host.as_str(), 443u16))
        .with_context(|| format!("connect {host}:443"))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut tls = tls
        .connect(&host, stream)
        .with_context(|| format!("TLS handshake {host}"))?;
    use std::io::{Read, Write};
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: VaultRelay {my_token}\r\n\
         Connection: close\r\n\r\n"
    );
    tls.write_all(req.as_bytes()).context("write request")?;
    let mut raw = String::new();
    tls.read_to_string(&mut raw).context("read response")?;
    parse_http_response(&raw)
}

fn parse_poll_envelopes(res: &HttpResponse) -> Result<Vec<RelayEnvelope>> {
    if res.status == 204 || res.body.is_empty() {
        tracing::debug!("relay poll: empty (204)");
        return Ok(Vec::new());
    }
    anyhow::ensure!(res.status == 200, "poll: HTTP {}", res.status);
    let list: Vec<serde_json::Value> = serde_json::from_str(&res.body).context("poll: bad JSON")?;
    tracing::debug!("relay poll: {} envelope(s)", list.len());
    let mut out = Vec::new();
    for env in list {
        let id = env
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let from = env
            .get("from")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let Some(body_b64) = env.get("body").and_then(|v| v.as_str()) else {
            continue;
        };
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let Ok(body) = B64.decode(body_b64) else {
            continue;
        };
        let Ok(body) = String::from_utf8(body) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        out.push(RelayEnvelope { id, body, from });
    }
    Ok(out)
}

// ───────────────── Форма адресов: виртуальные письма релея ─────────────────

/// Папка-псевдоним виртуальных писем релея (во фронте — `folder: 'RELAY'`).
pub const VIRTUAL_FOLDER: &str = "RELAY";

/// Префикс виртуального id: `rl-<envId>` (тот же контракт у CLI: `listen.rs`).
pub const VIRTUAL_ID_PREFIX: &str = "rl-";

/// id письма-конверта релея таким, каким его видят UI и почтовые пути.
/// Строить его нужно в одном месте: `is_virtual_id` обязан узнавать результат.
pub fn envelope_id(env_id: &str) -> String {
    format!("{VIRTUAL_ID_PREFIX}{env_id}")
}

/// Папка виртуальная (релей): на IMAP её нет, тело уже в кэше фронта.
///
/// Протокольное решение, а не строка конфига. Раньше по «папке RELAY» шёл
/// настоящий SELECT («No such folder»), ошибка считалась сбоем сессии →
/// reconnect-шторм → рассыпалась общая IMAP-сессия, и отправка висела с
/// красным маркером, хотя письмо доходило релеем.
pub fn is_virtual_folder(folder: &str) -> bool {
    folder.eq_ignore_ascii_case(VIRTUAL_FOLDER)
}

/// Настоящий IMAP uid — только цифры.
///
/// Виртуальные письма релея (`rl-<envId>`) и записи без адреса (`''`,
/// `'undefined'`) на сервере не существуют: `UID FETCH` по ним всегда пуст, а
/// вызывающий принимал это за рассинхрон сессии → reconnect по лестнице
/// backoff и зависшая отправка.
pub fn is_imap_uid(uid: &str) -> bool {
    !uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit())
}

/// Это письмо — конверт релея (тела в IMAP нет, читать из кэша).
///
/// У CLI (`listen.rs`, `repl.rs`) и десктопного моста был ОДИН вопрос
/// («это не IMAP-письмо?») и ДВА ответа: `id.starts_with("rl-")` против
/// `!is_imap_uid(id)`. Здесь — обе формы, чтобы правило сверялось в одном
/// месте: `is_imap_uid` отвечает «есть ли это на сервере», `is_virtual_id` —
/// «это наш собственный конверт».
pub fn is_virtual_id(id: &str) -> bool {
    id.starts_with(VIRTUAL_ID_PREFIX)
}

// ───────────────────────── Тесты ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_url() {
        let (h, p) = parse_url("https://vault-msg.ru/relay").unwrap();
        assert_eq!(h, "vault-msg.ru");
        assert_eq!(p, "/relay");
        assert!(parse_url("http://vault-msg.ru").is_err());
        assert!(parse_url("https://").is_err());
    }

    #[test]
    fn test_parse_http_response_plain() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        let res = parse_http_response(raw).unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.body, "{\"ok\":true}");
    }

    #[test]
    fn test_dechunk() {
        // 2 чанка: 5 байт "hello" + 6 байт " world" + терминатор
        let body = "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(dechunk(body), "hello world");
        // Пустое тело
        assert_eq!(dechunk("0\r\n\r\n"), "");
    }

    #[test]
    fn test_relay_state_roundtrip() {
        let mut st = RelayState::default();
        st.enabled = true;
        st.my_token = "tok-abc".into();
        st.peers.insert("peer@x.ru".into(), "tok-def".into());
        let json = serde_json::to_string(&st).unwrap();
        let back: RelayState = serde_json::from_str(&json).unwrap();
        assert!(back.enabled);
        assert_eq!(back.my_token, "tok-abc");
        assert_eq!(back.peers.get("peer@x.ru").unwrap(), "tok-def");
    }

    #[test]
    fn test_publish_guards() {
        // disabled → без запросов
        let mut st = RelayState::default();
        assert_eq!(
            publish(&mut st, "a@b.c", "id1", "x", "me@x.ru", "fp"),
            PubOutcome::Disabled
        );
        // enabled без myToken
        st.enabled = true;
        assert_eq!(
            publish(&mut st, "a@b.c", "id1", "x", "me@x.ru", "fp"),
            PubOutcome::NoMyToken
        );
        // myToken без peer-токена
        st.my_token = "tok".into();
        assert_eq!(
            publish(&mut st, "a@b.c", "id1", "x", "me@x.ru", "fp"),
            PubOutcome::NoPeerToken
        );
        // daily-limit — без сети (текущий UTC-день)
        st.limit_day = Some(utc_day());
        st.peers.insert("a@b.c".into(), "pt".into());
        assert_eq!(
            publish(&mut st, "a@b.c", "id1", "x", "me@x.ru", "fp"),
            PubOutcome::DailyLimit
        );
    }

    #[test]
    fn virtual_addresses_are_not_imap_addresses() {
        // Виртуальная папка и виртуальный id НЕ должны уходить на сервер.
        for folder in ["RELAY", "relay", "Relay"] {
            assert!(is_virtual_folder(folder), "{folder}");
        }
        for folder in ["INBOX", "Junk", "", "RELAYX"] {
            assert!(!is_virtual_folder(folder), "{folder:?}");
        }
        for uid in ["1", "42", "636"] {
            assert!(is_imap_uid(uid), "{uid}");
        }
        for uid in ["rl-3fa85f64", "", "undefined", "12a", " 12", "-3"] {
            assert!(!is_imap_uid(uid), "{uid:?}");
        }
        assert!(is_virtual_id("rl-3fa85f64"));
        assert!(!is_virtual_id("42"));
        assert!(!is_virtual_id(""));

        // Построитель и распознаватель — один контракт: id, который отдаёт
        // релею, фронт обязан опознать как виртуальный и не-sendить на IMAP.
        let built = envelope_id("3fa85f64");
        assert_eq!(built, "rl-3fa85f64");
        assert!(is_virtual_id(&built), "envelope_id вне формы is_virtual_id");
        assert!(!is_imap_uid(&built));
    }
}
