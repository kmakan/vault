//! Vault relay — push-ускоритель поверх email-транспорта.
//! Дублирует (не заменяет) почтовую доставку: конверт уходит и письмом,
//! и на релей; кто первый — тот доставил. Сервер видит только
//! opaque-токены и зашифрованные байты (wire-формат не меняется).
//!
//! MVP scope (docs/design/relay-protocol.md §10): /relay/pub, /relay/poll,
//! /relay/ws, HMAC-auth, TTL 24ч, лимиты §5.4, /metrics.


use axum::{
    extract::{connect_info::ConnectInfo, Json, Query, State, WebSocketUpgrade, ws::Message},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json as AxumJson, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use vault_relay::store::Store;
use vault_relay::{ServerKeys, Scope};

/// Хранилище + ключи + метрики — общее состояние всех хендлеров.
pub struct AppState {
    pub store: Store,
    pub keys: ServerKeys,
    /// конфиг политики §9.1: разрешён ли publish без токена.
    pub allow_anonymous_pub: bool,
    pub metrics: Metrics,
    /// M2.4: rate-limit регистраций по IP: (счётчик, окно начала).
    pub registrations: std::sync::Mutex<std::collections::HashMap<String, (u32, u64)>>,
    /// Промо-ключ безлимита (VAULT_RELAY_UNLIMITED_KEY): тестерам/владельцу.
    pub unlimited_key: Option<String>,
    /// §0 company.md: суточный лимит бесплатных конвертов на издателя.
    /// Ключ — hash токена издателя (или IP при анонимном pub без tok),
    /// значение — (день UTC = now/86400, счётчик). In-memory: рестарт
    /// обнуляет счётчики — приемлемо (лимит щедрый, abuse-сценарий редок).
    pub daily_pub: std::sync::Mutex<std::collections::HashMap<String, (u64, u32)>>,
    /// Сколько конвертов в сутки бесплатно (0 = лимит выключен).
    pub free_daily_limit: u32,
    /// Привязка токена к аккаунту: token_hash → fingerprint (один токен =
    /// один аккаунт — защита от шаринга premium-токена между аккаунтами).
    /// In-memory: после рестарта перепривяжется к первому использовавшему;
    /// при монетизации — персист в relay.db вместе со счётчиками.
    pub token_bindings: std::sync::Mutex<std::collections::HashMap<String, String>>,

    /// M2.3-b: ntfy-мост — host:port ntfy (пусто = пушей нет). ntfy на
    /// том же сервере → plain HTTP на 127.0.0.1:8092, без TLS-зависимостей.
    pub ntfy_url: String,
    /// Пара-фикс ntfy (0.1.164): когда получатель последний раз сам
    /// забирал конверты (poll/ws). Если poll был недавно — процесс
    /// получателя жив (эко-тикер 5с, классика 30-60с) и сам покажет
    /// локальное уведомление; ntfy-будильник тогда НЕ шлём (дубль
    /// «шторка+пуш»). Молчащий >90с получатель (приложение смахнуто,
    /// эко-фон, мёртвый процесс) — будим ntfy, это единственный канал.
    /// Ключ — hash read-токена (тот же, что ntfy-topic). In-memory:
    /// рестарт релея = всем «молчащим», первый pub честно разбудит.
    pub last_seen: std::sync::Mutex<std::collections::HashMap<String, u64>>,
}

#[derive(Default)]
pub struct Metrics {
    pub pub_ok: AtomicU64,
    pub pub_anon: AtomicU64,
    pub poll_hits: AtomicU64,
    pub ws_sessions: AtomicU64,
    pub rejected: AtomicU64,
    pub register_ok: AtomicU64,
    /// §0: сколько раз упрели в суточный лимит (429).
    pub limit_hit: AtomicU64,
}

// ───────────────────────── Публикация (§5.1) ─────────────────────────

#[derive(Deserialize)]
pub struct PubRequest {
    pub v: u8,
    /// read-токен получателя (сервер знает только его).
    pub to: String,
    /// envelope id — тот же, что в письме (дедуп на клиенте).
    pub id: String,
    /// ttl конверта на релее, unix-секунды.
    pub exp: u64,
    /// зашифрованное тело письма, байт-в-байт.
    pub body: String,
    /// opaque-строка отправителя (опционально; ретранслируется как есть).
    #[serde(default)]
    pub tok: Option<String>,
    pub from: Option<String>,
    /// fingerprint аккаунта отправителя (первые байты публичного ключа,
    /// не секрет). Привязка токена к аккаунту — один токен = один
    /// аккаунт, premium нельзя расшарить (§ монетизация). Отсутствует
    /// у легаси-клиентов — тогда привязку не проверяем.
    #[serde(default)]
    pub fp: Option<String>,
    /// ntfy wake-up получателю нужен не всегда (default true): call-сигналы
    /// после call_request (accept/answer/end/reject) адресат забирает,
    /// уже будучи активным на звонке — пуш «Новое сообщение» приходил
    /// ПОСЛЕ принятия/завершения звонка (жалоба «лишние уведомления»).
    /// Легаси-клиенты поле не шлют → true (как было).
    #[serde(default = "default_true")]
    pub wake: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
pub struct PubOk {
    ok: bool,
    mid: String,
}

const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_QUEUE: usize = 200;

/// POST /relay/pub — положить конверт в очередь токена получателя.
/// Токен отправителя НЕ обязателен (политика §9.1 в конфиге):
/// read-токен в `to` — единственная адресация.
pub async fn relay_pub(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    AxumJson(req): AxumJson<PubRequest>,
) -> Response {
    if req.v != 1 {
        return err(StatusCode::BAD_REQUEST, "unsupported version");
    }
    // Размер: body — base64, но лимит считаем по декодированным байтам.
    let body_len = req.body.len() * 3 / 4;
    if body_len > MAX_BODY_BYTES {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::PAYLOAD_TOO_LARGE, "body over 64 KiB");
    }
    if req.id.len() > 128 || req.id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "bad id");
    }
    // `to` должен быть ВАЛИДНЫМ read-токеном (не обязательно активным:
    // истёкшая подписка получателя = 402, чтобы отправитель показал баннер).
    let to_tok = match vault_relay::parse(&app.keys, &req.to) {
        Some(t) if t.scope == Scope::Read => t,
        _ => {
            app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
            return err(StatusCode::BAD_REQUEST, "bad recipient token");
        }
    };
    if to_tok.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "recipient subscription expired");
    }
    // Анонимный publish (§9.1): без заголовка — только если разрешено конфигом.
    if let Some(auth) = auth_header(&headers) {
        match vault_relay::parse(&app.keys, &auth) {
            Some(t) if t.scope == Scope::Write && !t.is_expired() => {}
            Some(_) => return err(StatusCode::FORBIDDEN, "token scope mismatch"),
            None => {
                app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                return err(StatusCode::UNAUTHORIZED, "bad token");
            }
        }
    } else if !app.allow_anonymous_pub {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "token required");
    } else {
        app.metrics.pub_anon.fetch_add(1, Ordering::Relaxed);
    }
    // Rate-limit на publish (§5.4): 10 rps по ключу авторизации или по IP-фолбэку.
    if !vault_relay::rate::allow_pub(&req.to) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate limit");
    }
    // Привязка токена отправителя (tok в теле) к его fp: чужой fp =
    // токен скопирован на другой аккаунт → 403, письмо уйдёт почтой
    // (клиент не считает это ошибкой доставки). Работает независимо от
    // суточного лимита — защита от шаринга актуальна и для premium.
    if let Some(sender_tok) = req.tok.as_deref().filter(|s| !s.is_empty()) {
        if let Some(t) = vault_relay::parse(&app.keys, sender_tok) {
            if !check_token_binding(&app, &t.hash, &req.fp) {
                app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                return err(StatusCode::FORBIDDEN, "token bound to another account");
            }
        }
    }
    // §0 company.md: суточный бесплатный лимит конвертов на ИЗДАТЕЛЯ.
    // Идентичность издателя: tok в теле (read-токен отправителя, шлёт клиент
    // M2.4) → его hash; иначе Authorization (write-токен) → hash; иначе IP.
    // Premium (unlimited) токен отличается expiry: promo выдаётся на 10 лет
    // (>now+365д) — такие издатели лимита не имеют. Почта не ограничивается
    // никогда: 429 = только «ускорение» выключено, письмо уйдёт как обычно.
    if app.free_daily_limit > 0 {
        let (pub_key, premium) = publisher_key(&app, &headers, &req, &addr);
        if !premium {
            let day = now() / 86400;
            let mut map = app.daily_pub.lock().unwrap();
            let entry = map.entry(pub_key).or_insert((day, 0));
            if entry.0 != day {
                *entry = (day, 0);
            }
            if entry.1 >= app.free_daily_limit {
                app.metrics.limit_hit.fetch_add(1, Ordering::Relaxed);
                let retry_after = (day + 1) * 86400 - now();
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("retry-after", retry_after.to_string())],
                    AxumJson(serde_json::json!({
                        "error": "daily relay limit reached",
                        "limit": app.free_daily_limit,
                        "retry_after": retry_after,
                    })),
                )
                    .into_response();
            }
            entry.1 += 1;
        }
    }
    let mid = uuid::Uuid::new_v4().to_string();
    let envelope = vault_relay::store::Envelope {
        id: req.id,
        body: req.body,
        exp: req.exp.min(now() + 24 * 3600),
        ts: now(),
        from: req.from.filter(|s| !s.is_empty()).map(|s| s.chars().take(254).collect()),
        tok: req.tok.filter(|s| !s.is_empty()).map(|s| s.chars().take(254).collect()),
    };
    app.store.push(&to_tok.hash, envelope, MAX_QUEUE);
    app.metrics.pub_ok.fetch_add(1, Ordering::Relaxed);
    // M2.3-b: ntfy wake-up получателю (at-most-once, тише ошибки):
    // topic = хэш read-токена (opaque). Содержимое НЕ раскрывается —
    // «есть новое» + счётчик. Телефон, подписанный на topic, просыпается
    // от системного пуша и забирает конверты poll'ом (дедуп по id).
    // Пара-фикс (0.1.164): будим ТОЛЬКО молчащего получателя —
    // poll/ws за последние 90с = живой клиент сам покажет уведомление
    // (клиентская половина пары сняла эко-гейт локальной нотификации),
    // и без гейта здесь мы бы послали дубль (шторка + пуш). Молчащий
    // получатель — пуш обязателен, это его единственный канал.
    // wake=false (call-сигналы после request) — пуши НЕ шлём: адресат
    // уже активен на звонке, уведомление было бы лишним.
    if !app.ntfy_url.is_empty() && req.wake {
        let silent_for = {
            let seen = app.last_seen.lock().unwrap();
            seen.get(&to_tok.hash).map_or(u64::MAX, |t| now().saturating_sub(*t))
        };
        if silent_for >= 90 {
            let ntfy_url = app.ntfy_url.clone();
            let topic = to_tok.hash.clone();
            let total = app.store.len(&to_tok.hash);
            // Один pub = один wake-up. Дедуп контента на клиенте (env.id),
            // дедуп путей уведомлений — last_seen-гейт (один путь, не оба).
            tokio::task::spawn_blocking(move || {
                ntfy_publish(&ntfy_url, &topic, total);
            });
        }
    }
    (StatusCode::OK, AxumJson(PubOk { ok: true, mid })).into_response()
}

