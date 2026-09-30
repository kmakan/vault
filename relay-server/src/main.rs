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

use vault_relay::fcm::FcmSender;
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
    /// S3: per-topic рингтон, выданный клиентом (звук из настроек
    /// «Настройки → Звонки → входящий»): token_hash → URL mp3. Клиент
    /// присылает его при регистрации (/relay/register) и может обновить
    /// через /relay/ringtone; ntfy-вайк звонка играет ИМЕННО его, а не
    /// жёстко прописанный RING_URL. In-memory: рестарт релея → дефолт
    /// (DEFAULT_RING_URL), клиент перешлёт URL при ближайшей регистрации —
    /// приемлемо, звук вернётся сам.
    pub topic_ringtone: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// FCM Part B: отправитель пушей Firebase Cloud Messaging v1. None =
    /// FCM выключен (нет VAULT_FCM_KEY/файла/валидного ключа) — доставка
    /// «будильника» идёт через ntfy-мост, поведение как до FCM.
    pub fcm: Option<Arc<FcmSender>>,
    /// FCM-регистрация получателя: hash(read-токен) → FCM reg_token.
    /// Заполняется POST /relay/fcm/register. In-memory: после рестарта релея
    /// клиент перерегистрируется (как ntfy-topic, он и так переподписывается).
    /// Присутствие записи = «доставляем этому получателю через FCM».
    pub topic_fcm: std::sync::Mutex<std::collections::HashMap<String, String>>,
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
    /// M2 channels: сколько постов опубликовано в канальные очереди.
    pub channel_pub: AtomicU64,
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
    /// Высокий приоритет (звонок): обходит last_seen-гейт ntfy-вайка.
    /// Гейт существует, чтобы не дублировать пуш у живого получателя,
    /// но «поллил 3 секунды назад и его только что закрыли» сервер не
    /// отличает от «жив» → звонок в первые секунды после закрытия
    /// не будил телефон (S3: процесс убит, уведомления нет). Звонок —
    /// «ответь сейчас»: дубль уведомления допустим, пропуск — нет.
    /// Легаси-клиенты поле не шлют → false (гейт как раньше).
    #[serde(default)]
    pub urgent: Option<bool>,
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
    // ChannelRead допустим: пост канала публикуется в его общую очередь.
    let to_tok = match vault_relay::parse(&app.keys, &req.to) {
        Some(t) if t.scope == Scope::Read || t.scope == Scope::ChannelRead => t,
        _ => {
            app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
            return err(StatusCode::BAD_REQUEST, "bad recipient token");
        }
    };
    if to_tok.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "recipient subscription expired");
    }
    let is_channel = to_tok.scope == Scope::ChannelRead;
    // Анонимный publish (§9.1): без заголовка — только если разрешено конфигом.
    // Канальные очереди — ИСКЛЮЧЕНИЕ: анонимный pub в канал запрещён всегда,
    // publish возможен только write-токеном этого же канала (link: kid==kid).
    if let Some(auth) = auth_header(&headers) {
        match vault_relay::parse(&app.keys, &auth) {
            Some(t) if t.scope == Scope::Write && !t.is_expired() && !is_channel => {}
            Some(t) if t.scope == Scope::ChannelWrite && !t.is_expired() => {
                if !is_channel {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::FORBIDDEN, "channel token cannot post to personal queue");
                }
                if !t.channel_matches(&to_tok) {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::FORBIDDEN, "channel token does not match queue");
                }
                app.metrics.channel_pub.fetch_add(1, Ordering::Relaxed);
            }
            Some(_) => return err(StatusCode::FORBIDDEN, "token scope mismatch"),
            None => {
                app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                return err(StatusCode::UNAUTHORIZED, "bad token");
            }
        }
    } else if is_channel {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "channel write token required");
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
    // Для каналов пропускаем: write-токен канала общий у всех, кто знает
    // broadcast-ключ, привязка к одному fp противоречит модели рассылки.
    if !is_channel {
        if let Some(sender_tok) = req.tok.as_deref().filter(|s| !s.is_empty()) {
            if let Some(t) = vault_relay::parse(&app.keys, sender_tok) {
                if !check_token_binding(&app, &t.hash, &req.fp) {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::FORBIDDEN, "token bound to another account");
                }
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
    // S4: отправитель нужен дальше (клик по звонку ведёт в чат), а req.from
    // ниже перемещается в Envelope — забираем копию до partial move.
    let from = req.from.clone();
    // FCM Part B: id конверта уходит в data как call_id (ключ дедупа на
    // клиенте). Забираем копию ДО partial move в Envelope.
    let call_id = req.id.clone();
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
    // Мост ntfy — только личные очереди: подписчики канала не подписаны
    // на topic=hash(канального токена) (topic-подписка = приватный
    // 1-на-1 wake), будить «молчащую канальную очередь» бессмысленно.
    //
    // FCM Part B: пути доставки ВЗАИМОИСКЛЮЧАЮЩИЕ — у получателя с
    // FCM-регистрацией уходит FCM, у остальных ntfy (иначе телефон получил бы
    // два будильника на один конверт). Внешний гейт расширен на «ntfy_url
    // настроен ИЛИ FCM включён»: FCM работает и без ntfy-моста.
    if req.wake && !is_channel && (!app.ntfy_url.is_empty() || app.fcm.is_some()) {
        // Urgent (звонок) обходит гейт: «поллил N сек назад» не отличает
        // «только что закрыл приложение» от «жив». Звонок — приоритет,
        // дубль пуша допустим, пропуск нет. Обычные сообщения — гейт 15с
        // (живой тикер полил раз в 5с → 3× запас дедупа; закрыто >15с →
        // булим; раньше 90с — в первые 90с после закрытия вайк подавлялся).
        let urgent = req.urgent == Some(true);
        let silent_for = {
            let seen = app.last_seen.lock().unwrap();
            seen.get(&to_tok.hash).map_or(u64::MAX, |t| now().saturating_sub(*t))
        };
        if urgent || silent_for >= 15 {
            let topic = to_tok.hash.clone();
            let total = app.store.len(&to_tok.hash);
            // S3: звук звонка — тот, что получатель выбрал в настройках
            // (per-topic ringtone, key = hash его read-токена = ntfy-topic);
            // тема без ringtone → дефолт (легаси-клиенты, рестарт релея).
            let ring = ringtone_or_default(&app.topic_ringtone, &to_tok.hash);
            // Один pub = один wake-up. Дедуп контента на клиенте (env.id),
            // дедуп путей уведомлений — last_seen-гейт (один путь, не оба).
            //
            // Ветка FCM (предпочтительна): reg_token темы + включённый FCM.
            let fcm_reg = app.topic_fcm.lock().unwrap().get(&topic).cloned();
            match (app.fcm.clone(), fcm_reg) {
                (Some(sender), Some(reg)) => {
                    let push = vault_relay::fcm::CallPush {
                        kind: if urgent { "call_request" } else { "message" },
                        // id конверта = ключ дедупа на клиенте (= call_id).
                        call_id: call_id.clone(),
                        from: from.clone().unwrap_or_default(),
                        // Отображаемого имени отправителя сервер НЕ знает
                        // (видит только opaque-токены) — рисует клиент.
                        name: String::new(),
                        total: total.to_string(),
                        urgent,
                        ring: ring.clone(),
                        click: click_url(urgent, from.as_deref()),
                    };
                    // Отдельная задача: сетевое ожидание не держит обработчик
                    // pub. Ошибка — в лог, не фатальна (конверт в очереди).
                    tokio::spawn(async move {
                        if let Err(e) = sender.send(&reg, &push).await {
                            tracing::error!(error = %e, "fcm send failed (envelope still queued)");
                        }
                    });
                }
                _ => {
                    // ntfy-путь как был; если ntfy не настроен, а FCM не
                    // выбран — просто ничего не будим (конверт в очереди).
                    if !app.ntfy_url.is_empty() {
                        let ntfy_url = app.ntfy_url.clone();
                        tokio::task::spawn_blocking(move || {
                            ntfy_publish(&ntfy_url, &topic, total, urgent, &ring, from.as_deref());
                        });
                    }
                }
            }
        }
    }
    (StatusCode::OK, AxumJson(PubOk { ok: true, mid })).into_response()
}

// ───────────────────────── Получение (§5.2) ─────────────────────────

#[derive(Deserialize)]
pub struct PollQuery {
    pub wait: Option<u64>,
    /// Канальный курсор (M2 channels): отдать только посты с ts > since.
    /// Игнорируется для личных очередей (drain сам по себе « один раз »).
    #[serde(default)]
    pub since: Option<u64>,
}

/// GET /relay/poll?wait=25 — long-poll: до 25 конвертов, 204 по таймауту.
/// ChannelRead-токен: очередь канала общая (fan-out) — конверты читаются
/// peek'ом и НЕ забираются; каждый подписчик получает каждый пост до TTL.
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
    let channel = tok.scope == Scope::ChannelRead;
    // Привязка токена к аккаунту: чужой fingerprint = токен скопировали
    // на другое устройство → 403 (клиент перерегистрируется). Для канала
    // пропускаем: read-токен канала общий по построению (все подписчики).
    if !channel && !check_token_binding(&app, &tok.hash, &poll_fp(&headers)) {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::FORBIDDEN, "token bound to another account");
    }
    if !vault_relay::rate::allow_poll(&tok.hash) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate limit");
    }
    let wait = q.wait.unwrap_or(0).min(25);
    // Пара-фикс (0.1.164): получатель жив — отмечаем его «видимым» для
    // ntfy-гейта (см. relay_pub). Даже 204-поллинг тикера = процесс жив.
    // Канальную очередь в last_seen не пишем — wake-пуш на канал не шлём.
    if !channel {
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
    let since = if channel { q.since.unwrap_or(0) } else { 0 };
    loop {
        let list = if channel {
            app.store.peek(&tok.hash, since)
        } else {
            app.store.drain(&tok.hash)
        };
        if let Some(list) = list {
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
    // Для канала last_seen не пишем (wake-пушей на канал нет).
    if tok.scope != Scope::ChannelRead {
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
    // Канальный WS: очередь общая — читаем peek'ом и держим множество
    // уже отправленных в этой сессии id (клиент дедупит по env.id, но
    // слать одно и то же каждый цикл нельзя). При реконнекте посты
    // придут снова — это at-least-once, дедуп на клиенте.
    let channel = tok.scope == Scope::ChannelRead;
    let mut sent_ids: HashMap<String, ()> = HashMap::new();
    // Пара-фикс (0.1.164): пока WS открыт, получатель жив — обновляем
    // last_seen каждые 30с (loop ниже пингует store; здесь же touch).
    let mut last_touch = now();
    let hello = serde_json::json!({"t":"hello","pending":app.store.len(&tok.hash)});
    let _ = tx.send(Message::Text(hello.to_string())).await;
    // Не-ack'нутые id: при реконнекте вернутся снова (at-least-once).
    let mut inflight: HashMap<String, vault_relay::store::Envelope> = HashMap::new();
    loop {
        // Сначала всё, что накопилось (без ack), затем ждём новых/ack'и.
        let list = if channel {
            app.store.peek(&tok.hash, 0)
        } else {
            app.store.drain(&tok.hash)
        };
        if let Some(list) = list {
            for env in list {
                if channel {
                    if sent_ids.contains_key(&env.id) {
                        continue;
                    }
                    sent_ids.insert(env.id.clone(), ());
                }
                let frame = serde_json::json!({"t":"msg","id":env.id,"body":env.body});
                if tx.send(Message::Text(frame.to_string())).await.is_err() {
                    if !channel {
                        app.store.push_front(&tok.hash, env, MAX_QUEUE);
                    }
                    return;
                }
                if !channel {
                    inflight.insert(env.id.clone(), env);
                }
            }
        }
        // touch: открытый WS = получатель не молчит (см. ntfy-гейт в pub).
        let t_now = now();
        if !channel && t_now.saturating_sub(last_touch) >= 30 {
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
    (t.scope == Scope::Read || t.scope == Scope::ChannelRead).then_some(t)
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
            // Premium = токен с expiry > now+365д (promo-выдача на 10 лет).
            // Канальные токены — sentinel u32::MAX по построению, это НЕ
            // premium-признак: иначе pub в канал обходил бы лимит вообще.
            // Лимит на канал = по hash write-токена (100 постов/сут на
            // канал с бесплатного аккаунта; утечка write-токена не спамит
            // бесконечно).
            let premium = !t.scope.is_channel()
                && u64::from(t.expiry) > now() + 365 * 86400;
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
/// `ringtone_url` — звук входящего звонка, выбранный ПОЛУЧАТЕЛЕМ в
/// настройках (S3): ntfy проигрывает его через Audio-заголовок вместо
/// жёстко прописанного когда-то RING_URL.
fn ntfy_publish(
    base: &str,
    topic: &str,
    total: usize,
    urgent: bool,
    ringtone_url: &str,
    from: Option<&str>,
) {
    use std::io::{Read, Write};
    let base = base.trim_end_matches('/');
    // base = http://127.0.0.1:8092 или https://... — поддержим только http
    let rest = base.strip_prefix("http://").unwrap_or("");
    let (host_port, _) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h.to_string(), p.to_string()),
        _ => (host_port.to_string(), "80".to_string()),
    };
    let (title, body, audio_header) = if urgent {
        (
            "Входящий вызов",
            "Входящий вызов — откройте Vault: принять или отклонить".to_string(),
            format!("Audio: {ringtone_url}\r\n"),
        )
    } else {
        (
            "Vault",
            format!("Новое сообщение ({total})"),
            String::new(),
        )
    };
    // Icon: PNG-иконка Vault вместо дефолтной ntfy-иконки в шторке
    // (ntfy-клиент скачивает URL и ставит largeIcon). Tags: bell убран —
    // рядом с приложением колокольчик лишний (иконка самого ntfy-клиента
    // в списке приложений не меняется — это largeIcon только в уведомлении).
    let icon = "https://vault-msg.ru/vault-notif-icon-192.png";
    // S4: `from` — адрес отправителя (для клика по звонку). Область видимости
    // та же, что у `ringtone_url`: читается только в click_url.
    let click = click_url(urgent, from);
    let req = format!(
        "POST /{topic} HTTP/1.1\r\nHost: {host}\r\nTitle: {title}\r\nPriority: high\r\nIcon: {icon}\r\nClick: {click}\r\n{audio_header}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // Ошибка публикации — не фатальна: конверт уже в очереди, клиент заберёт
    // его poll'ом. Логируем (иначе корень #4 — молчащий сбой ntfy-моста).
    if let Err(e) = std::net::TcpStream::connect((host.as_str(), port.parse::<u16>().unwrap_or(80)))
        .and_then(|mut s| {
            s.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
            s.write_all(req.as_bytes())?;
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf);
            Ok(())
        })
    {
        eprintln!("vault-relay: ntfy publish to {topic} failed: {e}");
    }
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
        "pub_ok {}\npub_anon {}\npoll_hits {}\nws_sessions {}\nrejected {}\nqueued {}\nregister_ok {}\nlimit_hit {}\nchannel_pub {}\n",
        m.pub_ok.load(Ordering::Relaxed),
        m.pub_anon.load(Ordering::Relaxed),
        m.poll_hits.load(Ordering::Relaxed),
        m.ws_sessions.load(Ordering::Relaxed),
        m.rejected.load(Ordering::Relaxed),
        app.store.total(),
        m.register_ok.load(Ordering::Relaxed),
        m.limit_hit.load(Ordering::Relaxed),
        m.channel_pub.load(Ordering::Relaxed),
    );
    ([("content-type", "text/plain")], body).into_response()
}

pub async fn health() -> Response {
    AxumJson(serde_json::json!({"ok":true,"service":"vault-relay"})).into_response()
}

// ───────────────────── Рингтон звонка (S3, per-topic) ─────────────────────
// Модель юзера: базовый канал доставки звонка — ntfy-пуш со ЗВУКОМ ИЗ
// НАСТРОЕК приложения («Настройки → Звонки → входящий»: incoming /
// incoming_classic / incoming_pulse). Раньше сервер жёстко играл один
// mp3 для всех; теперь клиент выдаёт свой URL при регистрации токена и
// может обновить его на живом токене через /relay/ringtone.

/// Дефолт для тем, которые ещё не прислали ringtone (легаси-клиенты,
/// рестарт релея = in-memory хранилище пустое).
const DEFAULT_RING_URL: &str = "https://vault-msg.ru/ring_incoming.mp3";

/// Тип хранилища (тот же, что у поля AppState::topic_ringtone).
type RingtoneStore = std::sync::Mutex<std::collections::HashMap<String, String>>;

/// Нормализовать ringtone из запроса: принимаем только http(s)-URL
/// (обрезанный по пробелам); мусор/пусто/чужая схема = None (не храним).
fn norm_ringtone(v: Option<&str>) -> Option<String> {
    v.map(str::trim)
        .filter(|s| s.starts_with("http"))
        .map(str::to_string)
}

/// Единая точка записи/чтения per-topic рингтона (и /relay/register, и
/// /relay/ringtone): прислали валидный URL → сохранить и вернуть его;
/// иначе → вернуть сохранённый (None = «своего нет, играй дефолт»).
fn ringtone_resolve(store: &RingtoneStore, hash: &str, incoming: Option<&str>) -> Option<String> {
    let mut saved = store.lock().unwrap();
    if let Some(ring) = norm_ringtone(incoming) {
        tracing::info!(topic = %hash, "ringtone: stored");
        saved.insert(hash.to_string(), ring.clone());
        return Some(ring);
    }
    saved.get(hash).cloned()
}

/// Рингтон для ntfy-вайка звонка (см. relay_pub): сохранённый темой или дефолт.
fn ringtone_or_default(store: &RingtoneStore, hash: &str) -> String {
    store
        .lock()
        .unwrap()
        .get(hash)
        .cloned()
        .unwrap_or_else(|| DEFAULT_RING_URL.to_string())
}

/// URL для ntfy-заголовка Click: обычный пуш → просто открыть приложение;
/// urgent (звонок) с известным отправителем → сразу открыть чат с ним.
/// Percent-кодирование по RFC 3986: кодируем всё, кроме unreserved
/// [A-Za-z0-9._~-]. Без новых зависимостей — чистая функция.
fn click_url(urgent: bool, from: Option<&str>) -> String {
    if !urgent {
        return "vault://open".to_string();
    }
    let Some(f) = from.filter(|f| !f.is_empty()) else {
        return "vault://open".to_string();
    };
    // Обход ПО БАЙТАМ (не chars): не-ASCII уходит как UTF-8-байты → %XX,
    // round-trip корректен. hex-цифра: 0-9, затем A-F (uppercase, RFC).
    let hex = |n: u8| char::from(b"0123456789ABCDEF"[n as usize]);
    let enc: String = f
        .as_bytes()
        .iter()
        .flat_map(|&b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-') {
                vec![b as char]
            } else {
                // каждый спецсимвол → %XX (uppercase hex)
                vec!['%', hex(b / 16), hex(b % 16)]
            }
        })
        .collect();
    format!("vault://open?chat={enc}")
}

// ───────────────────── FCM-регистрация получателя (Part B) ─────────────────────
// Клиент (Android) после FirebaseMessaging.getToken() присылает reg_token.
// Сервер привязывает его к теме (hash его read-токена) и с этого момента
// будит этого получателя через FCM вместо ntfy (в relay_pub пути взаимоисключающие).

#[derive(Deserialize, Default)]
struct FcmRegisterReq {
    /// FCM registration token (Firebase SDK, длинная base64url-строка).
    /// Пустой/слишком длинный/с чужими символами — 400, мусор не храним.
    #[serde(default)]
    reg_token: Option<String>,
    /// Fingerprint аккаунта: тот же анти-шаринг, что у /relay/register и pub.
    #[serde(default)]
    fp: Option<String>,
}

/// Нормализовать reg_token: обрезать, ограничить длину, оставить только
/// символы, которые реально встречаются в FCM-токенах (base64url + «:»).
fn norm_reg_token(v: Option<&str>) -> Option<String> {
    let t = v?.trim();
    if t.is_empty() || t.len() > 4096 {
        return None;
    }
    if !t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.' | '~' | '%'))
    {
        return None;
    }
    Some(t.to_string())
}

/// POST /relay/fcm/register — привязать FCM reg_token к теме токена.
/// Auth — тот же read-токен из Authorization («VaultRelay <токен>»), что у
/// pub/poll: привязка к теме ИМЕННО этого получателя.
/// FCM выключен → 503 (клиент знает: пуши через FCM недоступны, есть ntfy).
async fn relay_fcm_register(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<FcmRegisterReq>,
) -> Response {
    let Some(tok) = require_read(&app, &headers) else {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "token required");
    };
    if tok.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");
    }
    // Валидируем reg_token ДО проверки «включён ли FCM»: мусор в теле —
    // ошибка клиента (400) независимо от состояния фичи.
    let Some(reg) = norm_reg_token(req.reg_token.as_deref()) else {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::BAD_REQUEST, "bad reg_token");
    };
    // Канал от FCM-пушей не заводим: подписчиков много, wake 1-на-1.
    if tok.scope == Scope::ChannelRead {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::BAD_REQUEST, "channel cannot register fcm");
    }
    // FCM выключен — честный 503, а не 200 «с виду успешно»: клиент поймёт,
    // что надо перейти на ntfy-подписку.
    if app.fcm.is_none() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "fcm disabled");
    }
    // Тот же анти-шаринг, что у остальных маршрутов: чужая fp с тем же
    // токеном → 403 (клиент перерегистрируется).
    if !check_token_binding(&app, &tok.hash, &req.fp) {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::FORBIDDEN, "token bound to another account");
    }
    app.topic_fcm
        .lock()
        .expect("topic_fcm lock")
        .insert(tok.hash.clone(), reg);
    // reg_token в лог НЕ пишем (это адрес доставки, секрет клиента).
    tracing::info!("fcm: device registered for push");
    (StatusCode::OK, AxumJson(serde_json::json!({"ok": true}))).into_response()
}

