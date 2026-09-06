//! Vault relay — push-ускоритель поверх email-транспорта.
//! Дублирует (не заменяет) почтовую доставку: конверт уходит и письмом,
//! и на релей; кто первый — тот доставил. Сервер видит только
//! opaque-токены и зашифрованные байты (wire-формат не меняется).
//!
//! MVP scope (docs/design/relay-protocol.md §10): /relay/pub, /relay/poll,
//! /relay/ws, HMAC-auth, TTL 24ч, лимиты §5.4, /metrics.


use axum::{
    extract::{connect_info::ConnectInfo, Query, State, WebSocketUpgrade, ws::Message},
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
    /// M2.3-b: ntfy-мост — host:port ntfy (пусто = пушей нет). ntfy на
    /// том же сервере → plain HTTP на 127.0.0.1:8092, без TLS-зависимостей.
    pub ntfy_url: String,
}

#[derive(Default)]
pub struct Metrics {
    pub pub_ok: AtomicU64,
    pub pub_anon: AtomicU64,
    pub poll_hits: AtomicU64,
    pub ws_sessions: AtomicU64,
    pub rejected: AtomicU64,
    pub register_ok: AtomicU64,
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
    pub from: Option<String>,
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
    let mid = uuid::Uuid::new_v4().to_string();
    let envelope = vault_relay::store::Envelope {
        id: req.id,
        body: req.body,
        exp: req.exp.min(now() + 24 * 3600),
        ts: now(),
        from: req.from.filter(|s| !s.is_empty()).map(|s| s.chars().take(254).collect()),
    };
    app.store.push(&to_tok.hash, envelope, MAX_QUEUE);
    app.metrics.pub_ok.fetch_add(1, Ordering::Relaxed);
    // M2.3-b: ntfy wake-up получателю (at-most-once, тише ошибки):
    // topic = хэш read-токена (opaque). Содержимое НЕ раскрывается —
    // «есть новое» + счётчик. Телефон, подписанный на topic, просыпается
    // от системного пуша и забирает конверты poll'ом (дедуп по id).
    if !app.ntfy_url.is_empty() {
        let ntfy_url = app.ntfy_url.clone();
        let topic = to_tok.hash.clone();
        let total = app.store.len(&to_tok.hash);
        // Fire-and-forget: не блокируем ответ отправителю.
        tokio::task::spawn_blocking(move || {
            ntfy_publish(&ntfy_url, &topic, total);
        });
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
    if !vault_relay::rate::allow_poll(&tok.hash) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate limit");
    }
    let wait = q.wait.unwrap_or(0).min(25);
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
    ws.on_upgrade(move |socket| async move {
        app2.metrics.ws_sessions.fetch_add(1, Ordering::Relaxed);
        ws_serve(app2, tok, socket).await;
    })
}

async fn ws_serve(app: Arc<AppState>, tok: vault_relay::Token, mut socket: axum::extract::ws::WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    let (mut tx, mut rx) = socket.split();
    // hello: сколько ждёт получатель
    let pending = app.store.len(&tok.hash);
    let hello = serde_json::json!({"t":"hello","pending":pending});
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

fn auth_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("VaultRelay "))
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
    let req = format!(
        "POST /{topic} HTTP/1.1\r\nHost: {host}\r\nTitle: Vault\r\nPriority: high\r\nTags: bell\r\nClick: vault://open\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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
        "pub_ok {}\npub_anon {}\npoll_hits {}\nws_sessions {}\nrejected {}\nqueued {}\n",
        m.pub_ok.load(Ordering::Relaxed),
        m.pub_anon.load(Ordering::Relaxed),
        m.poll_hits.load(Ordering::Relaxed),
        m.ws_sessions.load(Ordering::Relaxed),
        m.rejected.load(Ordering::Relaxed),
        app.store.total(),
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
}
async fn relay_register(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
) -> Response {
    // простой in-memory rate-limit:
    let ip = addr.ip().to_string();
    let now = now();
    {
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
    let exp: u32 = (now + 30 * 86400) as u32; // free: 30 дней, продлевается register
    let token = vault_relay::tokens::issue(&app.keys, vault_relay::tokens::Scope::Read, exp);
    let topic = vault_relay::tokens::parse(&app.keys, &token)
        .map(|t| t.hash)
        .unwrap_or_default();
    app.metrics.register_ok.fetch_add(1, Ordering::Relaxed);
    tracing::info!("register: new read token issued (ip rate-limited)");
    (StatusCode::OK, AxumJson(RegisterOk { token, topic, exp })).into_response()
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
    });
    tracing::info!(
        "vault-relay listening on {addr}, anon_pub={allow_anonymous_pub}"
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
        .allow_headers([axum::http::header::AUTHORIZATION, axum::http::header::CONTENT_TYPE])
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