// ───────────────────────── Получение (§5.2) ─────────────────────────

#[derive(Deserialize)]
pub struct PollQuery {
    pub wait: Option<u64>,
}

/// GET /relay/poll?wait=25 — long-poll: до 25 конвертов, 204 по таймауту.
pub async fn relay_poll(
    State(app): State<Arc<AppState>>,
    Query(q): Query<PollQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(tok) = require_read(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "token required");
    };
    if tok.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");
    }
    // Привязка токена к аккаунту: чужой fingerprint = токен скопировали
    // на другое устройство → 403 (клиент перерегистрируется).
    if !check_token_binding(&app, &tok.hash, &poll_fp(&headers)) {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::FORBIDDEN, "token bound to another account");
    }
    if !vault_relay::rate::allow_poll(&tok.hash) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate limit");
    }
    let wait = q.wait.unwrap_or(0).min(25);
    // Пара-фикс (0.1.164): получатель жив — отмечаем его «видимым» для
    // ntfy-гейта (см. relay_pub). Даже 204-поллинг тикера = процесс жив.
    {
        let mut seen = app.last_seen.lock().unwrap();
        let t = now();
        let len_before = seen.len();
        seen.insert(tok.hash.clone(), t);
        // Гигиена карты: раз в ~500 записей выпарываем stale (>24ч) —
        // карта не растёт бесконечно на несуществующих токенах.
        if len_before % 500 == 499 {
            seen.retain(|_, ts| t.saturating_sub(*ts) < 86400);
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
    loop {
        if let Some(list) = app.store.drain(&tok.hash) {
            if !list.is_empty() {
                app.metrics.poll_hits.fetch_add(1, Ordering::Relaxed);
                return AxumJson(list).into_response();
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return StatusCode::NO_CONTENT.into_response();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// GET /relay/ws — WebSocket-приём: hello → msg-кадры → ack.
pub async fn relay_ws(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(tok) = require_read(&app, &headers) else {
        return err(StatusCode::UNAUTHORIZED, "token required");
    };
    if tok.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");
    }
    let app2 = app.clone();
    // Пара-фикс (0.1.164): живой WS-клиент тоже «не молчит» — ntfy-гейт
    // не должен будить получателя с открытым WebSocket-подключением.
    {
        let mut seen = app.last_seen.lock().unwrap();
        seen.insert(tok.hash.clone(), now());
    }
    ws.on_upgrade(move |socket| async move {
        app2.metrics.ws_sessions.fetch_add(1, Ordering::Relaxed);
        ws_serve(app2, tok, socket).await;
    })
}

async fn ws_serve(app: Arc<AppState>, tok: vault_relay::Token, socket: axum::extract::ws::WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    let (mut tx, mut rx) = socket.split();
    // Пара-фикс (0.1.164): пока WS открыт, получатель жив — обновляем
    // last_seen каждые 30с (loop ниже пингует store; здесь же touch).
    let mut last_touch = now();
    let hello = serde_json::json!({"t":"hello","pending":app.store.len(&tok.hash)});
    let _ = tx.send(Message::Text(hello.to_string())).await;
    // Не-ack'нутые id: при реконнекте вернутся снова (at-least-once).
    let mut inflight: HashMap<String, vault_relay::store::Envelope> = HashMap::new();
    loop {
        // Сначала всё, что накопилось (без ack), затем ждём новых/ack'и.
        if let Some(list) = app.store.drain(&tok.hash) {
            for env in list {
                let frame = serde_json::json!({"t":"msg","id":env.id,"body":env.body});
                if tx.send(Message::Text(frame.to_string())).await.is_err() {
                    app.store.push_front(&tok.hash, env, MAX_QUEUE);
                    return;
                }
                inflight.insert(env.id.clone(), env);
            }
        }
        // touch: открытый WS = получатель не молчит (см. ntfy-гейт в pub).
        let t_now = now();
        if t_now.saturating_sub(last_touch) >= 30 {
            last_touch = t_now;
            if let Ok(mut seen) = app.last_seen.lock() {
                seen.insert(tok.hash.clone(), t_now);
            }
        }
        tokio::select! {
            frame = rx.next() => {
                match frame {
                    Some(Ok(Message::Text(txt))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                            if v.get("t").and_then(|t| t.as_str()) == Some("ack") {
                                if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
                                    inflight.remove(id);
                                }
                            }
                        }
                    }
                    _ => break,
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(700)) => {}
        }
    }
    // Обрыв соединения: не-ack'нутые возвращаются в очередь (придут при реконнекте).
    let mut rest: Vec<vault_relay::store::Envelope> = inflight.into_values().collect();
    rest.reverse();
    for env in rest {
        app.store.push_front(&tok.hash, env, MAX_QUEUE);
    }
}

// ───────────────────────── Вспомогательное ─────────────────────────

fn require_read(app: &Arc<AppState>, headers: &HeaderMap) -> Option<vault_relay::Token> {
    let auth = auth_header(headers)?;
    let t = vault_relay::parse(&app.keys, &auth)?;
    (t.scope == Scope::Read).then_some(t)
}

/// Привязка токена к fingerprint аккаунта (анти-шаринг для монетизации).
/// Первый владелец: если у токена нет привязки — привязываем к текущему fp.
/// Чужой fp с тем же токеном → false (= 403 «token bound to another
/// account»). fp не пришёл (легаси-клиент) → true (привязку не трогаем).
fn check_token_binding(app: &Arc<AppState>, token_hash: &str, fp: &Option<String>) -> bool {
    let Some(fp) = fp.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    let mut bindings = app.token_bindings.lock().unwrap();
    match bindings.get(token_hash) {
        Some(existing) => existing == fp,
        None => {
            bindings.insert(token_hash.to_string(), fp.to_string());
            true
        }
    }
}

/// §0: идентичность издателя для суточного лимита + признак Premium.
/// Приоритет: tok в теле (read-токен отправителя) → Authorization → IP.
/// Premium = токен с expiry > now+365д (promo-выдача на 10 лет).
fn publisher_key(
    app: &Arc<AppState>,
    headers: &HeaderMap,
    req: &PubRequest,
    addr: &std::net::SocketAddr,
) -> (String, bool) {
    let auth = auth_header(headers);
    let candidates = req
        .tok
        .iter()
        .map(|s| s.as_str())
        .chain(auth.iter().map(|s| s.as_str()))
        .filter(|s| !s.is_empty());
    for tok in candidates {
        if let Some(t) = vault_relay::parse(&app.keys, tok) {
            let premium = u64::from(t.expiry) > now() + 365 * 86400;
            return (format!("t:{}", t.hash), premium);
        }
    }
    (format!("ip:{}", addr.ip()), false)
}

fn auth_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("VaultRelay "))
        .map(|s| s.to_string())
}

/// fp в заголовке X-Vault-Fp (poll); fallback: пустой = легаси-клиент.
fn poll_fp(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-vault-fp")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, AxumJson(serde_json::json!({"error": msg}))).into_response()
}

/// M2.3-b: минимальный HTTP-клиент для локального ntfy (без зависимостей).
/// ntfy живёт на том же сервере (nginx terminates TLS наружу) — plain HTTP.
fn ntfy_publish(base: &str, topic: &str, total: usize) {
    use std::io::{Read, Write};
    let base = base.trim_end_matches('/');
    // base = http://127.0.0.1:8092 или https://... — поддержим только http
    let rest = base.strip_prefix("http://").unwrap_or("");
    let (host_port, _) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h.to_string(), p.to_string()),
        _ => (host_port.to_string(), "80".to_string()),
    };
    let body = format!("Новое сообщение ({total})");
    // Icon: PNG-иконка Vault вместо дефолтной ntfy-иконки в шторке
    // (ntfy-клиент скачивает URL и ставит largeIcon). Tags: bell убран —
    // рядом с приложением колокольчик лишний (иконка самого ntfy-клиента
    // в списке приложений не меняется — это largeIcon только в уведомлении).
    let icon = "https://vault-msg.ru/vault-notif-icon-192.png";
    let req = format!(
        "POST /{topic} HTTP/1.1\r\nHost: {host}\r\nTitle: Vault\r\nPriority: high\r\nIcon: {icon}\r\nClick: vault://open\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = std::net::TcpStream::connect((host.as_str(), port.parse::<u16>().unwrap_or(80)))
        .and_then(|mut s| {
            s.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
            s.write_all(req.as_bytes())?;
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf);
            Ok(())
        });
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// GET /metrics — счётчики для мониторинга (без пользовательских данных).
pub async fn metrics(State(app): State<Arc<AppState>>) -> Response {
    let m = &app.metrics;
    let body = format!(
        "pub_ok {}\npub_anon {}\npoll_hits {}\nws_sessions {}\nrejected {}\nqueued {}\nregister_ok {}\nlimit_hit {}\n",
        m.pub_ok.load(Ordering::Relaxed),
        m.pub_anon.load(Ordering::Relaxed),
        m.poll_hits.load(Ordering::Relaxed),
        m.ws_sessions.load(Ordering::Relaxed),
        m.rejected.load(Ordering::Relaxed),
        app.store.total(),
        m.register_ok.load(Ordering::Relaxed),
        m.limit_hit.load(Ordering::Relaxed),
    );
    ([("content-type", "text/plain")], body).into_response()
}