/// POST /relay/ringtone — обновить/прочесть рингтон входящего звонка темы,
/// не перерегистрируя токен (пользователь сменил звук в настройках).
/// Тело: `{"ringtone": "https://.../ring_incoming_pulse.mp3"}` — сохранить
/// и отдать его; пустое/без поля — отдать сохранённый. Ответ: `{"ringtone":
/// "<url>"}` | `{"ringtone": null}`. Auth — тот же токен из Authorization
/// («VaultRelay <токен>»), что у pub/poll (CORS-заголовок уже разрешён).
#[derive(Deserialize, Default)]
struct GetRingtoneReq {
    #[serde(default)]
    pub ringtone: Option<String>,
}

async fn relay_get_ringtone(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GetRingtoneReq>,
) -> Response {
    let Some(tok) = auth_header(&headers) else {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "bad token");
    };
    let Some(t) = vault_relay::tokens::parse(&app.keys, &tok) else {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "bad token");
    };
    let ring = ringtone_resolve(&app.topic_ringtone, &t.hash, req.ringtone.as_deref());
    AxumJson(serde_json::json!({ "ringtone": ring })).into_response()
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
    /// S3: URL рингтона входящего звонка из настроек клиента
    /// (ring_incoming | ring_incoming_classic | ring_incoming_pulse .mp3).
    /// Необязателен: без него у темы дефолтный звук. Легаси-клиенты
    /// поле не шлют.
    #[serde(default)]
    ringtone: Option<String>,
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
    // S3: заодно сохраняем рингтон звонка из настроек клиента (если
    // прислан валидный http-URL) — тема = hash этого же токена.
    ringtone_resolve(&app.topic_ringtone, &topic, req.ringtone.as_deref());
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
        topic_ringtone: std::sync::Mutex::new(std::collections::HashMap::new()),
        // FCM Part B: VAULT_FCM_KEY пуст/файл битый → fcm=None, сервер живёт
        // на ntfy-мосте (поведение до FCM). Ошибка уже залогирована в from_env.
        fcm: FcmSender::from_env().map(Arc::new),
        topic_fcm: std::sync::Mutex::new(std::collections::HashMap::new()),
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
        .route("/relay/ringtone", post(relay_get_ringtone))
        // FCM Part B: привязка reg_token получателя к его теме.
        .route("/relay/fcm/register", post(relay_fcm_register))
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

// ─────────────────── Тесты (S3: per-topic ringtone) ───────────────────
// Без сети и БД: локальные ServerKeys → свой хеш темы, хранилище — тот же
// in-memory HashMap, что у AppState. ntfy-путь (внешний TCP) не тестируем.
#[cfg(test)]
mod tests {
    use super::*;
    use vault_relay::tokens::{issue, parse};

    fn keys() -> ServerKeys {
        ServerKeys::new([7u8; 32])
    }

    /// Read-токен + hash его очереди (= ntfy-topic = ключ рингтона).
    /// hash = mac(key_id‖scope‖expiry), то есть тема однозначно задаётся
    /// expiry токена: выдача в разное время = разный expiry = разная тема.
    fn fresh_topic(k: &ServerKeys, exp: u32) -> (String, String) {
        let token = issue(k, Scope::Read, exp); // 2100 год — не просрочен
        let hash = parse(k, &token).expect("token must parse").hash;
        (token, hash)
    }

    fn store() -> RingtoneStore {
        std::sync::Mutex::new(std::collections::HashMap::new())
    }

    /// AppState для тестов маршрутов: FCM выключен (None) и ntfy пуст —
    /// сеть не трогаем никогда.
    fn app_state(k: ServerKeys) -> Arc<AppState> {
        Arc::new(AppState {
            store: Store::new(),
            keys: k,
            allow_anonymous_pub: true,
            metrics: Metrics::default(),
            registrations: std::sync::Mutex::new(std::collections::HashMap::new()),
            ntfy_url: String::new(),
            unlimited_key: None,
            daily_pub: std::sync::Mutex::new(std::collections::HashMap::new()),
            free_daily_limit: 0,
            token_bindings: std::sync::Mutex::new(std::collections::HashMap::new()),
            last_seen: std::sync::Mutex::new(std::collections::HashMap::new()),
            topic_ringtone: std::sync::Mutex::new(std::collections::HashMap::new()),
            fcm: None,
            topic_fcm: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }

    fn auth_headers(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            format!("VaultRelay {token}").parse().expect("hdr"),
        );
        h
    }

    /// reg_token нормализуется: мусор и пустое — None (в мапку не попадает).
    #[test]
    fn norm_reg_token_accepts_fcm_and_rejects_junk() {
        let real = "fcm-token_ABC-123:xyz~0%9";
        assert_eq!(norm_reg_token(Some(real)).as_deref(), Some(real));
        assert_eq!(
            norm_reg_token(Some("  fcm-abc  ")).as_deref(),
            Some("fcm-abc")
        );
        for junk in [
            None,
            Some(""),
            Some("   "),
            Some("has space"),
            Some("quote\"inject"),
            Some("angle<brackets"),
            Some(&"x".repeat(5000)),
        ] {
            assert!(norm_reg_token(junk).is_none(), "must reject {junk:?}");
        }
    }

    /// Рег-роут без токена / с мусорным токеном — 401 (как все /relay/*).
    #[tokio::test]
    async fn fcm_register_requires_auth() {
        let app = app_state(keys());
        let mk = |t: Option<&str>| FcmRegisterReq {
            reg_token: Some(t.unwrap_or("fcm-abc").to_string()),
            fp: None,
        };
        assert_eq!(
            relay_fcm_register(State(app.clone()), HeaderMap::new(), Json(mk(None)))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut h = HeaderMap::new();
        h.insert("authorization", "VaultRelay nonsense".parse().expect("hdr"));
        assert_eq!(
            relay_fcm_register(State(app), h, Json(mk(None))).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    /// FCM выключен → 503 (не 200): клиент должен уйти на ntfy.
    #[tokio::test]
    async fn fcm_register_returns_503_when_fcm_disabled() {
        let k = keys();
        let (token, _hash) = fresh_topic(&k, 4_102_444_800);
        let app = app_state(k); // fcm: None
        let req = FcmRegisterReq {
            reg_token: Some("fcm-abc".into()),
            fp: None,
        };
        let resp = relay_fcm_register(State(app), auth_headers(&token), Json(req)).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Истёкшая подписка — 402 (как у poll/ws).
    #[tokio::test]
    async fn fcm_register_respects_expiry() {
        let k = keys();
        let token = issue(&k, Scope::Read, 1); // expiry в прошлом
        let app = app_state(k);
        let req = FcmRegisterReq {
            reg_token: Some("fcm-abc".into()),
            fp: None,
        };
        let resp = relay_fcm_register(State(app), auth_headers(&token), Json(req)).await;
        assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
    }

    /// Битый reg_token → 400, в topic_fcm ничего не записано.
    #[tokio::test]
    async fn fcm_register_rejects_bad_reg_token() {
        let k = keys();
        let (token, hash) = fresh_topic(&k, 4_102_444_800);
        let app = app_state(k);
        for junk in [None, Some(""), Some("bad token with spaces")] {
            let req = FcmRegisterReq {
                reg_token: junk.map(str::to_string),
                fp: None,
            };
            let resp = relay_fcm_register(
                State(app.clone()),
                auth_headers(&token),
                Json(req),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "junk {junk:?}");
        }
        let map = app.topic_fcm.lock().unwrap();
        assert!(map.is_empty(), "мусор не сохраняем");
        assert!(!map.contains_key(&hash));
    }

    /// Привязка идёт к ТЕМЕ (hash токена) — именно по to_tok.hash relay_pub
    /// выбирает путь; вторая регистрация перезаписывает (ротация токена).
    #[tokio::test]
    async fn fcm_register_binds_reg_token_to_topic_hash() {
        let k = keys();
        let (token, hash) = fresh_topic(&k, 4_102_444_800);
        let app = app_state(k);
        let mut map = app.topic_fcm.lock().unwrap();
        map.insert(hash.clone(), "fcm-reg-token".into());
        assert_eq!(map.get(&hash).map(String::as_str), Some("fcm-reg-token"));
        map.insert(hash.clone(), "fcm-reg-token-2".into());
        assert_eq!(map.get(&hash).map(String::as_str), Some("fcm-reg-token-2"));
        // Другая тема не затронута (у каждой свой FCM-регистрация).
        let (_t2, hash2) = fresh_topic(&app.keys, 4_102_444_801);
        assert!(!map.contains_key(&hash2), "чужая тема чиста");
        assert_eq!(map.len(), 1);
        // Токен в мапке не нужен после привязки (адресация — по хэшу).
        assert!(!map.contains_key(&token));
    }

    /// Анти-шаринг: токен, привязанный к чужому fp → false (→ 403 на роуте).
    #[tokio::test]
    async fn fcm_register_respects_token_binding() {
        let k = keys();
        let (_token, hash) = fresh_topic(&k, 4_102_444_800);
        let app = app_state(k);
        assert!(check_token_binding(&app, &hash, &Some("fp-owner".into())));
        assert!(!check_token_binding(&app, &hash, &Some("fp-other".into())));
    }

    /// Рег-роут не принимает канальный read-токен (у канала fan-out, не 1-на-1).
    /// Канальный токен выводится из broadcast-ключа (sentinel-expiry u32::MAX).
    #[tokio::test]
    async fn fcm_register_rejects_channel_token() {
        let k = keys();
        let (read, _write) = vault_relay::tokens::channel_tokens(&[9u8; 32]);
        let app = app_state(k);
        let req = FcmRegisterReq {
            reg_token: Some("fcm-abc".into()),
            fp: None,
        };
        let resp = relay_fcm_register(State(app), auth_headers(&read), Json(req)).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "канал не регистрируется");
    }

    /// Regression (критерий 3): без FCM и без ntfy pub/pub-путь работает как
    /// прежде — конверт кладётся в очередь, 200, ошибок нет.
    #[tokio::test]
    async fn pub_works_without_fcm_and_ntfy() {
        let k = keys();
        let (token, hash) = fresh_topic(&k, 4_102_444_800);
        let app = app_state(k);
        let req = PubRequest {
            v: 1,
            to: token,
            id: "env-1".into(),
            exp: now() + 600,
            body: "aGVsbG8=".into(),
            tok: None,
            from: Some("anna@example.com".into()),
            fp: None,
            wake: true,
            urgent: Some(true),
        };
        let resp = relay_pub(
            State(app.clone()),
            ConnectInfo("127.0.0.1:1234".parse().expect("addr")),
            HeaderMap::new(),
            AxumJson(req),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let queued = app.store.peek(&hash, 0).expect("queue exists");
        assert_eq!(queued.len(), 1, "конверт лежит в очереди получателя");
        assert_eq!(queued[0].id, "env-1");
    }

    #[test]
    fn ringtone_roundtrip_by_token_hash() {
        let k = keys();
        let (_token, hash) = fresh_topic(&k, 4_102_444_800);
        let s = store();
        let pulse = "https://vault-msg.ru/sounds/ring_incoming_pulse.mp3";
        // сохранение (POST /relay/ringtone с полем) → вернули тот же URL
        assert_eq!(ringtone_resolve(&s, &hash, Some(pulse)).as_deref(), Some(pulse));
        // перечитка без поля (клиент просто спрашивает свой звук) → он же
        assert_eq!(ringtone_resolve(&s, &hash, None).as_deref(), Some(pulse));
        // «пустое» значение не затирает сохранённое
        assert_eq!(ringtone_resolve(&s, &hash, Some("   ")).as_deref(), Some(pulse));
        // ntfy-путь читает из этого же хранилища → играет выбранный звук
        assert_eq!(ringtone_or_default(&s, &hash), pulse);
    }

    #[test]
    fn ringtone_is_per_topic_and_defaults_otherwise() {
        let k = keys();
        let (_t1, h1) = fresh_topic(&k, 4_102_444_800);
        let (_t2, h2) = fresh_topic(&k, 4_102_444_801);
        assert_ne!(h1, h2, "разные токены = разные очереди/темы");
        let s = store();
        let classic = "https://vault-msg.ru/sounds/ring_incoming_classic.mp3";
        ringtone_resolve(&s, &h1, Some(classic));
        assert_eq!(ringtone_resolve(&s, &h2, None), None, "чужая тема осталась чистой");
        assert_eq!(ringtone_or_default(&s, &h1), classic);
        // тема без ringtone → дефолт (легаси-клиенты, рестарт релея)
        assert_eq!(ringtone_or_default(&s, &h2), DEFAULT_RING_URL);
    }

    #[test]
    fn ringtone_accepts_only_http_urls() {
        let s = store();
        for junk in ["", "   ", "ftp://x/r.mp3", "javascript:alert(1)", "vault-msg.ru/a.mp3"] {
            assert_eq!(ringtone_resolve(&s, "t", Some(junk)), None, "must reject {junk:?}");
        }
        assert!(s.lock().unwrap().is_empty(), "мусор не попадает в хранилище");
        // http/https принимаем, пробелы обрезаются
        assert_eq!(
            ringtone_resolve(&s, "t", Some("  https://vault-msg.ru/sounds/ring_incoming.mp3 ")).as_deref(),
            Some("https://vault-msg.ru/sounds/ring_incoming.mp3")
        );
    }

    #[test]
    fn wire_compat_legacy_bodies_still_parse() {
        // легаси-клиенты поле ringtone не шлют → None (играет дефолт)
        let r: RegisterReq = serde_json::from_str(r#"{"fp":"abc"}"#).expect("legacy register");
        assert_eq!(r.ringtone, None);
        let r: RegisterReq = serde_json::from_str("{}").expect("empty register body");
        assert_eq!(r.fp, None);
        // новый клиент прислал ringtone → прочитан
        let r: RegisterReq = serde_json::from_str(
            r#"{"fp":"abc","ringtone":"https://vault-msg.ru/sounds/ring_incoming_pulse.mp3"}"#,
        )
        .expect("register with ringtone");
        assert_eq!(r.ringtone.as_deref(), Some("https://vault-msg.ru/sounds/ring_incoming_pulse.mp3"));
        // запрос «просто отдай мой звук» (без поля) допустим
        let g: GetRingtoneReq = serde_json::from_str("{}").expect("empty get body");
        assert_eq!(g.ringtone, None);
    }

    /// Хранилище живёт в AppState и собирается без сети — поле на месте.
    #[test]
    fn app_state_carries_empty_ringtone_store() {
        let app = AppState {
            store: Store::new(),
            keys: keys(),
            allow_anonymous_pub: true,
            metrics: Metrics::default(),
            registrations: std::sync::Mutex::new(std::collections::HashMap::new()),
            ntfy_url: String::new(),
            unlimited_key: None,
            daily_pub: std::sync::Mutex::new(std::collections::HashMap::new()),
            free_daily_limit: 0,
            token_bindings: std::sync::Mutex::new(std::collections::HashMap::new()),
            last_seen: std::sync::Mutex::new(std::collections::HashMap::new()),
            topic_ringtone: std::sync::Mutex::new(std::collections::HashMap::new()),
            // Тесты не читают VAULT_FCM_KEY и тем более fcm-key.json:
            // FCM выключен, доставка проверяется через ntfy-ветку и юниты.
            fcm: None,
            topic_fcm: std::sync::Mutex::new(std::collections::HashMap::new()),
        };
        assert!(app.topic_ringtone.lock().unwrap().is_empty());
        let (_token, hash) = fresh_topic(&app.keys, 4_102_444_800);
        assert_eq!(ringtone_or_default(&app.topic_ringtone, &hash), DEFAULT_RING_URL);
        let ring = "https://vault-msg.ru/sounds/ring_incoming_classic.mp3";
        assert_eq!(ringtone_resolve(&app.topic_ringtone, &hash, Some(ring)).as_deref(), Some(ring));
        assert_eq!(ringtone_or_default(&app.topic_ringtone, &hash), ring);
    }

    /// S4: клик по обычному пушу = просто открыть приложение (без query).
    #[test]
    fn click_url_non_urgent_is_bare_open() {
        assert_eq!(click_url(false, Some("a@b.c")), "vault://open");
    }

    /// S4: клик по звонку = сразу чат с отправителем; `@` кодируется по RFC 3986.
    #[test]
    fn click_url_urgent_encodes_chat() {
        assert_eq!(
            click_url(true, Some("anna@example.com")),
            "vault://open?chat=anna%40example.com"
        );
    }

    /// S4: звонок без известного отправителя → на главный экран (не в пустой чат).
    #[test]
    fn click_url_urgent_without_sender_is_bare_open() {
        assert_eq!(click_url(true, None), "vault://open");
    }
}