pub async fn health() -> Response {
    AxumJson(serde_json::json!({"ok":true,"service":"vault-relay"})).into_response()
}

/// M2.4: авто-выдача read-токена новому пользователю (freemium).
/// Rate-limit по IP: 3 регистрации в сутки — иначе скопом выметут лимиты.
/// Токен = адрес очереди получателя + его ntfy-topic (hex(mac)).
#[derive(serde::Serialize)]
struct RegisterOk {
    token: String,
    topic: String,
    exp: u32,
    unlimited: bool,
}
#[derive(Deserialize, Default)]
struct RegisterReq {
    /// Промо-ключ безлимита (тестеры/владелец): токен на 10 лет, без
    /// rate-limit. Обычная выдача — 30 дней, 3/день/IP.
    #[serde(default)]
    promo: Option<String>,
    /// Fingerprint аккаунта, получающего токен: привязка «один токен =
    /// один аккаунт» (анти-шаринг при монетизации). Не обязателен.
    #[serde(default)]
    fp: Option<String>,
}
async fn relay_register(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(req): Json<RegisterReq>,
) -> Response {
    let ip = addr.ip().to_string();
    let now = now();
    let promo_ok = app
        .unlimited_key
        .as_deref()
        .zip(req.promo.as_deref())
        .map(|(k, p)| k == p)
        .unwrap_or(false);
    if !promo_ok {
        // обычная выдача: rate-limit по IP (3/день)
        let mut rl = app.registrations.lock().unwrap();
        let (count, window_start) = rl.entry(ip).or_insert((0u32, now));
        if now.saturating_sub(*window_start) > 86400 {
            *count = 0;
            *window_start = now;
        }
        if *count >= 3 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                AxumJson(serde_json::json!({"error":"rate limited, try tomorrow"})),
            )
                .into_response();
        }
        *count += 1;
    }
    // free: 30 дней (продлевается тем же запросом); promo: 10 лет
    let days: u32 = if promo_ok { 3650 } else { 30 };
    let exp: u32 = now.saturating_add(u64::from(days) * 86400) as u32;
    let token = vault_relay::tokens::issue(&app.keys, vault_relay::tokens::Scope::Read, exp);
    let topic = vault_relay::tokens::parse(&app.keys, &token)
        .map(|t| t.hash)
        .unwrap_or_default();
    // Привязка токена к fingerprint сразу при выдаче (если клиент прислал).
    if !check_token_binding(&app, &topic, &req.fp) {
        // Новый токен уже занят другим аккаунтом — невозможно (токен свежий),
        // но на всякий случай не отдаём его чужому fp.
        return err(StatusCode::CONFLICT, "token already bound");
    }
    app.metrics.register_ok.fetch_add(1, Ordering::Relaxed);
    tracing::info!("register: token issued (unlimited={promo_ok}, days={days})");
    (StatusCode::OK, AxumJson(RegisterOk { token, topic, exp, unlimited: promo_ok })).into_response()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().init();
    // Конфиг: VAULT_RELAY_KEY (hex, 32B), VAULT_RELAY_ANON_PUB=1/0.
    let key_hex = std::env::var("VAULT_RELAY_KEY").unwrap_or_default();
    let server_key = hex_or_generate(&key_hex);
    let allow_anonymous_pub = std::env::var("VAULT_RELAY_ANON_PUB")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let addr: std::net::SocketAddr = std::env::var("VAULT_RELAY_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8091".into())
        .parse()
        .expect("bad VAULT_RELAY_ADDR");
    let ntfy_url = std::env::var("VAULT_RELAY_NTFY_URL").unwrap_or_default();
    let unlimited_key = std::env::var("VAULT_RELAY_UNLIMITED_KEY").ok()
        .filter(|s| !s.trim().is_empty());
    // §0 company.md: бесплатный суточный лимит конвертов на издателя
    // (по умолчанию 100; 0 = выключен; Premium-токены без лимита).
    let free_daily_limit = std::env::var("VAULT_RELAY_FREE_DAILY_LIMIT")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(100);
    if !ntfy_url.is_empty() {
        tracing::info!("ntfy wake-up bridge: {ntfy_url}");
    }
    let state = Arc::new(AppState {
        store: Store::new(),
        keys: ServerKeys::new(server_key),
        allow_anonymous_pub,
        metrics: Metrics::default(),
        registrations: std::sync::Mutex::new(std::collections::HashMap::new()),
        ntfy_url,
        unlimited_key,
        daily_pub: std::sync::Mutex::new(std::collections::HashMap::new()),
        free_daily_limit,
        token_bindings: std::sync::Mutex::new(std::collections::HashMap::new()),
        last_seen: std::sync::Mutex::new(std::collections::HashMap::new()),
    });
    tracing::info!(
        "vault-relay listening on {addr}, anon_pub={allow_anonymous_pub}, free_daily_limit={free_daily_limit}"
    );
    let app = Router::new()
        .route("/relay/pub", post(relay_pub))
        .route("/relay/poll", get(relay_poll))
        .route("/relay/ws", get(relay_ws))
        .route("/metrics", get(metrics))
        .route("/health", get(health))
        // alias: клиентские baseUrl заканчиваются на /relay → зовут /relay/health
        .route("/relay/health", get(health))
        .route("/relay/register", post(relay_register))
        .route("/relay/metrics", get(metrics))
        .layer(cors_layer())
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}

/// CORS: WebView-клиенты (tauri.localhost / android) и веб-клиенты.
/// Authorization в allowed-headers (браузер шлёт его с токеном).
fn cors_layer() -> tower_http::cors::CorsLayer {
    use axum::http::{HeaderValue, Method};
    tower_http::cors::CorsLayer::new()
        .allow_origin([
            "tauri://localhost".parse::<HeaderValue>().expect("origin"),
            "https://tauri.localhost".parse::<HeaderValue>().expect("origin"),
            "http://tauri.localhost".parse::<HeaderValue>().expect("origin"),
        ])
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            "x-vault-fp".parse::<axum::http::HeaderName>().expect("hdr"),
        ])
        .max_age(std::time::Duration::from_secs(3600))
}

fn hex_or_generate(s: &str) -> [u8; 32] {
    if s.len() == 64 {
        if let Ok(bytes) = hex_decode(s) {
            let mut k = [0u8; 32];
            if bytes.len() == 32 {
                k.copy_from_slice(&bytes);
                return k;
            }
        }
    }
    let mut k = [0u8; 32];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut k);
    eprintln!("VAULT_RELAY_KEY not set/invalid — generated ephemeral key");
    k
}

fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
        .collect()
}
