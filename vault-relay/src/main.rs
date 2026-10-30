//! Vault relay — push-ускоритель поверх email-транспорта.
//! Дублирует (не заменяет) почтовую доставку: конверт уходит и письмом,
//! и на релей; кто первый — тот доставил. Сервер видит только
//! opaque-токены и зашифрованные байты (wire-формат не меняется).
//!
//! MVP scope (docs/design/relay-protocol.md §10): /relay/pub, /relay/poll,
//! /relay/ws, HMAC-auth, TTL 24ч, лимиты §5.4, /metrics.


use axum::{
    extract::{connect_info::ConnectInfo, Json, Path, Query, State, WebSocketUpgrade, ws::Message},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json as AxumJson, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use vault_relay::channel_keys;
use vault_relay::fcm::FcmSender;
use vault_relay::persist::{self, FpToken, PersistedState};
use vault_relay::store::Store;
use vault_relay::test_codes::{self, Claim, TesterCode};
use vault_relay::tokens::Kind;
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
    /// ADR-002: ключи подписи каналов, kid (строкой) → запись.
    pub channel_keys: std::sync::Mutex<std::collections::HashMap<String, channel_keys::Entry>>,
    /// ADR-002: требовать подпись для ВСЕХ каналов, включая незарегистрированные
    /// (VAULT_RELAY_REQUIRE_SIG=1). По умолчанию выключено: включать только
    /// когда все живые каналы зарегистрированы, иначе они перестанут публиковать.
    pub require_sig: bool,
    /// Промо-ключ безлимита (VAULT_RELAY_UNLIMITED_KEY): тестерам/владельцу.
    pub unlimited_key: Option<String>,
    /// Секрет админ-роутов (VAULT_RELAY_ADMIN_KEY). None = админ-роуты
    /// отвечают 404: без секрета их не существует, а не «работают без пароля».
    pub admin_key: Option<String>,
    /// TURN REST (звонки вне одной подсети): секрет coturn `use-auth-secret`
    /// и хост. None = `VAULT_TURN_SECRET` не задан → /relay/turn отвечает 503,
    /// а клиент остаётся на STUN (поведение прежних сборок, а не фиктивный
    /// «успех» с пустыми кредами — их webrtc-rs отвергает при создании PC).
    pub turn: Option<vault_relay::turn::TurnConfig>,
    /// §0 company.md: суточный лимит конвертов на издателя. Ключ — hash
    /// токена издателя (или IP при анонимном pub без tok), значение —
    /// (день UTC = now/86400, счётчик). ПЕРСИСТ: рестарт релея иначе
    /// обнулял бы квоты (free обходил бы 100/сут, Pro получал бы 1000
    /// заново на каждом деплое). Записи прошлых суток отбрасываются при
    /// загрузке.
    pub daily_pub: std::sync::Mutex<std::collections::HashMap<String, (u64, u32)>>,
    /// unix-сек последней записи daily_pub на диск: троттлинг, чтобы
    /// счётчик не бил по диску на каждом конверте (запись не чаще ~1/5с).
    pub daily_persist_at: AtomicU64,
    /// Сколько действий релея в сутки бесплатно (0 = лимит выключен).
    pub free_daily_limit: u32,
    /// Привязка токена к аккаунту: token_hash → fingerprint (один токен =
    /// один аккаунт — защита от шаринга premium-токена между аккаунтами).
    /// ПЕРСИСТ: привязка переживает рестарт — иначе купленный Pro-токен
    /// отвязывался бы и перехватывался первым же использовавшим.
    pub token_bindings: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Подписки: id покупки → план (PersistedState::Subscription). Персист:
    /// купленный Pro не должен теряться при рестарте релея.
    pub subscriptions: std::sync::Mutex<std::collections::HashMap<String, persist::Subscription>>,
    /// Платёжный провайдер. None = платежи выключены (нет ИП/ключей) — все
    /// платёжные роуты отвечают 402 «checkout disabled», а не выдумывают
    /// успех.
    pub payment: Option<Arc<dyn vault_relay::payments::PaymentProvider>>,
    /// Незавершённые чекауты: id → сессия. In-memory по замыслу: рестарт релея
    /// обрывает незавершённую оплату (клиент начнёт заново) — но ВЫДАЧЕННЫЙ
    /// после оплаты токен и подписка переживают рестарт (persist.rs).
    pub checkouts: std::sync::Mutex<std::collections::HashMap<String, vault_relay::payments::Checkout>>,
    /// Попытки чекаута по fp: unix-сек последних попыток (лимитер ≤5/час).
    pub checkout_attempts: std::sync::Mutex<std::collections::HashMap<String, Vec<u64>>>,
    /// Устройства подписки: id подписки → hash'ы её токенов (по одному на
    /// устройство). Персист: рестарт релея не обнуляет лимит устройств.
    pub sub_tokens: std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,

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
    /// жёстко прописанный RING_URL. Персистится в state.json (тот же
    /// класс проблемы, что у topic_fcm: после рестарта релея кастомный
    /// рингтон слетал на дефолт, пока клиент не перерегистрируется).
    pub topic_ringtone: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// FCM Part B: отправитель пушей Firebase Cloud Messaging v1. None =
    /// FCM выключен (нет VAULT_FCM_KEY/файла/валидного ключа) — доставка
    /// «будильника» идёт через ntfy-мост, поведение как до FCM.
    pub fcm: Option<Arc<FcmSender>>,    /// FCM-регистрация получателя: hash(read-токен) → FCM reg_token.
    /// Заполняется POST /relay/fcm/register. ПЕРСИСТИТСЯ в state.json
    /// (VAULT_RELAY_STATE): без этого рестарт релея обнулял карту, клиент
    /// не перерегистрировался (кэш в prefs переживал рестарт), и при
    /// незаданном VAULT_RELAY_NTFY_URL wake-канал становился МЁРТВЫМ
    /// целиком (ветка «нечем будить» в relay_pub молчала). Присутствие
    /// записи = «доставляем этому получателю через FCM».
    pub topic_fcm: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Куда писать состояние при перезапуске (vault_relay::persist).
    /// None = персист выключен (VAULT_RELAY_STATE=off или путь не задан
    /// только в тестах) — тогда поведение как до t_44e210b4.
    pub state_path: Option<std::path::PathBuf>,
    /// fp аккаунта → выданный ему read-токен (вид + срок). Даёт
    /// СТАБИЛЬНОСТЬ адреса очереди: /relay/register с известным fp
    /// возвращает тот же токен, а не новый (инцидент 12.10.2026).
    /// Персистится в state.json: иначе рестарт релея снова ломал бы
    /// адреса очереди у всех, кто перерегистрируется.
    pub fp_tokens: std::sync::Mutex<HashMap<String, FpToken>>,
    /// Персональные тестовые коды: hash(code) → запись. Персист: рестарт
    /// релея не должен забывать, кому выдан код и что он отозван.
    pub tester_codes: std::sync::Mutex<HashMap<String, TesterCode>>,
    /// Отозванные токены (hash): токен stateless, поэтому отзыв — денлист,
    /// который проверяется на каждом чтении/публикации. Персист обязателен.
    pub revoked_tokens: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// t_b8f44bdf: принимать ли «заявку» уже имеющегося токена (`keep` в
    /// /relay/register) — клиент связывает fp → токен ДО протухания, чтобы
    /// адрес очереди не сменился. Kill-switch `VAULT_RELAY_KEEP_CLAIM=0`
    /// (дефолт — включено): `keep` безвреден, но fp не аутентифицирован
    /// (см. docs/CALL-DELIVERY-INCIDENT-2026-10-12.md), поэтому выключатель
    /// нужен, если решим не поддерживать заявку в проде.
    pub keep_claim: std::sync::atomic::AtomicBool,
}

impl AppState {
    /// Поднять AppState с загруженным состоянием (вызывается из main).
    pub fn new(
        store: Store,
        keys: ServerKeys,
        allow_anonymous_pub: bool,
        ntfy_url: String,
        unlimited_key: Option<String>,
        admin_key: Option<String>,
        free_daily_limit: u32,
        fcm: Option<Arc<FcmSender>>,
        state_path: Option<std::path::PathBuf>,
        payment: Option<Arc<dyn vault_relay::payments::PaymentProvider>>,
    ) -> Self {
        let (topic_fcm, topic_ringtone, fp_tokens, channel_keys, token_bindings, subscriptions, sub_tokens, daily_pub, tester_codes, revoked_tokens) =
            match &state_path {
                Some(p) => {
                    let st = PersistedState::load(p);
                    (
                        st.topic_fcm,
                        st.topic_ringtone,
                        st.fp_tokens,
                        st.channel_keys,
                        st.token_bindings,
                        st.subscriptions,
                        st.sub_tokens,
                        st.daily_pub,
                        st.tester_codes,
                        st.revoked_tokens,
                    )
                }
                None => (
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    std::collections::BTreeSet::new(),
                ),
            };
        let require_sig = std::env::var("VAULT_RELAY_REQUIRE_SIG")
            .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
            .unwrap_or(false);
        Self {
            store,
            keys,
            allow_anonymous_pub,
            metrics: Metrics::default(),
            registrations: std::sync::Mutex::new(HashMap::new()),
            channel_keys: std::sync::Mutex::new(channel_keys),
            require_sig,
            ntfy_url,
            unlimited_key,
            admin_key,
            daily_pub: std::sync::Mutex::new(daily_pub),
            daily_persist_at: AtomicU64::new(0),
            free_daily_limit,
            // Привязки токенов и подписки ПЕРЕЖИВАЮТ рестарт (см. persist.rs):
            // иначе платный токен отвязывался бы и перехватывался первым же
            // использовавшим после рестарта релея.
            token_bindings: std::sync::Mutex::new(token_bindings),
            subscriptions: std::sync::Mutex::new(subscriptions),
            payment,
            checkouts: std::sync::Mutex::new(HashMap::new()),
            checkout_attempts: std::sync::Mutex::new(HashMap::new()),
            sub_tokens: std::sync::Mutex::new(sub_tokens),
            last_seen: std::sync::Mutex::new(HashMap::new()),
            topic_ringtone: std::sync::Mutex::new(topic_ringtone),
            fcm,
            topic_fcm: std::sync::Mutex::new(topic_fcm),
            state_path,
            fp_tokens: std::sync::Mutex::new(fp_tokens),
            tester_codes: std::sync::Mutex::new(tester_codes),
            revoked_tokens: std::sync::Mutex::new(revoked_tokens),
            keep_claim: std::sync::atomic::AtomicBool::new(
                std::env::var("VAULT_RELAY_KEEP_CLAIM")
                    .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
                    .unwrap_or(true),
            ),
            turn: vault_relay::turn::TurnConfig::from_env(),
        }
    }

    // ── Платёжные хелперы (шаг 4–5 плана платных токенов) ──────────────

    /// Активная (не отозванная и не истёкшая) подписка покупателя.
    pub fn active_subscription(&self, fp: &str) -> Option<persist::Subscription> {
        let subs = self.subscriptions.lock().expect("subscriptions lock");
        subs.values()
            .find(|s| !s.revoked && s.paid_until > now() && s.fp == fp)
            .cloned()
    }

    /// Сохранить подписку (персист: купленный Pro не должен теряться при
    /// рестарте релея).
    pub fn save_subscription(&self, sub: u64, plan: vault_relay::tokens::Plan, fp: &str, paid_until: u64) {
        {
            let mut subs = self.subscriptions.lock().expect("subscriptions lock");
            subs.insert(
                sub.to_string(),
                persist::Subscription {
                    plan: format!("{:?}", plan).to_lowercase(),
                    fp: fp.to_string(),
                    paid_until,
                    revoked: false,
                },
            );
        }
        self.persist();
    }

    /// Следующий id подписки: 1 + максимум уже выданных.
    pub fn next_subscription_id(&self) -> u64 {
        let subs = self.subscriptions.lock().expect("subscriptions lock");
        let max = subs
            .keys()
            .filter_map(|k| k.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        max + 1
    }

    /// Незавершённый чекаут того же покупателя с тем же планом и сроком —
    /// идемпотентность: повторный клик «купить» не плодит сессии.
    pub fn find_checkout(
        &self,
        fp: &str,
        plan: vault_relay::tokens::Plan,
        months: u32,
    ) -> Option<vault_relay::payments::Checkout> {
        let map = self.checkouts.lock().expect("checkouts lock");
        map.values()
            .find(|c| c.fp == fp && c.plan == plan && c.months == months && c.expires_at > now())
            .cloned()
    }

    pub fn get_checkout(&self, id: &str) -> Option<vault_relay::payments::Checkout> {
        self.checkouts
            .lock()
            .expect("checkouts lock")
            .get(id)
            .cloned()
    }

    pub fn remember_checkout(&self, c: vault_relay::payments::Checkout) {
        self.checkouts
            .lock()
            .expect("checkouts lock")
            .insert(c.id.clone(), c);
    }

    /// Сколько устройств привязано к подписке (по sub, а не по токену).
    ///
    /// Считаем по токенам ЭТОЙ подписки: «купил Pro, поставил на трёх
    /// телефонах» должно упираться в лимит устройств, а не в лимит токенов.
    pub fn subscription_devices(&self, sub: &str) -> u32 {
        self.sub_tokens
            .lock()
            .expect("sub_tokens lock")
            .get(sub)
            .map(|v| v.len() as u32)
            .unwrap_or(0)
    }

    /// Зарегистрировать токен подписки (одно устройство). Повторная
    /// активация того же токена устройство не добавляет.
    pub fn register_sub_token(&self, sub: &str, token_hash: &str) {
        {
            let mut map = self.sub_tokens.lock().expect("sub_tokens lock");
            let list = map.entry(sub.to_string()).or_default();
            if !list.iter().any(|h| h == token_hash) {
                list.push(token_hash.to_string());
            }
        }
        self.persist();
    }

    /// Не больше 5 чекаутов в час на fingerprint (защита от мусора в
    /// платёжные системы и от перебора fp).
    pub fn checkout_rate_ok(&self, fp: &str) -> bool {
        let mut map = self.checkout_attempts.lock().expect("checkout_attempts lock");
        let hour = now() / 3600;
        let attempts = map.entry(fp.to_string()).or_default();
        attempts.retain(|t| *t > hour * 3600);
        if attempts.len() >= 5 {
            return false;
        }
        attempts.push(now());
        true
    }

    /// Атомарно записать topic_fcm + topic_ringtone + fp_tokens в state.json.
    /// Вызывается из всех мест, меняющих эти карты. Ошибка записи НЕ
    /// фатальна для запроса (клиенту уже отвечено 200), но громко логируется:
    /// иначе следующий рестарт тихо уронит wake-канал снова.
    pub fn persist(&self) {
        let Some(path) = &self.state_path else { return };
        let st = PersistedState::snapshot(
            &self.topic_fcm.lock().expect("topic_fcm lock"),
            &self.topic_ringtone.lock().expect("topic_ringtone lock"),
            &self.fp_tokens.lock().expect("fp_tokens lock"),
            &self.channel_keys.lock().expect("channel_keys lock"),
            &self.token_bindings.lock().expect("token_bindings lock"),
            &self.subscriptions.lock().expect("subscriptions lock"),
            &self.sub_tokens.lock().expect("sub_tokens lock"),
            &self.daily_pub.lock().expect("daily_pub lock"),
            &self.tester_codes.lock().expect("tester_codes lock"),
            &self.revoked_tokens.lock().expect("revoked_tokens lock"),
        );
        if let Err(e) = st.save_atomic(path) {
            tracing::error!(path = %path.display(), error = %e, "state: save failed");
        }
    }

    /// Записать состояние из-за изменения суточного счётчика, не чаще раза
    /// в 5 секунд. Счётчик меняется на каждом конверте, а запись — fsync
    /// всего state.json: без троттлинга релей бил бы по диску на каждый pub.
    /// Потеря до 5 секунд счётчика при жёстком креше допустима (лимит
    /// мягкий и проверяется по серверу, а не по клиенту).
    pub fn persist_daily_quota_at(&self, now_secs: u64) {
        const MIN_INTERVAL: u64 = 5;
        if self.state_path.is_none() {
            return;
        }
        let last = self.daily_persist_at.load(Ordering::Relaxed);
        if now_secs.saturating_sub(last) < MIN_INTERVAL {
            return;
        }
        // Право записи получает только один поток: остальные не дублируют
        // fsync (и не перезаписывают файл устаревшим снимком).
        if self
            .daily_persist_at
            .compare_exchange(last, now_secs, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        self.persist();
    }

    pub fn persist_daily_quota(&self) {
        self.persist_daily_quota_at(now());
    }
}

#[derive(Default)]
pub struct Metrics {
    pub pub_ok: AtomicU64,
    /// Публикации, авторизованные личным write-токеном в `Authorization`.
    pub pub_hdr: AtomicU64,
    pub pub_anon: AtomicU64,
    /// Публикации, авторизованные read-токеном отправителя из тела (`tok`) —
    /// штатный путь клиента без заголовка Authorization.
    pub pub_tok: AtomicU64,
    pub poll_hits: AtomicU64,
    pub ws_sessions: AtomicU64,
    pub rejected: AtomicU64,
    pub register_ok: AtomicU64,
    /// Инцидент 12.10: сколько раз /register вернул СУЩЕСТВУЮЩИЙ токен
    /// (адрес очереди не сменился) вместо выдачи нового.
    pub register_reuse: AtomicU64,
    /// §0: сколько раз упрели в суточный лимит (429).
    pub limit_hit: AtomicU64,
    /// M2 channels: сколько постов опубликовано в канальные очереди.
    pub channel_pub: AtomicU64,
    /// t_b8f44bdf: сколько раз клиент подтвердил СВОЙ текущий токен (`keep`) —
    /// связка fp → токен записана без выдачи нового (адрес стабилен).
    pub register_keep: AtomicU64,
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
    /// ADR-002: подпись конверта поста канала (Ed25519, base64url 64 Б).
    /// Опциональна: у личных конвертов её нет, у канала — только если
    /// kid зарегистрирован. serde(default) — старые клиенты собираются
    /// и работают без изменений.
    #[serde(default)]
    pub sig: Option<String>,
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

/// Как отправитель предъявил креды в `/relay/pub`. Метрики по способам
/// (`pub_hdr`/`pub_tok`/`pub_anon`/`channel_pub`) пишутся только для
/// УСПЕШНЫХ публикаций, поэтому `pub_ok` — их сумма: по метрикам видно,
/// что анонимных публикаций (релей «открыт») нет.
#[derive(Clone, Copy)]
enum Authz {
    /// Личный write-токен в заголовке `Authorization`.
    Header,
    /// Write-токен канала в заголовке `Authorization`.
    Channel,
    /// Свой read-токен в теле (`tok`) — штатный путь клиента.
    Body,
    /// Кредов нет (допустимо только при VAULT_RELAY_ANON_PUB=1).
    Anon,
}

/// Креды отправителя без заголовка `Authorization`: собственный read-токен
/// из тела (`tok`). Клиент шлёт его с M2.4, им же считается суточный лимит и
/// проверяется привязка токена к fp ниже. Годен только НЕпросроченный личный
/// read-токен: канальные/write-токены предъявляются через `Authorization`.
fn has_sender_token(app: &Arc<AppState>, req: &PubRequest) -> bool {
    match req.tok.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => matches!(
            vault_relay::parse(&app.keys, s),
            Some(t) if t.scope == Scope::Read && !t.is_expired()
        ),
        None => false,
    }
}

/// POST /relay/pub — положить конверт в очередь токена получателя.
/// Адресация — read-токен в `to` (capability, известен только собеседникам).
/// Отправитель предъявляет креды одним из двух способов: заголовок
/// `Authorization` (личный write-токен / write-токен канала) либо свой
/// read-токен в теле `tok` (клиент шлёт его с M2.4). Чистая анонимность
/// (ни заголовка, ни `tok`) допускается ТОЛЬКО при VAULT_RELAY_ANON_PUB=1 —
/// это совместимость со старыми сборками, в проде выключено.
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
    // Отозванный токен получателя: очередь закрыта (иначе отзыв безлимита
    // ничего не менял бы, пока живёт токен).
    if token_revoked(&app, &to_tok.hash) {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "recipient token revoked");
    }
    let is_channel = to_tok.scope == Scope::ChannelRead;
    // Способ авторизации отправителя: запоминаем здесь, а метрику пишем только
    // после успешной постановки в очередь (см. `pub_ok` ниже) — тогда отказы
    // по rate-limit, привязке и суточному лимиту не попадают в pub_tok/pub_anon
    // и по метрикам видно, что все принятые публикации атрибутированы.
    let authz;
    // Анонимный publish (§9.1): без заголовка — только если разрешено конфигом.
    // Канальные очереди — ИСКЛЮЧЕНИЕ: анонимный pub в канал запрещён всегда,
    // publish возможен только write-токеном этого же канала (link: kid==kid).
    // ADR-002: для канала с зарегистрированным kid подпись ОБЯЗАТЕЛЬНА.
    // Без неё любой держатель broadcast-ключа (= любой подписчик) может
    // публиковать в канал владельца: write-токен он выводит легитимно.
    if is_channel {
        let kid = to_tok.key_id;
        let entry = {
            let m = app.channel_keys.lock().expect("channel_keys lock");
            m.get(&kid.to_string()).cloned()
        };
        let verdict = channel_keys::verify_optional(
            entry.as_ref(),
            req.sig.as_deref(),
            kid,
            &req.id,
            &req.body,
            app.require_sig,
        );
        if matches!(verdict, channel_keys::Verdict::Invalid) {
            app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
            return err(StatusCode::FORBIDDEN, "channel post signature invalid");
        }
    }
    if let Some(auth) = auth_header(&headers) {
        match vault_relay::parse(&app.keys, &auth) {
            Some(t) if token_revoked(&app, &t.hash) => {
                app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                return err(StatusCode::UNAUTHORIZED, "token revoked");
            }
            Some(t) if t.scope == Scope::Write && !t.is_expired() && !is_channel => {
                authz = Authz::Header;
            }
            Some(t) if t.scope == Scope::ChannelWrite && !t.is_expired() => {
                if !is_channel {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::FORBIDDEN, "channel token cannot post to personal queue");
                }
                if !t.channel_matches(&to_tok) {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::FORBIDDEN, "channel token does not match queue");
                }
                authz = Authz::Channel;
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
    } else if has_sender_token(&app, &req) {
        // Креды отправителя — свой read-токен в теле `tok` (штатный путь
        // клиента): публикация авторизована и атрибутируема (hash токена).
        authz = Authz::Body;
    } else if app.allow_anonymous_pub {
        // Совместимость со старыми сборками: без Authorization и без `tok`
        // (kill-switch для легаси; в проде выключено).
        authz = Authz::Anon;
    } else {
        app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
        return err(StatusCode::UNAUTHORIZED, "sender token required");
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
                if token_revoked(&app, &t.hash) {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::UNAUTHORIZED, "token revoked");
                }
                if !check_token_binding(&app, &t.hash, &req.fp) {
                    app.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    return err(StatusCode::FORBIDDEN, "token bound to another account");
                }
            }
        }
    }
    // §0 company.md: суточный лимит конвертов на ИЗДАТЕЛЯ. Порог и счётчик —
    // на СЕРВЕРЕ: клиентское приложение пользователь вправе собрать сам,
    // поэтому тумблер/чип в фронте выбирает только канал, но не квоту.
    // Идентичность издателя: tok в теле (read-токен отправителя, шлёт клиент
    // M2.4) → его hash; иначе Authorization (write-токен) → hash; иначе IP.
    // Квота зависит от тарифа: Free — лимит релея, Trial — безлимит,
    // Pro/Business — свои пороги (daily_limit_for_token). Почта не
    // ограничивается никогда: 429 = только «ускорение» выключено, письмо
    // уйдёт как обычно.
    let (pub_key, quota) = publisher_key(&app, &headers, &req, &addr);
    if let Some(limit) = quota.filter(|l| *l > 0) {
        let retry_after = {
            let day = now() / 86400;
            let mut map = app.daily_pub.lock().unwrap();
            tally_daily(&mut map, &pub_key, day, limit, now())
        };
        if let Some(retry_after) = retry_after {
            app.metrics.limit_hit.fetch_add(1, Ordering::Relaxed);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", retry_after.to_string())],
                AxumJson(serde_json::json!({
                    "error": "daily relay limit reached",
                    "limit": limit,
                    "retry_after": retry_after,
                })),
            )
                .into_response();
        }
        // Счётчик обязан пережить рестарт (иначе квоту обходит деплой);
        // запись троттлится внутри, блокировка карты уже отпущена.
        app.persist_daily_quota();
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
    // Разбивка УСПЕШНЫХ публикаций по способу авторизации; сумма обязана
    // сходиться с pub_ok (инвариант закреплён тестом).
    match authz {
        Authz::Header => app.metrics.pub_hdr.fetch_add(1, Ordering::Relaxed),
        Authz::Channel => app.metrics.channel_pub.fetch_add(1, Ordering::Relaxed),
        Authz::Body => app.metrics.pub_tok.fetch_add(1, Ordering::Relaxed),
        Authz::Anon => app.metrics.pub_anon.fetch_add(1, Ordering::Relaxed),
    };
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
                    tokio::spawn({
                        let app = app.clone();
                        let topic = topic.clone();
                        async move {
                            if let Err(e) = sender.send(&reg, &push).await {
                                // reg_token сгорел (переустановка приложения,
                                // смена устройства) → FCM отвечает
                                // UNREGISTERED. Привязка больше не нужна:
                                // удаляем и сохраняем, иначе она живёт в
                                // state.json вечно и шлёт в никуда.
                                if e.contains("UNREGISTERED") {
                                    let mut m = app.topic_fcm.lock().expect("topic_fcm lock");
                                    if m.remove(&topic).is_some() {
                                        drop(m);
                                        app.persist();
                                        tracing::info!("fcm: unregistered reg_token dropped for topic");
                                    }
                                } else {
                                    tracing::error!(error = %e, "fcm send failed (envelope still queued)");
                                }
                            }
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

/// Токен отозван: токен stateless, поэтому отзыв живёт денлистом, и каждый
/// путь чтения/публикации обязан его спросить (иначе «отозванный» безлимит
/// продолжал бы работать до конца срока).
fn token_revoked(app: &AppState, hash: &str) -> bool {
    app.revoked_tokens
        .lock()
        .expect("revoked_tokens lock")
        .contains(hash)
}

fn require_read(app: &Arc<AppState>, headers: &HeaderMap) -> Option<vault_relay::Token> {
    let auth = auth_header(headers)?;
    let t = vault_relay::parse(&app.keys, &auth)?;
    if token_revoked(app, &t.hash) {
        return None;
    }
    (t.scope == Scope::Read || t.scope == Scope::ChannelRead).then_some(t)
}

/// Привязка токена к fingerprint аккаунта (анти-шаринг для монетизации).
/// Первый владелец: если у токена нет привязки — привязываем к текущему fp.
/// Чужой fp с тем же токеном → false (= 403 «token bound to another
/// account»). fp не пришёл (легаси-клиент) → true (привязку не трогаем).
fn check_token_binding(app: &Arc<AppState>, token_hash: &str, fp: &Option<String>) -> bool {
    // fp нормализуем (trim + нижний регистр): register и pub обязаны
    // вычислить одну и ту же привязку, иначе «AB:..» в одном месте и
    // «ab:..» в другом дали бы ложный 403 «token bound to another account».
    let Some(fp) = norm_fp(fp.as_deref()) else {
        return true;
    };
    let mut bindings = app.token_bindings.lock().unwrap();
    match bindings.get(token_hash) {
        Some(existing) => existing == &fp,
        None => {
            bindings.insert(token_hash.to_string(), fp);
            // НОВАЯ ПРИВЯЗКА — СОХРАНЯЕМ: после рестарта релея она обязана
            // остаться, иначе первый же использовавший перехватил бы токен.
            drop(bindings);
            app.persist();
            true
        }
    }
}

/// §0: идентичность издателя для суточного лимита и его квота.
/// Приоритет ключа: tok в теле (read-токен отправителя) → Authorization → IP.
/// `None` в квоте = лимита нет (Trial, легаси-promo, выключенный счётчик).
fn publisher_key(
    app: &Arc<AppState>,
    headers: &HeaderMap,
    req: &PubRequest,
    addr: &std::net::SocketAddr,
) -> (String, Option<u32>) {
    let auth = auth_header(headers);
    let candidates = req
        .tok
        .iter()
        .map(|s| s.as_str())
        .chain(auth.iter().map(|s| s.as_str()))
        .filter(|s| !s.is_empty());
    for tok in candidates {
        if let Some(t) = vault_relay::parse(&app.keys, tok) {
            return (
                format!("t:{}", t.hash),
                daily_limit_for_token(&t, app.free_daily_limit),
            );
        }
    }
    let anon_quota = (app.free_daily_limit > 0).then_some(app.free_daily_limit);
    (format!("ip:{}", addr.ip()), anon_quota)
}

/// Квота действий релея в сутки для токена издателя (конверты и выдача TURN —
/// один счётчик `t:<hash>`).
///
/// Вид токена — ЯВНЫЙ, а не эвристика по сроку: v2 несёт тариф.
///  - Free/установочный — бесплатный лимит релея (env);
///  - Trial — без лимита (промо-тестеры);
///  - Pro/Business — квоты тарифа, НЕ безлимит: покупка даёт больше
///    конвертов, но релей остаётся защищён от одной «качалки»;
///  - канальные токены — общий write-токен канала, лимит по его hash;
///  - легаси-v1 с долгим сроком — промо-выдача, без лимита (старое правило).
///
/// `free_limit = 0` (VAULT_RELAY_FREE_DAILY_LIMIT) выключает счётчик
/// БЕСПЛАТНОГО тарифа и анонимов (стенд/отладка): у Pro/Business остаются
/// их квоты — выключатель free-лимита не должен отключать монетизацию.
pub fn daily_limit_for_token(
    t: &vault_relay::tokens::Token,
    free_limit: u32,
) -> Option<u32> {
    if t.scope.is_channel() {
        return Some(free_limit);
    }
    if t.v >= 2 {
        match Kind::of(t) {
            Kind::Install => Some(free_limit),
            Kind::Test => None,
            Kind::Paid => Some(match t.plan {
                vault_relay::tokens::Plan::Business => BUSINESS_DAILY_LIMIT,
                _ => PRO_DAILY_LIMIT,
            }),
        }
    } else if u64::from(t.expiry) > now() + 365 * 86400 {
        None
    } else {
        Some(free_limit)
    }
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

/// Короткий успешный JSON-ответ (для хендлеров релея).
fn ok_json() -> Response {
    (StatusCode::OK, AxumJson(serde_json::json!({"ok": true}))).into_response()
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

/// Суточный лимит бесплатного релея по умолчанию (требование владельца:
/// 100 конвертов/сутки, больше — покупкой). Числом, а не комментарием:
/// значение видит только пользователь, а измерить его можно только тестом.
pub const DEFAULT_FREE_DAILY_LIMIT: u32 = 100;

/// Суточные квоты платных тарифов (design §2.3): Pro — 1000, Business —
/// 10000. Покупка НЕ делает релей безлимитным: квота защищает сервер от
/// одной «качалки», а тариф — это размер квоты, а не её отсутствие.
pub const PRO_DAILY_LIMIT: u32 = 1_000;
pub const BUSINESS_DAILY_LIMIT: u32 = 10_000;

/// Разбор `VAULT_RELAY_FREE_DAILY_LIMIT`. Отдельной ЧИСТОЙ функцией потому,
/// что «мусорное значение = дефолт, а не ноль» иначе не проверить: ноль —
/// штатный выключатель лимита, и путаница «опечатка в конфиге → лимита нет»
/// открыла бы релей для всех.
pub fn daily_limit_from_env(raw: Option<&str>) -> u32 {
    match raw.and_then(|s| s.trim().parse::<u32>().ok()) {
        Some(v) => v,
        None => DEFAULT_FREE_DAILY_LIMIT,
    }
}

/// Один шаг суточного счётчика издателей: `Some(retry_after)` — публикация
/// запрещена, `None` — разрешена и ЗАСЧИТАНА.
///
/// ЧИСТАЯ функция с ДНЁМ И «СЕЙЧАС» ПАРАМЕТРАМИ. Соблазн оставить счётчик
/// внутри `relay_pub` («он же три строки») стоит того, что смена суток там не
/// проверяется НИКАК: тест живёт внутри одной секунды, `entry.0 != day` никогда
/// не срабатывает, и снятая ветка сброса дала бы зелёный прогон — т.е. лимит
/// превратился бы в пожизненный для каждого, кто дожил до полуночи. Здесь же
/// день подставляется фикстурой, и мутация «сброс снят» ловится сразу.
pub fn tally_daily(
    map: &mut HashMap<String, (u64, u32)>,
    publisher: &str,
    day: u64,
    limit: u32,
    now: u64,
) -> Option<u64> {
    let entry = map.entry(publisher.to_string()).or_insert((day, 0));
    if entry.0 != day {
        *entry = (day, 0);
    }
    if entry.1 >= limit {
        return Some((day + 1) * 86400 - now);
    }
    entry.1 += 1;
    None
}

/// GET /metrics — счётчики для мониторинга (без пользовательских данных).
pub async fn metrics(State(app): State<Arc<AppState>>) -> Response {
    let m = &app.metrics;
    let body = format!(
        "pub_ok {}\npub_hdr {}\npub_anon {}\npub_tok {}\npoll_hits {}\nws_sessions {}\nrejected {}\nqueued {}\nregister_ok {}\nregister_reuse {}\nregister_keep {}\nlimit_hit {}\nchannel_pub {}\n",
        m.pub_ok.load(Ordering::Relaxed),
        m.pub_hdr.load(Ordering::Relaxed),
        m.pub_anon.load(Ordering::Relaxed),
        m.pub_tok.load(Ordering::Relaxed),
        m.poll_hits.load(Ordering::Relaxed),
        m.ws_sessions.load(Ordering::Relaxed),
        m.rejected.load(Ordering::Relaxed),
        app.store.total(),
        m.register_ok.load(Ordering::Relaxed),
        m.register_reuse.load(Ordering::Relaxed),
        m.register_keep.load(Ordering::Relaxed),
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
    // Привязка переживает рестарт релея — иначе после рестарта клиент
    // (кэш «уже зарегистрирован» в prefs) не придёт второй раз, а будить
    // будет нечем (ntfy на проде не настроен) → мёртвый wake-канал.
    app.persist();
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
    // Клиент прислал новый звук → сохраняем на диск (переживает рестарт).
    // Простое «прочитать свой звук» (поле пустое) диск не трогает.
    if ring.is_some() && req.ringtone.is_some() {
        app.persist();
    }
    AxumJson(serde_json::json!({ "ringtone": ring })).into_response()
}

/// M2.4: авто-выдача read-токена новому пользователю (freemium).
/// Rate-limit по IP: 3 НОВЫЕ регистрации в сутки — иначе скопом выметут
/// лимиты. Переиспользование собственного токена (тот же fp) квоту НЕ тратит:
/// адрес очереди обязан быть стабильным (инцидент 12.10.2026).
/// Токен = адрес очереди получателя + его ntfy-topic (hex(mac)).
#[derive(serde::Serialize)]
struct RegisterOk {
    token: String,
    topic: String,
    exp: u32,
    /// Безлимитный (тестовый/платный) — суточного лимита конвертов нет.
    unlimited: bool,
    /// Вид токена: "install" | "test" | "paid" (vault_relay::tokens::Kind).
    /// Клиент может показать пользователю, что именно ему выдано.
    kind: String,
}
#[derive(Deserialize, Default)]
struct RegisterReq {
    /// Промо-ключ безлимита (тестеры/владелец): вид токена `test`.
    /// Осознанный апгрейд: если у fp сейчас установочный токен, он будет
    /// заменён тестовым. Повторный ввод того же ключа токен НЕ меняет.
    #[serde(default)]
    promo: Option<String>,
    /// Fingerprint аккаунта, получающего токен: (1) привязка «один токен =
    /// один аккаунт» (анти-шаринг при монетизации); (2) СТАБИЛЬНОСТЬ адреса
    /// очереди — повторная регистрация с тем же fp возвращает тот же токен.
    #[serde(default)]
    fp: Option<String>,
    /// S3: URL рингтона входящего звонка из настроек клиента
    /// (ring_incoming | ring_incoming_classic | ring_incoming_pulse .mp3).
    /// Необязателен: без него у темы дефолтный звук. Легаси-клиенты
    /// поле не шлют.
    #[serde(default)]
    ringtone: Option<String>,
    /// t_b8f44bdf: «заявка» токена, который у клиента УЖЕ есть. Устройства,
    /// получившие токен до появления карты fp (v1, 30 дней), при протухании
    /// сменили бы адрес очереди ещё раз. Присланный токен записывается как
    /// связка fp → токен: нового токена нет, IP-квота не тратится.
    /// Принимается только валидный (не протухший) read-токен, не привязанный
    /// к ДРУГОМУ fp; иначе — обычная выдача.
    #[serde(default)]
    keep: Option<String>,
}

/// fp из запроса: trim + нижний регистр (`aa:bb:...`). Регистр приводим к
/// одному виду, иначе «AB:..» и «ab:..» дали бы разные привязки/записи.
fn norm_fp(fp: Option<&str>) -> Option<String> {
    fp.map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty() && s.len() <= 128)
}


// ── ADR-002: регистрация публичного ключа подписи канала ──────────────────

/// Запрос регистрации: канальный read-токен целиком + Ed25519 public key.
///
/// kid (key_id) сервер выводит САМ из токена: key_id — это u64, а JSON-число
/// после 2^53 теряет точность, и клиент, присылающий kid числом, мог бы молча
/// подменить канал. Так исключено и расхождение между тем, что
/// зарегистрировали, и тем, куда потом публикуют.
#[derive(Deserialize)]
struct ChannelKeyReq {
    /// read-токен канала целиком (см. выше, почему не kid числом).
    token: String,
    /// Публичный ключ подписи владельца, hex.
    pubkey: String,
}

/// POST /relay/channel-key — владелец канала регистрирует ключ подписи.
///
/// Аутентификация — ЛИЧНЫЙ токен владельца в Authorization. Это единственное,
/// чем сервер может отличить владельца от подписчика: broadcast-ключ у них
/// общий, а личный токен проверяется сервером (server_key есть только у него).
///
/// Первый claim побеждает: повтор с ДРУГИМ ключом → 409. Осознанный
/// компромисс (ADR-002 §7); выход владельцу — ротация ключа канала
/// (channels-protocol.md §3.3), она даёт новый kid. Повтор с тем же ключом —
/// идемпотентный OK: адрес канала не должен меняться от перезапуска клиента.
/// Тип ТОКЕНА ВЛАДЕЛЬЦА в терминах политики `decide_registration`.
///
/// ТОТАЛЬНОЕ отображение: None означает только «токен не разобрался». Раньше
/// канальные scope схлопывались в None, и подписчик, подставивший свой
/// канальный токен как личный, получал 401 «bad token» вместо 403
/// «personal token required» — а ветка 403 в политике становилась
/// НЕДОСТИЖИМОЙ, оставаясь «покрытой» тестом, который зовёт чистую функцию
/// напрямую и никогда не проходит через этот маппинг. Ровно то расхождение
/// между хендлером и политикой, из-за которого политика вынесена в функцию.
fn owner_scope_of(scope: vault_relay::Scope) -> Option<char> {
    Some(match scope {
        vault_relay::Scope::Read => 'r',
        vault_relay::Scope::Write => 'w',
        vault_relay::Scope::ChannelRead => 'c',
        vault_relay::Scope::ChannelWrite => 'C',
    })
}

async fn relay_channel_key(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ChannelKeyReq>,
) -> Response {
    let Some(auth) = auth_header(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "personal token required");
    };
    let Some(t) = vault_relay::parse(&app.keys, &auth) else {
        return err(StatusCode::UNAUTHORIZED, "bad token");
    };
    // Политика приёма — ОДНА: channel_keys::decide_registration. Хендлер её
    // только вызывает: дублировать проверки здесь запрещено (как уже было
    // с kid/token — две копии тихо разошлись).
    let chan = vault_relay::parse(&app.keys, &req.token);
    let owner_scope = owner_scope_of(t.scope);
    let (chan_scope, chan_kid) = match chan {
        Some(c) => (
            Some(match c.scope {
                vault_relay::Scope::Read => 'r',
                vault_relay::Scope::Write => 'w',
                vault_relay::Scope::ChannelRead => 'c',
                vault_relay::Scope::ChannelWrite => 'C',
            }),
            Some(c.key_id),
        ),
        None => (None, None),
    };
    match channel_keys::decide_registration(
        owner_scope,
        t.is_expired(),
        chan_scope,
        chan_kid,
        &req.pubkey,
    ) {
        channel_keys::RegisterDecision::Reject { status, error } => {
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            return err(code, error);
        }
        channel_keys::RegisterDecision::Accept { kid } => {
            let kid_s = kid;
            // pubkey уже проверен политикой (hex + точка кривой): здесь только
            // нормализация регистра перед записью.
            let pk = req.pubkey.trim().to_ascii_lowercase();
            {
                let mut m = app.channel_keys.lock().expect("channel_keys lock");
                if let Some(existing) = m.get(&kid_s) {
                    if existing.pubkey == pk {
                        return ok_json();
                    }
                    return err(StatusCode::CONFLICT, "kid already registered");
                }
                m.insert(
                    kid_s.clone(),
                    channel_keys::Entry {
                        owner_hash: t.hash.clone(),
                        pubkey: pk,
                        created_at: now(),
                    },
                );
            }
            app.persist();
            tracing::info!(kid = %kid_s, "channel-key registered");
            ok_json()
        }
    }
}

async fn relay_register(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(req): Json<RegisterReq>,
) -> Response {
    let ip = addr.ip().to_string();
    let now_secs = now();
    let now32 = now_secs as u32;
    let promo_ok = app
        .unlimited_key
        .as_deref()
        .zip(req.promo.as_deref())
        .map(|(k, p)| k == p)
        .unwrap_or(false);
    let fp = norm_fp(req.fp.as_deref());
    // Персональный тестовый код (6 месяцев, отзываемый). Общий промо-ключ
    // владельца остаётся отдельной веткой: он живёт 10 лет и общий.
    let code_hash = req.promo.as_deref().and_then(test_codes::hash);
    let code_rec = code_hash.as_ref().and_then(|h| {
        app.tester_codes
            .lock()
            .expect("tester_codes lock")
            .get(h)
            .cloned()
    });
    if code_rec.is_some() && fp.is_none() {
        // Код без fp нечем привязать: выдали бы безлимит «в воздух».
        return err(StatusCode::UNPROCESSABLE_ENTITY, "fp required for tester code");
    }
    if let (Some(rec), Some(fp_ref)) = (code_rec.as_ref(), fp.as_deref()) {
        match test_codes::claim(rec, fp_ref) {
            Claim::Revoked => return err(StatusCode::FORBIDDEN, "tester code revoked"),
            Claim::Other => {
                return err(StatusCode::CONFLICT, "tester code bound to another account")
            }
            Claim::Fresh | Claim::Same => {}
        }
    }
    // Приглашённый (промо-ключ или личный код) не тратит IP-квоту: тестер
    // приходит по нашей воле, а не «третья выдача с этого IP за сутки».
    let invite_ok = promo_ok || code_rec.is_some();
    let code_days = code_rec
        .as_ref()
        .map(|r| test_codes::ttl_days(Some(r.days)))
        .unwrap_or(test_codes::DEFAULT_DAYS);
    // Вид токена для НОВОЙ выдачи: промо-ключ/код → тестовый, иначе установочный.
    let want_kind = if invite_ok { Kind::Test } else { Kind::Install };

    // (1) ИДЕМПОТЕНТНОСТЬ по fp: адрес очереди НЕ меняется. Клиент, потерявший
    // свою запись (миграция kv, чистая переустановка, рестарт релея), получит
    // ТОТ ЖЕ токен, а не новый — иначе собеседники молча теряют канал.
    // Исключение — осознанный апгрейд: предъявлен промо-ключ, а запись сейчас
    // установочная (пользователь «получил тестовый токен»).
    if let Some(fp_ref) = fp.as_deref() {
        let existing = {
            let map = app.fp_tokens.lock().expect("fp_tokens lock");
            map.get(fp_ref).filter(|r| r.exp > now32).cloned()
        };
        if let Some(rec) = existing {
            // (1a) ПЛАТНЫЙ ТОКЕН КЛИЕНТА ВАЖНЕЕ БЕСПЛАТНОЙ ЗАПИСИ ПО ЭТОМУ fp.
            //
            // Покупка Pro выдаёт токен отдельной операцией (/relay/purchase/verify),
            // и в карту fp→токен он НЕ попадает: там лежит бесплатный токен,
            // выданный при прошлой регистрации. Если сейчас вернуть бесплатную
            // запись, клиент потеряет купленный Pro уже при СЛЕДУЮЩЕЙ
            // регистрации (а он регистрируется при каждом входе) — покупка
            // отменялась бы сама собой через минуту.
            //
            // Проверки те же, что и в блоке (1b) ниже: токен разбирается,
            // это read-область, не протух, и привязан к ЭТОМУ же fp. То есть
            // «keep» здесь — недоверенное заявление, а проверенный факт.
            if let Some(keep_raw) = req.keep.as_deref() {
                let keep_tok = keep_raw.trim();
                if let Some(t) = vault_relay::parse(&app.keys, keep_tok) {
                    let paid = matches!(t.plan, vault_relay::tokens::Plan::Pro | vault_relay::tokens::Plan::Business);
                    if paid
                        && t.scope == Scope::Read
                        && !t.is_expired()
                        && check_token_binding(&app, &t.hash, &req.fp)
                    {
                        // Запись переводится на платный токен: следующая
                        // регистрация (даже без keep) вернёт именно его.
                        {
                            let mut map = app.fp_tokens.lock().expect("fp_tokens lock");
                            map.insert(
                                fp_ref.to_string(),
                                FpToken {
                                    token: keep_tok.to_string(),
                                    kind: Kind::of(&t).as_str().to_string(),
                                    exp: t.expiry,
                                },
                            );
                        }
                        app.metrics.register_keep.fetch_add(1, Ordering::Relaxed);
                        ringtone_resolve(&app.topic_ringtone, &t.hash, req.ringtone.as_deref());
                        app.persist();
                        tracing::info!(
                            fp = %fp_ref,
                            plan = ?t.plan,
                            "register: kept PAID token (paid beats free record)"
                        );
                        let keep_kind = Kind::of(&t).as_str().to_string();
                        let keep_unlimited = Kind::of(&t).is_unlimited();
                        let keep_hash = t.hash.clone();
                        let keep_exp = t.expiry;
                        return (
                            StatusCode::OK,
                            AxumJson(RegisterOk {
                                token: keep_tok.to_string(),
                                topic: keep_hash,
                                exp: keep_exp,
                                unlimited: keep_unlimited,
                                kind: keep_kind,
                            }),
                        )
                            .into_response();
                    }
                }
            }
            if let Some(t) = vault_relay::parse(&app.keys, &rec.token) {
                let kind = Kind::of(&t);
                // Отозванный токен не возвращаем: выдаём новый ниже.
                let existing_revoked = token_revoked(&app, &t.hash);
                if !(existing_revoked || (invite_ok && kind == Kind::Install)) {
                    // Отдаём его же токен: квота IP не тратится, state не меняется.
                    app.metrics.register_reuse.fetch_add(1, Ordering::Relaxed);
                    ringtone_resolve(&app.topic_ringtone, &t.hash, req.ringtone.as_deref());
                    if norm_ringtone(req.ringtone.as_deref()).is_some() {
                        app.persist();
                    }
                    tracing::info!(fp = %fp_ref, kind = kind.as_str(), "register: token reused (stable queue)");
                    return (
                        StatusCode::OK,
                        AxumJson(RegisterOk {
                            token: rec.token,
                            topic: t.hash,
                            exp: t.expiry,
                            unlimited: kind.is_unlimited(),
                            kind: kind.as_str().to_string(),
                        }),
                    )
                        .into_response();
                }
                // install → test: выдаём новый токен ниже (осознанная смена).
            }
        }
    }

    // (1b) ЗАЯВКА уже имеющегося токена (keep, t_b8f44bdf). Устройства,
    // получившие токен ДО появления карты fp (v1), при протухании сменили бы
    // адрес очереди ещё раз. Клиент предъявляет свой текущий токен, и сервер
    // записывает связку fp → токен ЗАРАНЕЕ. Нового токена нет, IP-квота не
    // тратится. Порядок важен: блок (1) уже отдал бы свой токен, если запись
    // живая, — сюда попадаем только без живой записи.
    if app.keep_claim.load(Ordering::Relaxed) {
        if let (Some(fp_ref), Some(keep_raw)) = (fp.as_deref(), req.keep.as_deref()) {
            let keep_tok = keep_raw.trim();
            if let Some(t) = vault_relay::parse(&app.keys, keep_tok)
                .filter(|t| !token_revoked(&app, &t.hash))
            {
                // (а) токен валиден и не протух + это адрес очереди аккаунта
                // (read-scope; write/канальные токены адресом очереди не являются).
                if t.scope == Scope::Read && !t.is_expired() {
                    // (в) токен не привязан к ДРУГОМУ fp: первый владелец — ок
                    // (привязываем), чужой fp → заявку отвергаем и идём обычным
                    // путём выдачи (как раньше).
                    if check_token_binding(&app, &t.hash, &req.fp) {
                        let kind = Kind::of(&t);
                        // (б) для этого fp живой записи нет (иначе вышли бы в
                        // блоке (1)): записываем заявленный токен.
                        {
                            let mut map = app.fp_tokens.lock().expect("fp_tokens lock");
                            map.insert(
                                fp_ref.to_string(),
                                FpToken {
                                    token: keep_tok.to_string(),
                                    kind: kind.as_str().to_string(),
                                    exp: t.expiry,
                                },
                            );
                        }
                        app.metrics.register_keep.fetch_add(1, Ordering::Relaxed);
                        ringtone_resolve(&app.topic_ringtone, &t.hash, req.ringtone.as_deref());
                        app.persist();
                        tracing::info!(
                            fp = %fp_ref,
                            kind = kind.as_str(),
                            "register: kept existing token (fp → token recorded)"
                        );
                        return (
                            StatusCode::OK,
                            AxumJson(RegisterOk {
                                token: keep_tok.to_string(),
                                topic: t.hash,
                                exp: t.expiry,
                                unlimited: kind.is_unlimited(),
                                kind: kind.as_str().to_string(),
                            }),
                        )
                            .into_response();
                    }
                }
            }
        }
    }

    // (2) Новая выдача: только она расходует IP-квоту (3/сутки).
    if !invite_ok {
        let mut rl = app.registrations.lock().unwrap();
        let (count, window_start) = rl.entry(ip).or_insert((0u32, now_secs));
        if now_secs.saturating_sub(*window_start) > 86400 {
            *count = 0;
            *window_start = now_secs;
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
    // install: 10 лет + суточный лимит; test: без лимита.
    // Срок намеренно долгий: короткий срок = периодическая смена адреса
    // очереди = потеря канала у собеседников (см. TOKEN_LIFETIME_DAYS).
    // Исключение — личный код тестера: у него свой ограниченный срок,
    // чтобы забытый код не жил вечно (отзыв — отдельно, денлистом).
    let token = match (want_kind, promo_ok) {
        (Kind::Test, true) => vault_relay::tokens::issue_test(&app.keys, now32),
        (Kind::Test, false) => {
            vault_relay::tokens::issue_test_days(&app.keys, now32, code_days)
        }
        _ => vault_relay::tokens::issue_install(&app.keys, now32),
    };
    let Some(parsed) = vault_relay::parse(&app.keys, &token) else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "token issue failed");
    };
    let topic = parsed.hash.clone();
    // Привязка токена к fingerprint сразу при выдаче (если клиент прислал).
    if !check_token_binding(&app, &topic, &req.fp) {
        // Новый токен уже занят другим аккаунтом — невозможно (токен свежий),
        // но на всякий случай не отдаём его чужому fp.
        return err(StatusCode::CONFLICT, "token already bound");
    }
    // S3: заодно сохраняем рингтон звонка из настроек клиента (если
    // прислан валидный http-URL) — тема = hash этого же токена.
    ringtone_resolve(&app.topic_ringtone, &topic, req.ringtone.as_deref());
    // (3) Запоминаем выдачу fp → токен: переживает рестарт релея и делает
    // следующую регистрацию идемпотентной.
    let mut persisted = norm_ringtone(req.ringtone.as_deref()).is_some();
    if let Some(fp_ref) = fp.as_deref() {
        {
            let mut map = app.fp_tokens.lock().expect("fp_tokens lock");
            map.insert(
                fp_ref.to_string(),
                FpToken {
                    token: token.clone(),
                    kind: want_kind.as_str().to_string(),
                    exp: parsed.expiry,
                },
            );
        }
        persisted = true;
    }
    // Личный код: закрепляем за fp и запоминаем выданный токен — по этому
    // хешу работает отзыв, а по fp — повторная идемпотентная выдача.
    if let (Some(h), Some(fp_ref)) = (code_hash.as_deref(), fp.as_deref()) {
        if let Some(rec) = app
            .tester_codes
            .lock()
            .expect("tester_codes lock")
            .get_mut(h)
        {
            rec.fp = Some(fp_ref.to_string());
            rec.token_hash = Some(topic.clone());
            if rec.days == 0 {
                rec.days = code_days;
            }
            persisted = true;
        }
    }
    app.metrics.register_ok.fetch_add(1, Ordering::Relaxed);
    tracing::info!(
        fp = fp.as_deref().unwrap_or("-"),
        kind = want_kind.as_str(),
        "register: token issued (stable by fp)"
    );
    // Кастомный рингтон и запись fp тоже переживают рестарт релея.
    if persisted {
        app.persist();
    }
    (
        StatusCode::OK,
        AxumJson(RegisterOk {
            token,
            topic,
            exp: parsed.expiry,
            unlimited: want_kind.is_unlimited(),
            kind: want_kind.as_str().to_string(),
        }),
    )
        .into_response()
}

// ───────────────────────── Админ: тестовые коды ─────────────────────────
//
// Роуты существуют только при заданном VAULT_RELAY_ADMIN_KEY: без секрета
// они отвечают 404 (не «работают без пароля»). Nginx наружу их не отдаёт —
// вызов только с localhost по SSH. Код — bearer-секрет, поэтому в list
// отдаём только хеш, а открытый текст — ровно один раз при создании.

fn admin_ok(app: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = app.admin_key.as_deref() else {
        return false;
    };
    let Some(got) = headers
        .get("x-admin-key")
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    // Сравнение постоянного времени: длина + XOR по всем байтам.
    got.len() == expected.len()
        && got
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

#[derive(Deserialize)]
pub struct TestCodeReq {
    #[serde(default)]
    label: String,
    #[serde(default)]
    days: Option<u32>,
}

/// POST /admin/test-code — выдать персональный код тестеру.
async fn admin_test_code_create(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumJson(req): AxumJson<TestCodeReq>,
) -> Response {
    if !admin_ok(&app, &headers) {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    let code = test_codes::generate();
    let hash = test_codes::hash(&code).expect("generated code is canonical");
    let days = test_codes::ttl_days(req.days);
    let label: String = req.label.trim().chars().take(120).collect();
    let rec = TesterCode {
        label: label.clone(),
        days,
        created_at: now(),
        fp: None,
        token_hash: None,
        revoked: false,
    };
    app.tester_codes
        .lock()
        .expect("tester_codes lock")
        .insert(hash, rec);
    app.persist();
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({
            "code": code,
            "label": label,
            "days": days,
        })),
    )
        .into_response()
}

/// GET /admin/test-codes — список кодов (без открытых значений).
async fn admin_test_codes_list(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !admin_ok(&app, &headers) {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    let map = app.tester_codes.lock().expect("tester_codes lock");
    let mut items: Vec<serde_json::Value> = map
        .iter()
        .map(|(hash, r)| {
            serde_json::json!({
                "code_hash": hash,
                "label": r.label,
                "days": r.days,
                "created_at": r.created_at,
                "fp": r.fp,
                "used": r.fp.is_some(),
                "revoked": r.revoked,
            })
        })
        .collect();
    items.sort_by_key(|v| v["created_at"].as_u64().unwrap_or(0));
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({ "codes": items, "count": items.len() })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct RevokeReq {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    fp: Option<String>,
}

/// POST /admin/revoke — отозвать безлимит по коду или fingerprint.
async fn admin_revoke(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumJson(req): AxumJson<RevokeReq>,
) -> Response {
    if !admin_ok(&app, &headers) {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    let mut revoked = 0usize;
    let mut found = false;
    // По коду: помечаем запись и кладём её токен в денлист.
    if let Some(raw) = req.code.as_deref() {
        let Some(h) = test_codes::hash(raw) else {
            return err(StatusCode::UNPROCESSABLE_ENTITY, "bad code");
        };
        let token_hash = {
            let mut map = app.tester_codes.lock().expect("tester_codes lock");
            match map.get_mut(&h) {
                Some(rec) => {
                    found = true;
                    rec.revoked = true;
                    rec.token_hash.clone()
                }
                None => None,
            }
        };
        if let Some(th) = token_hash {
            if app
                .revoked_tokens
                .lock()
                .expect("revoked_tokens lock")
                .insert(th)
            {
                revoked += 1;
            }
        }
    }
    // По fp: убираем выдачу (следующая регистрация даст обычный токен),
    // отзываем её токен и связанные коды — «удалить у аккаунта» одним ключом.
    if let Some(fp) = req.fp.as_deref().and_then(|f| norm_fp(Some(f))) {
        let rec = app
            .fp_tokens
            .lock()
            .expect("fp_tokens lock")
            .remove(&fp);
        if let Some(rec) = rec {
            found = true;
            if let Some(t) = vault_relay::parse(&app.keys, &rec.token) {
                if app
                    .revoked_tokens
                    .lock()
                    .expect("revoked_tokens lock")
                    .insert(t.hash)
                {
                    revoked += 1;
                }
            }
        }
        // Гард отпускаем ДО persist(): он берёт те же мьютексы заново,
        // а std-мьютекс не рекурсивен.
        let marked = {
            let mut codes = app.tester_codes.lock().expect("tester_codes lock");
            let mut marked = 0usize;
            for c in codes.values_mut() {
                if c.fp
                    .as_deref()
                    .map(|f| f.eq_ignore_ascii_case(&fp))
                    .unwrap_or(false)
                {
                    c.revoked = true;
                    marked += 1;
                }
            }
            marked
        };
        found |= marked > 0;
    }
    if !found {
        return err(StatusCode::NOT_FOUND, "nothing to revoke");
    }
    app.persist();
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({ "revoked": revoked })),
    )
        .into_response()
}

// ───────────────────────── Платёжные роуты (шаг 4–5 плана) ──────────────
//
// Сервер сам спрашивает платёжного провайдера, доверяя клиенту только в
// одном — в идентификаторе чекаута. Клиент может сказать «я заплатил» — это
// ничего не значит, пока провайдер не подтвердил оплату.

/// Запрос на создание платёжной сессии.
#[derive(Deserialize)]
pub struct CheckoutReq {
    /// Тариф: "pro" | "business".
    plan: String,
    /// Срок оплаты в месяцах: 1 | 12.
    months: u32,
    /// fingerprint покупателя.
    fp: String,
    /// Язык платёжной страницы ("ru" | "en").
    #[serde(default)]
    lang: Option<String>,
}

/// Запрос на подтверждение оплаты.
#[derive(Deserialize)]
pub struct VerifyReq {
    /// Идентификатор чекаута (co_…).
    checkout_id: String,
    /// fingerprint покупателя — обязан совпасть с чекаутом.
    fp: String,
}

/// Тариф по имени. Покупаются только Pro и Business: Free/Trial не тарифы,
/// а состояния выдачи.
fn paid_plan(name: &str) -> Option<vault_relay::tokens::Plan> {
    match name {
        "pro" => Some(vault_relay::tokens::Plan::Pro),
        "business" => Some(vault_relay::tokens::Plan::Business),
        _ => None,
    }
}

/// Ошибка платёжного провайдера → HTTP-код и текст.
fn payment_error_response(e: vault_relay::payments::PaymentError) -> Response {
    use vault_relay::payments::PaymentError as PE;
    match e {
        PE::Unavailable => err(StatusCode::PAYMENT_REQUIRED, "checkout disabled"),
        PE::NotPaidYet => err(StatusCode::PAYMENT_REQUIRED, "not_paid_yet"),
        PE::Expired => err(StatusCode::GONE, "checkout expired"),
        PE::Rejected(why) => err(StatusCode::PAYMENT_REQUIRED, &format!("payment rejected: {why}")),
    }
}


// ── Роуты токена подписки: активация на устройстве и остаток лимитов ────

/// Сколько устройств может использовать один платный токен.
pub const MAX_DEVICES: u32 = 3;

/// Запрос активации платного токена на устройстве.
#[derive(Deserialize)]
pub struct ActivateReq {
    /// v2-токен с планом.
    token: String,
    /// fingerprint устройства.
    fp: String,
}

/// POST /relay/tokens/activate — привязать платный токен к устройству.
///
/// Проверка идёт по СУБ-подписке (все токены с тем же sub), а не по
/// отдельному токену: так «купил один Pro, переустановил на трёх телефонах»
/// ограничено тремя устройствами, а не тремя токенами.
async fn relay_tokens_activate(
    State(app): State<Arc<AppState>>,
    Json(req): Json<ActivateReq>,
) -> Response {
    let Some(t) = vault_relay::parse(&app.keys, &req.token) else {
        return err(StatusCode::BAD_REQUEST, "bad token");
    };
    // Платный = с plan Pro/Business (v2). Free/Install — обычные токены, у них
    // лимита устройств нет (как раньше: один аккаунт — один токен).
    let paid = matches!(
        t.plan,
        vault_relay::tokens::Plan::Pro | vault_relay::tokens::Plan::Business
    );
    if !paid {
        return err(StatusCode::PAYMENT_REQUIRED, "not a paid token");
    }
    // 402: подписка истекла.
    let paid_until = t.paid_until as u64;
    if paid_until <= now() {
        return err(StatusCode::PAYMENT_REQUIRED, "plan_expired");
    }
    let fp = match norm_fp(Some(&req.fp)) {
        Some(f) => f,
        None => return err(StatusCode::BAD_REQUEST, "bad fp"),
    };
    // 409: токен уже за другим аккаунтом.
    if !check_token_binding(&app, &t.hash, &Some(fp.clone())) {
        return err(StatusCode::CONFLICT, "bound_to_another");
    }
    // АКТИВАЦИЯ ЗАКРЕПЛЯЕТ ТОКЕН ЗА АККАУНТОМ (fp → токен).
    //
    // Без этого купленный Pro был бы невосстановим: клиент потерял бы
    // токен (переустановка, очистка данных, потеря KV), а карта fp→токен
    // продолжала бы лежать с БЕСПЛАТНЫМ токеном — регистрация выдала бы
    // бесплатный, и платная подписка пропадала бы навсегда.
    //
    // Теперь после активации запись fp→токен указывает на платный токен, и
    // обычная регистрация (даже без `keep`) вернёт именно его — восстановление
    // происходит само, без поддержки и без нового платежа.
    {
        let kind = Kind::of(&t);
        let mut map = app.fp_tokens.lock().expect("fp_tokens lock");
        let mut rec = FpToken {
            token: req.token.clone(),
            kind: kind.as_str().to_string(),
            exp: t.expiry,
        };
        // Не понижаем вид: если за fp уже стоял платный токен, а предъявлен
        // бесплатный — оставляем платный (иначе «keep» бесплатным токеном
        // обнулял бы подписку).
        if let Some(old) = map.get(&fp) {
            if old.kind == "paid" && rec.kind != "paid" {
                rec = old.clone();
            }
        }
        map.insert(fp.clone(), rec);
    }
    // Сколько устройств у этой подписки: считаем по sub, а не по токену.
    // Регистрируем токен (одно устройство) и считаем заново: повторная
    // активация того же токена не должна увеличивать счётчик.
    let sub_key = t.sub.to_string();
    app.register_sub_token(&sub_key, &t.hash);
    let devices = app.subscription_devices(&sub_key);
    if devices > MAX_DEVICES {
        return err(StatusCode::CONFLICT, "device_limit");
    }
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({
            "bound": true,
            "devices": devices,
            "max_devices": MAX_DEVICES,
            "paid_until": paid_until,
        })),
    )
        .into_response()
}

/// GET /relay/tokens/info — состояние подписки и остаток лимитов.
///
/// Нужен экрану покупки («действий релея сегодня 12/1000») и офлайн-грейсу:
/// серверная граница grace_until, чтобы клиент не «удлинял» офлайн-режим
/// бесконечно.
async fn relay_tokens_info(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = auth_header(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "missing token");
    };
    let Some(t) = vault_relay::parse(&app.keys, &token) else {
        return err(StatusCode::UNAUTHORIZED, "bad token");
    };
    if token_revoked(&app, &t.hash) {
        return err(StatusCode::UNAUTHORIZED, "token revoked");
    }
    if t.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");
    }
    // Суточный расход издателя по этому токену (ключ — как у гейта лимита).
    // Счётчик прошлых суток не показываем: после полуночи UTC он обнулится
    // при первой же публикации, и «осталось 0» до неё было бы ложью.
    let pub_key = format!("t:{}", t.hash);
    let today = now() / 86400;
    let daily_used = {
        let map = app.daily_pub.lock().expect("daily_pub lock");
        map.get(&pub_key)
            .filter(|(day, _)| *day == today)
            .map(|(_, n)| *n)
            .unwrap_or(0)
    };
    // 0 = «лимита нет» (Trial / выключенный счётчик): контракт с клиентом.
    let daily_limit = daily_limit_for_token(&t, app.free_daily_limit).unwrap_or(0);
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({
            "plan": format!("{:?}", t.plan).to_lowercase(),
            "paid_until": t.paid_until as u64,
            "daily_used": daily_used,
            "daily_limit": daily_limit,
            "devices": app.subscription_devices(&t.sub.to_string()),
            "max_devices": MAX_DEVICES,
            // Серверная граница офлайн-грейса: клиент доверяет локальному
            // счёту только до этого момента.
            "grace_until": t.paid_until as u64,
        })),
    )
        .into_response()
}

/// GET /relay/turn — ВРЕМЕННЫЕ TURN-креды (звонки вне одной подсети).
///
/// Без relay-кандидата ICE собирается только на host/srflx, и звонок живёт
/// ровно внутри одной Wi-Fi: телефон на LTE/CGNAT оператора к десктопу не
/// подключается вообще. Поэтому выдаём пару по схеме coturn
/// `use-auth-secret` (см. vault_relay::turn): статический секрет наружу не
/// уезжает никогда, а выданная пара протухает через CRED_TTL сама — coturn
/// читает срок из username.
///
/// Квота — на сервере (наше правило: клиент лимит не поднимает) и ОБЩАЯ с
/// конвертами: выдача кредитов тратит один из суточных лимита релея токена —
/// тот же порог (`daily_limit_for_token`) и тот же ключ счётчика (`t:<hash>`),
/// что у publish. Мера одна: «сколько раз за сутки ты воспользовался рлеем». Её
/// и продаём в тарифе, и объясняем в магазине, вместо второго непонятного
/// числа. Рестарт релея лимит не обнуляет — счётчик персистентный.
async fn relay_turn(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(cfg) = app.turn.as_ref() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "turn not configured");
    };
    let Some(token) = auth_header(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "missing token");
    };
    let Some(t) = vault_relay::parse(&app.keys, &token) else {
        return err(StatusCode::UNAUTHORIZED, "bad token");
    };
    if token_revoked(&app, &t.hash) {
        return err(StatusCode::UNAUTHORIZED, "token revoked");
    }
    if t.is_expired() {
        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");
    }
    // Канальный токен — не аккаунт звонящего: права на relay-трафик нет.
    // Отдельно от квоты: у канала свой общий бюджет, и отказывать надо до
    // его расхода, а не после 429.
    if t.scope.is_channel() {
        return err(StatusCode::FORBIDDEN, "channel token");
    }
    let limit = daily_limit_for_token(&t, app.free_daily_limit);
    if let Some(limit) = limit.filter(|l| *l > 0) {
        let day = now() / 86400;
        let retry_after = {
            let mut map = app.daily_pub.lock().unwrap();
            tally_daily(&mut map, &format!("t:{}", t.hash), day, limit, now())
        };
        if let Some(retry_after) = retry_after {
            app.metrics.limit_hit.fetch_add(1, Ordering::Relaxed);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", retry_after.to_string())],
                AxumJson(serde_json::json!({
                    "error": "daily relay limit reached",
                    "limit": limit,
                    "retry_after": retry_after,
                })),
            )
                .into_response();
        }
        app.persist_daily_quota();
    }
    let username = vault_relay::turn::username(now(), vault_relay::turn::CRED_TTL, &t.hash);
    let credential = vault_relay::turn::credential(&cfg.secret, &username);
    tracing::info!(plan = ?t.plan, "turn credentials issued");
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({
            "username": username,
            "credential": credential,
            "ttl": vault_relay::turn::CRED_TTL,
            "uris": vault_relay::turn::uris(&cfg.host),
        })),
    )
        .into_response()
}

/// GET /relay/plans — витрина покупаемых тарифов. Цену считает сервер
/// (payments::pro_catalog = та же таблица, что и касса чекаута), клиент ничего
/// о цене не решает — только показывает. Публичный, без fp.
async fn relay_plans() -> Response {
    AxumJson(serde_json::json!({
        "plans": vault_relay::payments::pro_catalog(),
    }))
    .into_response()
}

/// POST /relay/purchase/checkout — создать платёжную сессию.
async fn relay_purchase_checkout(
    State(app): State<Arc<AppState>>,
    Json(req): Json<CheckoutReq>,
) -> Response {
    // 402: платежи выключены (нет ИП/ключей) — честно, а не «одобрить».
    let Some(provider) = app.payment.clone() else {
        return err(StatusCode::PAYMENT_REQUIRED, "checkout disabled");
    };
    let Some(plan) = paid_plan(&req.plan) else {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "bad plan/months");
    };
    if !vault_relay::payments::PURCHASABLE_MONTHS.contains(&req.months) {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "bad plan/months");
    }
    let Some(fp) = norm_fp(Some(&req.fp)) else {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "bad plan/months");
    };
    // 409: у покупателя уже есть активная подписка — второй чекаут не нужен.
    if let Some(sub) = app.active_subscription(&fp) {
        return (
            StatusCode::CONFLICT,
            AxumJson(serde_json::json!({
                "error": "already_active",
                "paid_until": sub.paid_until,
            })),
        )
            .into_response();
    }
    // 429: не больше 5 чекаутов в час на fingerprint. Считаем ДО идемпотентности:
    // каждый клик «купить» — попытка, иначе тысяча одинаковых кликов прошла бы
    // без ограничения и нагружала платёжную систему.
    if !app.checkout_rate_ok(&fp) {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate limited");
    }
    // ИДЕМПОТЕНТНОСТЬ: тот же fp + план + срок → тот же checkout_id
    // (иначе повторный клик «купить» плодит платёжные сессии).
    if let Some(existing) = app.find_checkout(&fp, plan, req.months) {
        return (
            StatusCode::OK,
            AxumJson(serde_json::json!({
                "checkout_id": existing.id,
                "provider": existing.provider,
                "payment_url": existing.payment_url,
                "expires_in": existing.expires_in,
            })),
        )
            .into_response();
    }
    let cr = vault_relay::payments::CheckoutRequest {
        fp: fp.clone(),
        plan,
        months: req.months,
        lang: req.lang.unwrap_or_else(|| "ru".to_string()),
    };
    match provider.create_checkout(&cr).await {
        Ok(c) => {
            app.remember_checkout(c.clone());
            (
                StatusCode::OK,
                AxumJson(serde_json::json!({
                    "checkout_id": c.id,
                    "provider": c.provider,
                    "payment_url": c.payment_url,
                    "expires_in": c.expires_in,
                })),
            )
                .into_response()
        }
        Err(e) => payment_error_response(e),
    }
}

/// POST /relay/purchase/verify — подтвердить оплату и выпустить платный токен.
async fn relay_purchase_verify(
    State(app): State<Arc<AppState>>,
    Json(req): Json<VerifyReq>,
) -> Response {
    let Some(provider) = app.payment.clone() else {
        return err(StatusCode::PAYMENT_REQUIRED, "checkout disabled");
    };
    let Some(checkout) = app.get_checkout(&req.checkout_id) else {
        return err(StatusCode::GONE, "checkout expired");
    };
    // 409: fingerprint не совпадает — иначе оплаченный чекаут забрал бы чужой
    // аккаунт (а токен ушёл бы не тому, кто платил).
    if norm_fp(Some(&req.fp)).as_deref() != Some(checkout.fp.as_str()) {
        return err(StatusCode::CONFLICT, "fp_mismatch");
    }
    if checkout.expires_at < now() {
        return err(StatusCode::GONE, "checkout_expired");
    }
    match provider.verify(&checkout).await {
        Ok(vault_relay::payments::PaymentStatus::Paid) => {
            // Подписка — ПЕРСИСТ (persist.rs): купленный Pro не должен
            // теряться при рестарте релея. Токен — v2 (в нём план и срок).
            let sub = app.next_subscription_id();
            let paid_until = now() + (checkout.months as u64) * 30 * 86400;
            app.save_subscription(sub, checkout.plan, &checkout.fp, paid_until);
            let token = vault_relay::tokens::issue_v2(
                &app.keys,
                vault_relay::tokens::Scope::Read,
                checkout.plan,
                sub,
                paid_until as u32,
            );
            // Адрес очереди (topic) — тот же hash, что и у любого read-токена.
            let topic = vault_relay::parse(&app.keys, &token)
                .map(|t| t.hash)
                .unwrap_or_default();
            (
                StatusCode::OK,
                AxumJson(serde_json::json!({
                    "token": token,
                    "topic": topic,
                    "plan": format!("{:?}", checkout.plan).to_lowercase(),
                    "paid_until": paid_until,
                    "sub": sub,
                })),
            )
                .into_response()
        }
        Ok(vault_relay::payments::PaymentStatus::Pending) => {
            err(StatusCode::PAYMENT_REQUIRED, "not_paid_yet")
        }
        Ok(vault_relay::payments::PaymentStatus::Failed(why)) => err(
            StatusCode::PAYMENT_REQUIRED,
            &format!("payment rejected: {why}"),
        ),
        Err(e) => payment_error_response(e),
    }
}


/// Параметры страницы возврата: язык интерфейса платежа (`ru` по умолчанию).
#[derive(Debug, Deserialize)]
struct PayReturnQuery {
    #[serde(default)]
    lang: Option<String>,
}

#[derive(Clone, Copy)]
enum PayReturnKind {
    Ok,
    Expired,
    NotFound,
}

/// GET /pay-return/:id — страница возврата с платёжной страницы провайдера.
///
/// Ничего не подтверждает и НЕ выдаёт токен: оплату подтверждает только
/// `/relay/purchase/verify` у провайдера (клиент опрашивает его сам). Здесь —
/// человеческий ответ вместо 404 на `return_url` ЮKassa и подсказка вернуться
/// в приложение. Данные покупателя (fp) и id сессии на страницу не попадают.
async fn pay_return(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<PayReturnQuery>,
) -> Response {
    let lang = match q.lang.as_deref() {
        Some(l) if l.eq_ignore_ascii_case("en") => "en",
        Some(l) if l.eq_ignore_ascii_case("zh") => "zh",
        _ => "ru",
    };
    let (status, kind) = match app.get_checkout(&id) {
        None => (StatusCode::NOT_FOUND, PayReturnKind::NotFound),
        Some(c) if c.expires_at < now() => (StatusCode::GONE, PayReturnKind::Expired),
        Some(_) => (StatusCode::OK, PayReturnKind::Ok),
    };
    let mut resp = Html(pay_return_page(lang, kind)).into_response();
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"),
    );
    resp
}

/// Тексты страницы возврата: только статические строки, без подстановки данных
/// запроса (нечего экранировать и нечего утекать).
fn pay_return_page(lang: &str, kind: PayReturnKind) -> String {
    let (lang, title, heading, body, hint) = match (lang, kind) {
        ("en", PayReturnKind::Ok) => (
            "en",
            "Vault — payment check",
            "Checking your payment",
            "Return to the Vault app — your plan status will update once the payment is confirmed.",
            "If the app did not open, start it and go to Settings → Pro plan.",
        ),
        ("en", PayReturnKind::Expired) => (
            "en",
            "Vault — payment session expired",
            "Payment session expired",
            "Return to the app and start the purchase again.",
            "No money is charged for an unpaid session.",
        ),
        ("en", PayReturnKind::NotFound) => (
            "en",
            "Vault — link expired",
            "Link expired",
            "This payment session could not be found. Return to the app and start the purchase again.",
            "If you already paid, open Settings → Pro plan — the status will be fetched from the server.",
        ),
        ("zh", PayReturnKind::Ok) => (
            "zh",
            "Vault — 支付确认中",
            "正在确认支付",
            "请返回 Vault 应用——支付确认后，套餐状态会自动更新。",
            "如果应用没有自动打开，请手动启动并进入「设置 → Pro 套餐」。",
        ),
        ("zh", PayReturnKind::Expired) => (
            "zh",
            "Vault — 支付会话已过期",
            "支付会话已过期",
            "请返回应用并重新发起购买。",
            "未支付的会话不会扣款。",
        ),
        ("zh", PayReturnKind::NotFound) => (
            "zh",
            "Vault — 链接已失效",
            "链接已失效",
            "找不到此支付会话。请返回应用并重新发起购买。",
            "如果已经付款，请打开「设置 → Pro 套餐」——状态会从服务器获取。",
        ),
        (_, PayReturnKind::Ok) => (
            "ru",
            "Vault — проверка оплаты",
            "Проверяем оплату",
            "Вернитесь в приложение Vault — статус тарифа обновится после подтверждения платежа.",
            "Если приложение не открылось, запустите его и откройте «Настройки → Тариф Pro».",
        ),
        (_, PayReturnKind::Expired) => (
            "ru",
            "Vault — сессия оплаты истекла",
            "Сессия оплаты истекла",
            "Вернитесь в приложение и начните покупку заново.",
            "Деньги за неоплаченную сессию не списываются.",
        ),
        (_, PayReturnKind::NotFound) => (
            "ru",
            "Vault — ссылка устарела",
            "Ссылка устарела",
            "Не удалось найти эту платёжную сессию. Вернитесь в приложение и начните покупку заново.",
            "Если оплата уже прошла, откройте «Настройки → Тариф Pro» — статус подтянется с сервера.",
        ),
    };
    PAY_RETURN_TEMPLATE
        .replace("__LANG__", lang)
        .replace("__TITLE__", title)
        .replace("__HEADING__", heading)
        .replace("__BODY__", body)
        .replace("__HINT__", hint)
}

const PAY_RETURN_TEMPLATE: &str = r#"<!doctype html>
<html lang="__LANG__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>__TITLE__</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0f1115; color: #f4f6fb; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  p { line-height: 1.5; margin: 0 0 .75rem; color: #c9d0de; }
  .hint { font-size: .9rem; color: #8d97aa; }
</style>
</head>
<body>
<main>
  <h1>__HEADING__</h1>
  <p>__BODY__</p>
  <p class="hint">__HINT__</p>
</main>
</body>
</html>
"#;


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
    // Секрет админ-роутов выдачи/отзыва тестовых кодов. Пусто = роутов нет.
    let admin_key = std::env::var("VAULT_RELAY_ADMIN_KEY").ok()
        .filter(|s| !s.trim().is_empty());
    // §0 company.md: бесплатный суточный лимит конвертов на издателя
    // (по умолчанию 100; 0 = выключен; Premium-токены без лимита).
    let free_daily_limit =
        daily_limit_from_env(std::env::var("VAULT_RELAY_FREE_DAILY_LIMIT").ok().as_deref());
    if !ntfy_url.is_empty() {
        tracing::info!("ntfy wake-up bridge: {ntfy_url}");
    }
    // FCM Part B: VAULT_FCM_KEY пуст/файл битый → fcm=None, сервер живёт
    // на ntfy-мосте (поведение до FCM). Ошибка уже залогирована в from_env.
    let fcm = FcmSender::from_env().map(Arc::new);
    // Персист привязок FCM/рингтонов (t_44e210b4): без него рестарт релея
    // обнулял topic_fcm, клиент не перерегистрировался, а ntfy-моста на проде
    // нет → wake-канал мёртв. Путь — VAULT_RELAY_STATE (off = выключить).
    let state_path = persist::state_path_from_env();
    match &state_path {
        Some(p) => tracing::info!("state file: {}", p.display()),
        None => tracing::warn!(
            "{} set to off — FCM bindings and ringtones will NOT survive a restart",
            persist::ENV_STATE_PATH
        ),
    }
    // Платёжный провайдер. VAULT_RELAY_PAYMENTS=test — тестовый (оплата
    // подтверждается мгновенно, для выдачи Pro-токенов без реальной оплаты).
    // yookassa — живой ЮKassa: собирается ТОЛЬКО с ключами
    // VAULT_RELAY_YOOKASSA_SHOPID/_SECRET_KEY и VAULT_RELAY_PUBLIC_URL;
    // без них — заглушка «недоступно» и warn, а не полуживой магазин.
    // Иное непустое значение — провайдер-заглушка «недоступно» (честный отказ,
    // а не выдуманный успех). Пусто — платежи выключены: все платёжные роуты
    // отвечают 402.
    let payment: Option<Arc<dyn vault_relay::payments::PaymentProvider>> =
        match std::env::var("VAULT_RELAY_PAYMENTS")
            .ok()
            .as_deref()
            .map(str::trim)
        {
            Some("test") | Some("1") | Some("true") => {
                Some(Arc::new(vault_relay::payments::TestProvider::new()) as Arc<dyn vault_relay::payments::PaymentProvider>)
            }
            Some("yookassa") => match vault_relay::payments::YkProvider::from_env() {
                Ok(p) => Some(Arc::new(p) as Arc<dyn vault_relay::payments::PaymentProvider>),
                Err(why) => {
                    tracing::warn!("payments=yookassa but provider not configured: {why}");
                    Some(Arc::new(
                        vault_relay::payments::UnavailableProvider::new("yookassa"),
                    ) as Arc<dyn vault_relay::payments::PaymentProvider>)
                }
            },
            Some(name) if !name.is_empty() => Some(Arc::new(
                vault_relay::payments::UnavailableProvider::new(name),
            ) as Arc<dyn vault_relay::payments::PaymentProvider>),
            _ => None,
        };
    let payments_on = payment.is_some();
    let state = Arc::new(AppState::new(
        Store::new(),
        ServerKeys::new(server_key),
        allow_anonymous_pub,
        ntfy_url,
        unlimited_key,
        admin_key,
        free_daily_limit,
        fcm,
        state_path,
        payment,
    ));
    tracing::info!(
        "vault-relay listening on {addr}, anon_pub={allow_anonymous_pub}, free_daily_limit={free_daily_limit}, payments={payments_on}"
    );

    let app = Router::new()
        .route("/relay/pub", post(relay_pub))
        // Платёжные роуты (шаг 4 плана платных токенов).
        .route("/relay/plans", get(relay_plans))
        .route("/relay/purchase/checkout", post(relay_purchase_checkout))
        .route("/relay/purchase/verify", post(relay_purchase_verify))
        // return_url провайдера (ЮKassa): человеку — страница, не 404.
        .route("/pay-return/:id", get(pay_return))
        .route("/relay/tokens/activate", post(relay_tokens_activate))
        .route("/relay/tokens/info", get(relay_tokens_info))
        // TURN REST: временные креды для звонков вне одной подсети.
        .route("/relay/turn", get(relay_turn))
        .route("/relay/poll", get(relay_poll))
        .route("/relay/ws", get(relay_ws))
        .route("/metrics", get(metrics))
        .route("/health", get(health))
        // alias: клиентские baseUrl заканчиваются на /relay → зовут /relay/health
        .route("/relay/health", get(health))
        .route("/relay/register", post(relay_register))
        .route("/relay/channel-key", post(relay_channel_key))
        .route("/relay/ringtone", post(relay_get_ringtone))
        // FCM Part B: привязка reg_token получателя к его теме.
        .route("/relay/fcm/register", post(relay_fcm_register))
        .route("/relay/metrics", get(metrics))
        // Админ: персональные тест-коды и отзыв токенов (VAULT_RELAY_ADMIN_KEY).
        .route("/admin/test-code", post(admin_test_code_create))
        .route("/admin/test-codes", get(admin_test_codes_list))
        .route("/admin/revoke", post(admin_revoke))
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
    use vault_relay::tokens::{issue, issue_install, issue_test, issue_v2, parse, Plan};

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
    /// сеть не трогаем никогда. Персист выключен (state_path=None):
    /// юниты не должны писать файлы в WorkingDirectory.
    fn app_state(k: ServerKeys) -> Arc<AppState> {
        Arc::new(AppState::new(
            Store::new(),
            k,
            true,
            String::new(),
            None,
            None,
            0,
            None,
            None,
            None,
        ))
    }

    /// AppState с платёжным провайдером (тестовым) — для роутов покупки.
    fn pay_app_state(k: ServerKeys, provider: Option<Arc<dyn vault_relay::payments::PaymentProvider>>) -> Arc<AppState> {
        Arc::new(AppState::new(
            Store::new(),
            k,
            true,
            String::new(),
            None,
            None,
            0,
            None,
            None,
            provider,
        ))
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
            sig: None,
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
        let app = AppState::new(
            Store::new(),
            keys(),
            true,
            String::new(),
            None,
            None,
            0,
            None,
            None,
            None,
        );
        assert!(app.topic_ringtone.lock().unwrap().is_empty());
        let (_token, hash) = fresh_topic(&app.keys, 4_102_444_800);
        assert_eq!(ringtone_or_default(&app.topic_ringtone, &hash), DEFAULT_RING_URL);
        let ring = "https://vault-msg.ru/sounds/ring_incoming_classic.mp3";
        assert_eq!(ringtone_resolve(&app.topic_ringtone, &hash, Some(ring)).as_deref(), Some(ring));
        assert_eq!(ringtone_or_default(&app.topic_ringtone, &hash), ring);
    }

    /// t_44e210b4: привязка FCM и рингтон ПЕРЕЖИВАЮТ рестарт релея.
    /// Сценарий бага: рестарт → topic_fcm пуст → клиент не перерегистрируется
    /// (кэш в prefs) → при незаданном VAULT_RELAY_NTFY_URL будить нечем.
    /// Здесь: подняли AppState на пустом файле, «зарегистрировали» клиента,
    /// пересоздали AppState из того же файла (имитация рестарта) и проверяем,
    /// что и reg_token, и рингтон на месте.
    #[test]
    fn fcm_binding_survives_relay_restart() {
        let dir = std::env::temp_dir().join(format!(
            "vault-relay-restart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let path = dir.join("state.json");

        // «Процесс 1»: поднимаемся на пустом state.json, клиент регистрируется.
        let app1 = AppState::new(
            Store::new(),
            keys(),
            true,
            String::new(),
            None,
            None,
            0,
            None,
            Some(path.clone()),
            None,
        );
        let (_tok, hash) = fresh_topic(&app1.keys, 4_102_444_800);
        assert!(app1.topic_fcm.lock().unwrap().is_empty());
        app1.topic_fcm
            .lock()
            .unwrap()
            .insert(hash.clone(), "reg-token-live-1".to_string());
        ringtone_resolve(
            &app1.topic_ringtone,
            &hash,
            Some("https://vault-msg.ru/sounds/ring_incoming_pulse.mp3"),
        );
        app1.persist();
        assert!(path.exists(), "persist must write the state file");
        drop(app1);

        // «Рестарт релея»: новый процесс читает тот же файл.
        let app2 = AppState::new(
            Store::new(),
            keys(),
            true,
            String::new(),
            None,
            None,
            0,
            None,
            Some(path.clone()),
            None,
        );
        assert_eq!(
            app2.topic_fcm.lock().unwrap().get(&hash).map(String::as_str),
            Some("reg-token-live-1"),
            "FCM binding must survive restart — otherwise the wake channel is dead"
        );
        assert_eq!(
            ringtone_or_default(&app2.topic_ringtone, &hash),
            "https://vault-msg.ru/sounds/ring_incoming_pulse.mp3",
            "custom ringtone must survive restart"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Персист выключен (VAULT_RELAY_STATE=off) → persist() no-op, файл не
    /// создаётся: поведение как до t_44e210b4, ничего не ломается.
    #[test]
    fn persist_is_noop_when_state_path_disabled() {
        let app = app_state(keys());
        app.topic_fcm
            .lock()
            .unwrap()
            .insert("deadbeef".repeat(8), "reg".to_string());
        app.persist(); // не должно падать
        assert_eq!(app.topic_fcm.lock().unwrap().len(), 1);
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

    // ───────── /relay/register: СТАБИЛЬНОСТЬ адреса очереди ─────────
    // Инцидент 12.10.2026: клиент терял свой токен (миграция kv), честно
    // перерегистрировался — и /register выдавал НОВЫЙ токен. Собеседники,
    // знающие старый адрес, молча теряли канал (вызов не доходил).
    // Проверяем хендлер целиком: повторная регистрация обязана вернуть
    // тот же токен, вид токена явный, апгрейд на тестовый — осознанный.

    fn sock() -> ConnectInfo<std::net::SocketAddr> {
        ConnectInfo("127.0.0.1:5555".parse().expect("addr"))
    }

    fn app_state_with_key(k: ServerKeys, unlimited: Option<&str>) -> Arc<AppState> {
        Arc::new(AppState::new(
            Store::new(),
            k,
            true,
            String::new(),
            unlimited.map(str::to_string),
            None,
            0,
            None,
            None,
            None,
        ))
    }

    /// Роут с админ-секретом и (опционально) общим промо-ключом.
    fn admin_state(
        k: ServerKeys,
        admin: Option<&str>,
        unlimited: Option<&str>,
    ) -> Arc<AppState> {
        Arc::new(AppState::new(
            Store::new(),
            k,
            true,
            String::new(),
            unlimited.map(str::to_string),
            admin.map(str::to_string),
            0,
            None,
            None,
            None,
        ))
    }

    fn admin_headers(key: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-admin-key", key.parse().expect("hdr"));
        h
    }

    async fn resp_json(resp: Response) -> (StatusCode, serde_json::Value) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    async fn admin_create(
        app: &Arc<AppState>,
        key: &str,
        req: TestCodeReq,
    ) -> (StatusCode, serde_json::Value) {
        resp_json(
            admin_test_code_create(State(app.clone()), admin_headers(key), Json(req)).await,
        )
        .await
    }

    async fn admin_list(app: &Arc<AppState>, key: &str) -> (StatusCode, serde_json::Value) {
        resp_json(admin_test_codes_list(State(app.clone()), admin_headers(key)).await).await
    }

    async fn revoke_req(
        app: &Arc<AppState>,
        key: &str,
        req: RevokeReq,
    ) -> (StatusCode, serde_json::Value) {
        resp_json(
            admin_revoke(State(app.clone()), admin_headers(key), Json(req)).await,
        )
        .await
    }

    async fn reg(
        app: &Arc<AppState>,
        fp: Option<&str>,
        promo: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        reg_full(app, fp, promo, None).await
    }
    async fn reg_full(
        app: &Arc<AppState>,
        fp: Option<&str>,
        promo: Option<&str>,
        keep: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let resp = relay_register(
            State(app.clone()),
            sock(),
            Json(RegisterReq {
                promo: promo.map(str::to_string),
                fp: fp.map(str::to_string),
                ringtone: None,
                keep: keep.map(str::to_string),
            }),
        )
        .await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        let v: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        (status, v)
    }

    #[tokio::test]
    async fn register_reuses_same_token_for_same_fp() {
        let app = app_state_with_key(keys(), None);
        let (s1, j1) = reg(&app, Some("c7:3c:e5:5a:9f:7b:46:6f"), None).await;
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(j1["kind"], "install");
        assert_eq!(j1["unlimited"], false);
        // Главное: ВТОРАЯ регистрация того же fp возвращает ТОТ ЖЕ токен.
        let (s2, j2) = reg(&app, Some("c7:3c:e5:5a:9f:7b:46:6f"), None).await;
        assert_eq!(s2, StatusCode::OK);
        assert_eq!(j1["token"], j2["token"], "адрес очереди обязан быть стабильным");
        assert_eq!(j1["topic"], j2["topic"]);
        // Метрики: одна выдача (register_ok) + одно переиспользование.
        assert_eq!(app.metrics.register_ok.load(Ordering::Relaxed), 1);
        assert_eq!(app.metrics.register_reuse.load(Ordering::Relaxed), 1);
        // Идемпотентность не зависит от регистра fp.
        let (_s3, j3) = reg(&app, Some("C7:3C:E5:5A:9F:7B:46:6F"), None).await;
        assert_eq!(j1["token"], j3["token"]);
    }

    #[tokio::test]
    async fn register_different_fp_gets_different_token() {
        let app = app_state_with_key(keys(), None);
        let (_s1, j1) = reg(&app, Some("aa:bb"), None).await;
        let (_s2, j2) = reg(&app, Some("cc:dd"), None).await;
        assert_ne!(j1["token"], j2["token"]);
    }

    #[tokio::test]
    async fn register_promo_is_explicit_upgrade_then_stable() {
        let app = app_state_with_key(keys(), Some("SECRET-PROMO"));
        // Установочный токен.
        let (_s0, j0) = reg(&app, Some("aa:bb"), None).await;
        assert_eq!(j0["kind"], "install");
        // Пользователь ввёл промо-ключ — это ОСОЗНАННАЯ смена вида токена.
        let (_s1, j1) = reg(&app, Some("aa:bb"), Some("SECRET-PROMO")).await;
        assert_eq!(j1["kind"], "test");
        assert_eq!(j1["unlimited"], true);
        assert_ne!(j0["token"], j1["token"], "апгрейд меняет вид токена");
        // Повторный ввод того же ключа больше токен НЕ меняет.
        let (_s2, j2) = reg(&app, Some("aa:bb"), Some("SECRET-PROMO")).await;
        assert_eq!(j1["token"], j2["token"], "повторный промо — идемпотентен");
        // Неверный промо-ключ = обычная выдача, тестовый вид не даёт.
        let (_s3, j3) = reg(&app, Some("ee:ff"), Some("WRONG")).await;
        assert_eq!(j3["kind"], "install");
        assert_eq!(j3["unlimited"], false);
    }

    // ── Персональные тест-коды: 6 месяцев, привязка к fp, отзыв ──────────

    #[tokio::test]
    async fn tester_codes_do_not_spend_ip_quota() {
        // Приглашённый приходит по нашей воле: четвёртая выдача с того же IP
        // не должна упираться в «3 в сутки», даже если коды разные.
        let app = admin_state(keys(), Some("ADMIN"), None);
        for i in 0..4 {
            let (_, j) = admin_create(
                &app,
                "ADMIN",
                TestCodeReq {
                    label: format!("t{i}"),
                    days: None,
                },
            )
            .await;
            let code = j["code"].as_str().expect("code").to_string();
            let fp = format!("aa:bb:cc:0{i}");
            let (s, r) = reg(&app, Some(&fp), Some(&code)).await;
            assert_eq!(s, StatusCode::OK, "выдача {i} не должна упираться в квоту IP");
            assert_eq!(r["kind"], "test");
        }
    }

    #[tokio::test]
    async fn admin_routes_need_key() {
        // Секрет не задан — роутов как будто нет, даже с любым ключом.
        let app = admin_state(keys(), None, None);
        let (s, _) = admin_create(
            &app,
            "x",
            TestCodeReq {
                label: String::new(),
                days: None,
            },
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        // Секрет задан: чужой ключ тоже 404 — существование роута не подтверждаем.
        let app = admin_state(keys(), Some("ADMIN"), None);
        let (s, _) = admin_create(
            &app,
            "wrong",
            TestCodeReq {
                label: String::new(),
                days: None,
            },
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert_eq!(admin_list(&app, "wrong").await.0, StatusCode::NOT_FOUND);
        let (s, j) = admin_create(
            &app,
            "ADMIN",
            TestCodeReq {
                label: "тестер-1".into(),
                days: None,
            },
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(j["days"], 180, "по умолчанию полгода");
        assert!(j["code"].as_str().unwrap().starts_with("vt1-"));
    }

    #[tokio::test]
    async fn tester_code_grants_six_month_unlimited_token() {
        let app = admin_state(keys(), Some("ADMIN"), None);
        let (_, j) = admin_create(
            &app,
            "ADMIN",
            TestCodeReq {
                label: "anna".into(),
                days: None,
            },
        )
        .await;
        let code = j["code"].as_str().expect("code").to_string();
        let (s, r) = reg(&app, Some("aa:bb:cc:dd"), Some(&code)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(r["kind"], "test");
        assert_eq!(r["unlimited"], true);
        let exp = r["exp"].as_u64().expect("exp") as i64;
        let now = now() as i64;
        assert!(
            exp >= now + 179 * 86400 && exp <= now + 181 * 86400,
            "срок ~6 месяцев, получили {exp}"
        );
    }

    #[tokio::test]
    async fn tester_code_sticks_to_first_fp() {
        let app = admin_state(keys(), Some("ADMIN"), None);
        let (_, j) = admin_create(
            &app,
            "ADMIN",
            TestCodeReq {
                label: "anna".into(),
                days: Some(30),
            },
        )
        .await;
        assert_eq!(j["days"], 30, "явный срок уважается");
        let code = j["code"].as_str().expect("code").to_string();
        let (s1, r1) = reg(&app, Some("aa:bb"), Some(&code)).await;
        assert_eq!(s1, StatusCode::OK);
        // Тот же аккаунт (регистр fp не важен) — тот же токен.
        let (s2, r2) = reg(&app, Some("AA:BB"), Some(&code)).await;
        assert_eq!(s2, StatusCode::OK);
        assert_eq!(r1["token"], r2["token"]);
        // Другой аккаунт код не получает: он личный.
        let (s3, j3) = reg(&app, Some("ee:ff"), Some(&code)).await;
        assert_eq!(s3, StatusCode::CONFLICT);
        assert_eq!(j3["error"], "tester code bound to another account");
        // Код без fp нечем привязать — безлимит «в воздух» не выдаём.
        let (_, j) = admin_create(
            &app,
            "ADMIN",
            TestCodeReq {
                label: "bob".into(),
                days: None,
            },
        )
        .await;
        let code2 = j["code"].as_str().expect("code").to_string();
        let (s4, _) = reg(&app, None, Some(&code2)).await;
        assert_eq!(s4, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn revoked_code_stops_grants_and_issued_token() {
        let app = admin_state(keys(), Some("ADMIN"), None);
        let (_, j) = admin_create(
            &app,
            "ADMIN",
            TestCodeReq {
                label: "anna".into(),
                days: None,
            },
        )
        .await;
        let code = j["code"].as_str().expect("code").to_string();
        let (s, r) = reg(&app, Some("aa:bb"), Some(&code)).await;
        assert_eq!(s, StatusCode::OK);
        let token = r["token"].as_str().expect("token").to_string();
        let (s, j) = revoke_req(
            &app,
            "ADMIN",
            RevokeReq {
                code: Some(code.clone()),
                fp: None,
            },
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(j["revoked"], 1, "выданный по коду токен ушёл в денлист");
        // Выданный токен больше не принимается.
        let (s, _) =
            resp_json(relay_tokens_info(State(app.clone()), auth_headers(&token)).await).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // И код не выдаёт безлимит другому аккаунту.
        let (s, _) = reg(&app, Some("cc:dd"), Some(&code)).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // Список видит отзыв, но открытого значения кода в нём нет.
        let (_, l) = admin_list(&app, "ADMIN").await;
        assert_eq!(l["count"], 1);
        assert_eq!(l["codes"][0]["revoked"], true);
        assert_eq!(l["codes"][0]["used"], true);
        assert!(l["codes"][0].get("code").is_none());
    }

    #[tokio::test]
    async fn revoke_by_fp_kills_token_and_its_code() {
        let app = admin_state(keys(), Some("ADMIN"), None);
        let (_, j) = admin_create(
            &app,
            "ADMIN",
            TestCodeReq {
                label: "anna".into(),
                days: None,
            },
        )
        .await;
        let code = j["code"].as_str().expect("code").to_string();
        let (s, r) = reg(&app, Some("aa:bb"), Some(&code)).await;
        assert_eq!(s, StatusCode::OK);
        let token = r["token"].as_str().expect("token").to_string();
        let (s, j) = revoke_req(
            &app,
            "ADMIN",
            RevokeReq {
                code: None,
                fp: Some("aa:bb".into()),
            },
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(j["revoked"], 1);
        let (s, _) =
            resp_json(relay_tokens_info(State(app.clone()), auth_headers(&token)).await).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // Код помечен отозванным: повторный ввод безлимит не вернёт.
        let (s, _) = reg(&app, Some("aa:bb"), Some(&code)).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        // Без кода аккаунт живёт обычным установочным токеном.
        let (s, j) = reg(&app, Some("aa:bb"), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(j["kind"], "install");
        // Нечего отзывать — 404, а не «успешно отозвали 0».
        let (s, _) = revoke_req(
            &app,
            "ADMIN",
            RevokeReq {
                code: None,
                fp: Some("99:99".into()),
            },
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn register_without_fp_is_legacy_and_rate_limited() {
        // Легаси-клиент (без fp) не может быть идемпотентным: прежнее
        // поведение — новый токен на запрос, 3 новые выдачи в сутки на IP.
        let app = app_state_with_key(keys(), None);
        let (_s1, j1) = reg(&app, None, None).await;
        let (_s2, j2) = reg(&app, None, None).await;
        assert_ne!(j1["token"], j2["token"]);
        let (_s3, _j3) = reg(&app, None, None).await;
        let (s4, _j4) = reg(&app, None, None).await;
        assert_eq!(s4, StatusCode::TOO_MANY_REQUESTS);
    }

    // ── t_b8f44bdf: заявка текущего токена (`keep`) ──────────────────────

    #[tokio::test]
    async fn register_keep_records_existing_token_for_fp() {
        // Устройство с УЖЕ выданным токеном (получен до появления карты fp)
        // заявляет его: сервер записывает связку fp → токен, нового токена не
        // выдаёт и адрес очереди не меняет.
        let app = app_state_with_key(keys(), None);
        let tok = issue_install(&app.keys, now() as u32);
        let (s, j) = reg_full(&app, Some("aa:bb:cc:dd:ee:ff"), None, Some(&tok)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(j["token"], tok, "заявленный токен остаётся адресом очереди");
        assert_eq!(j["kind"], "install");
        assert_eq!(j["unlimited"], false);
        assert_eq!(app.metrics.register_keep.load(Ordering::Relaxed), 1);
        assert_eq!(
            app.metrics.register_ok.load(Ordering::Relaxed),
            0,
            "заявка — не новая выдача"
        );
        // Запись живая: следующая регистрация того же fp отдаёт тот же токен.
        let (_s2, j2) = reg(&app, Some("aa:bb:cc:dd:ee:ff"), None).await;
        assert_eq!(j2["token"], tok);
        assert_eq!(app.metrics.register_reuse.load(Ordering::Relaxed), 1);
    }

    /// РЕГРЕСС (найдено приёмкой 22.10.2026): покупка Pro отменялась САМА
    /// СОБОЙ. Платный токен выдаёт отдельная операция (/relay/purchase/verify)
    /// и в карту fp→токен не попадает — там остаётся бесплатный токен прошлой
    /// регистрации. Следующая регистрация (а она идёт при каждом входе)
    /// отдавала бесплатную запись, и купленный Pro исчезал через минуту.
    ///
    /// Теперь платный `keep` (проверенный: разбирается, read-область, не
    /// протух, привязан к этому же fp) важнее бесплатной записи, и запись
    /// переводится на платный токен.
    #[tokio::test]
    async fn register_keeps_paid_token_over_free_record() {
        let app = app_state_with_key(keys(), None);
        let fp = "aa:bb:cc:dd:ee:ff";
        // Первая регистрация: бесплатный установочный токен, он же в записи fp.
        let (_s, j_free) = reg(&app, Some(fp), None).await;
        let free_tok = j_free["token"].as_str().expect("token").to_string();
        assert_eq!(j_free["kind"], "install");

        // Покупка: платный v2-токен и активация на этом же fingerprint.
        let paid = vault_relay::tokens::issue_v2(
            &app.keys,
            Scope::Read,
            vault_relay::tokens::Plan::Pro,
            42,
            (now() + 30 * 86400) as u32,
        );
        let act = relay_tokens_activate(
            State(app.clone()),
            Json(ActivateReq {
                token: paid.clone(),
                fp: fp.to_string(),
            }),
        )
        .await;
        assert_eq!(act.status(), StatusCode::OK, "активация платного токена");

        // Регистрация с keep (платный токен) — обязана вернуть ПЛАТНЫЙ.
        let (s, j) = reg_full(&app, Some(fp), None, Some(&paid)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(j["token"], paid, "платный токен обязан пережить регистрацию");
        assert_ne!(j["token"], free_tok, "бесплатный токен не должен вытеснять платный");
        assert_eq!(
            j["unlimited"], false,
            "платный тариф — квота (Pro 1000/сут), а не безлимит"
        );

        // Запись fp переведена на платный токен: даже регистрация БЕЗ keep
        // вернёт именно его (иначе покупка снова отменилась бы).
        let (_s2, j2) = reg(&app, Some(fp), None).await;
        assert_eq!(j2["token"], paid, "запись fp переведена на платный токен");
    }

    /// Обратная сторона: БЕСПЛАТНЫЙ keep не должен вытеснить платный токен,
    /// который уже записан за этим fp. Иначе любой, кто предъявит
    /// бесплатный токен, обнулил бы подписку.
    /// АВТОВОССТАНОВЛЕНИЕ ПОСЛЕ ПОТЕРИ ТОКЕНА.
    ///
    /// Сценарий, найденный на живой приёмке: клиент купил Pro, активировал
    /// токен — и потерял его (переустановка, очистка данных). Раньше карта
    /// fp→токен продолжала лежать с БЕСПЛАТНЫМ токеном, обычная регистрация
    /// выдавала его, и платная подписка пропадала навсегда (восстановиться
    /// было нечем — «у вас уже есть активная подписка», а токена нет).
    ///
    /// Теперь активация закрепляет платный токен за fp, и регистрация без
    /// `keep` возвращает именно его.
    #[tokio::test]
    async fn activate_registers_paid_token_for_fp_so_registration_recovers_it() {
        let app = app_state_with_key(keys(), None);
        let fp = "aa:bb:cc:dd:ee:ff";
        // Первая регистрация: бесплатный установочный токен, он же в записи fp.
        let (_s, j_free) = reg(&app, Some(fp), None).await;
        let free_tok = j_free["token"].as_str().expect("token").to_string();

        // Покупка: платный токен + активация на этом же fingerprint.
        let paid = vault_relay::tokens::issue_v2(
            &app.keys,
            Scope::Read,
            vault_relay::tokens::Plan::Pro,
            42,
            (now() + 30 * 86400) as u32,
        );
        let act = relay_tokens_activate(
            State(app.clone()),
            Json(ActivateReq {
                token: paid.clone(),
                fp: fp.to_string(),
            }),
        )
        .await;
        assert_eq!(act.status(), StatusCode::OK, "активация платного токена");

        // Клиент потерял данные и регистрируется заново — БЕЗ keep.
        let (_s2, j2) = reg(&app, Some(fp), None).await;
        assert_eq!(
            j2["token"], paid,
            "регистрация обязана вернуть платный токен, иначе покупка пропала"
        );
        assert_ne!(j2["token"], free_tok);
        assert_eq!(j2["unlimited"], false, "покупка даёт квоту, а не безлимит");

        // И бесплатный keep не понижает вид записи: платный остаётся.
        let (_s3, j3) = reg_full(&app, Some(fp), None, Some(&free_tok)).await;
        assert_eq!(j3["token"], paid, "бесплатный keep не должен понижать запись");
    }

    #[tokio::test]
    async fn register_free_keep_does_not_replace_paid_record() {
        let app = app_state_with_key(keys(), None);
        let fp = "11:22:33:44:55:66";
        let (_s, j_free) = reg(&app, Some(fp), None).await;
        let free_tok = j_free["token"].as_str().expect("token").to_string();

        let paid = vault_relay::tokens::issue_v2(
            &app.keys,
            Scope::Read,
            vault_relay::tokens::Plan::Pro,
            7,
            (now() + 30 * 86400) as u32,
        );
        let act = relay_tokens_activate(
            State(app.clone()),
            Json(ActivateReq {
                token: paid.clone(),
                fp: fp.to_string(),
            }),
        )
        .await;
        assert_eq!(act.status(), StatusCode::OK);

        // Запись переведена на платный токен предыдущей регистрацией с keep.
        let (_s1, j1) = reg_full(&app, Some(fp), None, Some(&paid)).await;
        assert_eq!(j1["token"], paid);

        // Теперь клиент предъявляет бесплатный keep — запись не меняется.
        let (_s2, j2) = reg_full(&app, Some(fp), None, Some(&free_tok)).await;
        assert_eq!(
            j2["token"], paid,
            "бесплатный keep не должен вытеснить платный токен"
        );
    }

    #[tokio::test]
    async fn register_keep_preserves_token_kind() {
        // Заявка не понижает вид: тестовый (промо) токен остаётся тестовым.
        let app = app_state_with_key(keys(), None);
        let tok = issue_test(&app.keys, now() as u32);
        let (_s, j) = reg_full(&app, Some("fp-t"), None, Some(&tok)).await;
        assert_eq!(j["token"], tok);
        assert_eq!(j["kind"], "test");
        assert_eq!(j["unlimited"], true);
    }

    #[tokio::test]
    async fn register_keep_rejects_token_bound_to_another_fp() {
        let app = app_state_with_key(keys(), None);
        // Токен принадлежит аккаунту A (привязка создана при выдаче).
        let (_s1, ja) = reg(&app, Some("fp-a"), None).await;
        let tok_a = ja["token"].as_str().expect("token").to_string();
        // Аккаунт B пытается заявить чужой токен: не присваиваем его.
        let (s2, jb) = reg_full(&app, Some("fp-b"), None, Some(&tok_a)).await;
        assert_eq!(s2, StatusCode::OK);
        assert_ne!(jb["token"], tok_a, "чужой токен не присваивается");
        assert_eq!(app.metrics.register_keep.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn register_keep_rejects_expired_token() {
        // Протухший токен заявлять бессмысленно: он уже не адрес очереди.
        // issue_install(keys, 0) = срок «1970 + 10 лет» (заведомо в прошлом).
        let app = app_state_with_key(keys(), None);
        let dead = issue_install(&app.keys, 0);
        let (_s, j) = reg_full(&app, Some("fp-y"), None, Some(&dead)).await;
        assert_ne!(j["token"], dead);
        assert_eq!(app.metrics.register_keep.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn register_keep_does_not_consume_ip_quota() {
        // 4 заявки с 4 разных fp: квота (3 новых выдачи в сутки на IP)
        // тратится только на НОВУЮ выдачу, иначе 4-я получила бы 429.
        let app = app_state_with_key(keys(), None);
        for i in 0..4 {
            let tok = issue_install(&app.keys, now() as u32);
            let fp = format!("fp-keep-{}", i);
            let (s, j) = reg_full(&app, Some(&fp), None, Some(&tok)).await;
            assert_eq!(s, StatusCode::OK, "заявка №{} израсходовала квоту", i + 1);
            assert_eq!(j["token"], tok);
        }
        assert_eq!(app.metrics.register_keep.load(Ordering::Relaxed), 4);
    }

    #[tokio::test]
    async fn register_keep_ignored_when_disabled() {
        // Kill-switch VAULT_RELAY_KEEP_CLAIM=0: заявка не принимается,
        // поведение как до фичи — обычная выдача нового токена.
        let app = app_state_with_key(keys(), None);
        app.keep_claim.store(false, Ordering::Relaxed);
        let tok = issue_install(&app.keys, now() as u32);
        let (_s, j) = reg_full(&app, Some("fp-x"), None, Some(&tok)).await;
        assert_ne!(j["token"], tok, "при выключенном keep выдаётся новый токен");
        assert_eq!(app.metrics.register_keep.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn register_reuse_does_not_consume_ip_quota() {
        // Переиспользование своего токена не должно упираться в 3/сутки:
        // иначе клиент с потерянной записью не сможет восстановить адрес.
        let app = app_state_with_key(keys(), None);
        for _ in 0..10 {
            let (s, _j) = reg(&app, Some("aa:bb"), None).await;
            assert_eq!(s, StatusCode::OK);
        }
    }

    // ── Publish: креды отправителя обязательны (анонимность выключена) ──
    //
    // Политика: адресация — read-токен получателя (`to`), но отправитель
    // обязан предъявить свои креды: заголовок Authorization ЛИБО свой
    // read-токен в теле (`tok`, шлёт клиент с M2.4). «Чистая анонимность»
    // допустима только при VAULT_RELAY_ANON_PUB=1 (совместимость).

    fn app_state_no_anon(k: ServerKeys) -> Arc<AppState> {
        Arc::new(AppState::new(
            Store::new(),
            k,
            false, // VAULT_RELAY_ANON_PUB=0
            String::new(),
            None,
            None,
            0,
            None,
            None,
            None,
        ))
    }

    fn pub_req(to: &str, tok: Option<&str>) -> PubRequest {
        // id уникален на вызов: сервер дедуплицирует по id, а тестам нужно
        // различать публикации (иначе вторая — no-op в очереди).
        static N: AtomicU64 = AtomicU64::new(0);
        PubRequest {
            v: 1,
            to: to.into(),
            id: format!("env-anti-anon-{}", N.fetch_add(1, Ordering::Relaxed)),
            exp: now() + 600,
            body: "aGVsbG8=".into(),
            tok: tok.map(str::to_string),
            sig: None,
            from: Some("anna@example.com".into()),
            fp: None,
            wake: false,
            urgent: None,
        }
    }

    fn with_fp(mut r: PubRequest, fp: &str) -> PubRequest {
        r.fp = Some(fp.to_string());
        r
    }

    async fn pub_status(app: &Arc<AppState>, req: PubRequest) -> StatusCode {
        relay_pub(
            State(app.clone()),
            ConnectInfo("127.0.0.1:1234".parse().expect("addr")),
            HeaderMap::new(),
            AxumJson(req),
        )
        .await
        .status()
    }

    #[tokio::test]
    async fn pub_without_credentials_rejected_when_anon_disabled() {
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_901);
        let app = app_state_no_anon(k);
        let s = pub_status(&app, pub_req(&to, None)).await;
        assert_eq!(
            s,
            StatusCode::UNAUTHORIZED,
            "без Authorization и без tok публикация запрещена"
        );
        assert_eq!(app.metrics.pub_anon.load(Ordering::Relaxed), 0);
        assert_eq!(app.metrics.pub_ok.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn pub_with_sender_token_ok_when_anon_disabled() {
        let k = keys();
        let (to, hash) = fresh_topic(&k, 4_102_444_902);
        let (sender, _sender_hash) = fresh_topic(&k, 4_102_444_903);
        let app = app_state_no_anon(k);
        let s = pub_status(&app, pub_req(&to, Some(&sender))).await;
        assert_eq!(s, StatusCode::OK, "свой read-токен в теле — это креды");
        assert_eq!(app.metrics.pub_tok.load(Ordering::Relaxed), 1);
        assert_eq!(app.metrics.pub_anon.load(Ordering::Relaxed), 0);
        assert_eq!(
            app.store.peek(&hash, 0).expect("queue").len(),
            1,
            "конверт лёг в очередь получателя"
        );
    }

    #[tokio::test]
    async fn pub_with_expired_sender_token_rejected_when_anon_disabled() {
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_904);
        let (expired, _) = fresh_topic(&k, 1); // 1970 — протух
        let app = app_state_no_anon(k);
        let s = pub_status(&app, pub_req(&to, Some(&expired))).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "протухший токен — не креды");
    }

    #[tokio::test]
    async fn pub_with_garbage_sender_token_rejected_when_anon_disabled() {
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_904);
        let app = app_state_no_anon(k);
        let s = pub_status(&app, pub_req(&to, Some("not-a-token"))).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "мусор в tok — не креды");
    }

    #[tokio::test]
    async fn pub_with_write_token_in_body_is_not_sender_credential() {
        // В теле допустим только личный READ-токен; write-скоруп идёт
        // заголовком Authorization и здесь кредой не считается.
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_904);
        let write = issue(&k, Scope::Write, 4_102_444_904);
        let app = app_state_no_anon(k);
        let s = pub_status(&app, pub_req(&to, Some(&write))).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn pub_anonymous_still_allowed_when_anon_enabled() {
        // Kill-switch: при ANON_PUB=1 старое поведение сохраняется
        // (легаси-сборки без `tok` продолжают работать).
        let k = keys();
        let (to, hash) = fresh_topic(&k, 4_102_444_905);
        let app = app_state(k); // anon = true
        let s = pub_status(&app, pub_req(&to, None)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(app.metrics.pub_anon.load(Ordering::Relaxed), 1);
        assert_eq!(app.store.peek(&hash, 0).expect("queue").len(), 1);
    }

    #[tokio::test]
    async fn pub_metrics_breakdown_sums_to_pub_ok() {
        // Инвариант: pub_ok = pub_hdr + pub_tok + pub_anon + channel_pub.
        // Только по нему можно доказать по проду, что анонимных публикаций
        // (релей «открыт») нет: отказы в разбивку не попадают.
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_910);
        let (sender, _sender_hash) = fresh_topic(&k, 4_102_444_911);
        let app = app_state_no_anon(k);

        // 1) успех с кредами из тела — привязываем токен к «a:fp».
        let ok = pub_status(&app, with_fp(pub_req(&to, Some(&sender)), "a:fp")).await;
        assert_eq!(ok, StatusCode::OK);

        // 2) тот же токен с чужим fp — отказ, в pub_tok попасть не должен.
        let req = with_fp(pub_req(&to, Some(&sender)), "b:fp");
        let bad = pub_status(&app, req).await;
        assert_eq!(bad, StatusCode::FORBIDDEN, "чужой fp отбит");

        // 3) без кред — отказ (ANON_PUB=0).
        let anon = pub_status(&app, pub_req(&to, None)).await;
        assert_eq!(anon, StatusCode::UNAUTHORIZED);

        let m = &app.metrics;
        let ok_n = m.pub_ok.load(Ordering::Relaxed);
        let sum = m.pub_hdr.load(Ordering::Relaxed)
            + m.pub_tok.load(Ordering::Relaxed)
            + m.pub_anon.load(Ordering::Relaxed)
            + m.channel_pub.load(Ordering::Relaxed);
        assert_eq!(ok_n, 1, "успешна ровно одна публикация");
        assert_eq!(ok_n, sum, "разбивка сходится с pub_ok");
        assert_eq!(m.pub_tok.load(Ordering::Relaxed), 1, "только успешная");
        assert_eq!(m.pub_anon.load(Ordering::Relaxed), 0, "анонимных нет");
    }

    // ── ADR-002: маппинг токена владельца в политику регистрации ───────
    //
    // Тест не про саму политику (её тесты живут в channel_keys.rs) и не про
    // HTTP, а про МАППИНГ между ними. Именно он молча разошёлся: канальные
    // scope схлопывались в None, ветка 403 становилась недостижимой, а тест
    // политики оставался зелёным, потому что звал чистую функцию напрямую.
    // Тест, проходящий оба слоя сразу, — единственный, который такое ловит.

    #[test]
    fn owner_scope_mapping_is_total() {
        use vault_relay::Scope;
        // None здесь означал бы «токен не разобрался» — это другое состояние,
        // и смешивать его с «токен канальный» нельзя.
        assert_eq!(super::owner_scope_of(Scope::Read), Some('r'));
        assert_eq!(super::owner_scope_of(Scope::Write), Some('w'));
        assert_eq!(super::owner_scope_of(Scope::ChannelRead), Some('c'));
        assert_eq!(super::owner_scope_of(Scope::ChannelWrite), Some('C'));
    }

    #[test]
    fn channel_token_as_owner_is_forbidden_not_unauthorized() {
        use vault_relay::Scope;
        const PUB: &str = "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
        for scope in [Scope::ChannelRead, Scope::ChannelWrite] {
            let decision = channel_keys::decide_registration(
                super::owner_scope_of(scope), // ровно то, что делает хендлер
                false,
                Some('c'),
                Some(0x0102_0304_0506_0708),
                PUB,
            );
            assert_eq!(
                decision,
                channel_keys::RegisterDecision::Reject { status: 403, error: "personal token required" },
                "канальный токен как личный → 403 «personal token required», а не 401 «bad token»: \
                 токен исправен, он просто не доказывает владение"
            );
        }
    }
    // ── Платёжные роуты (шаг 4–5 плана платных токенов) ───────────────

    fn checkout_req(plan: &str, months: u32, fp: &str) -> CheckoutReq {
        CheckoutReq {
            plan: plan.to_string(),
            months,
            fp: fp.to_string(),
            lang: Some("ru".to_string()),
        }
    }

    /// Платежи выключены (нет ИП) → 402 «checkout disabled». Честный отказ, а
    /// не выдуманный успех: клиент не должен получить «оплачено» без провайдера.
    #[tokio::test]
    async fn purchase_checkout_402_when_payments_disabled() {
        let app = pay_app_state(keys(), None);
        let resp = relay_purchase_checkout(
            State(app),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
    }

    /// Плохой план или срок вне каталога → 422. Единый источник истины —
    /// PURCHASABLE_MONTHS: маршрут принимает ровно то, что показывает витрина,
    /// и отвергает всё остальное (старый тест держал политику «только 1 и 12»,
    /// когда 3/6/9 тоже стали покупаемыми сроками).
    #[tokio::test]
    async fn purchase_checkout_rejects_bad_plan_or_months() {
        let app = pay_app_state(keys(), Some(Arc::new(vault_relay::payments::TestProvider::new())));
        for (plan, months) in [
            ("free", 1u32),
            ("trial", 1),
            ("pro", 0),
            ("pro", 2),
            ("pro", 4),
            ("pro", 5),
            ("pro", 7),
            ("pro", 13),
            ("business", 11),
        ] {
            let resp = relay_purchase_checkout(
                State(app.clone()),
                Json(checkout_req(plan, months, "fp-alice")),
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "план {plan} / {months} месяцев должен отклоняться"
            );
        }
    }

    /// Покупаемые сроки каталога (1, 3, 6, 9, 12) — принимаются (200). Иначе
    /// витрина обещает срок, за который нельзя заплатить (дефект, из-за которого
    /// месяц за 149 ₽ был недоступен). Свой fingerprint на срок — чтобы не
    /// упереться в лимит 5 чекаутов/час.
    #[tokio::test]
    async fn purchase_checkout_accepts_every_catalog_period() {
        let app = pay_app_state(keys(), Some(Arc::new(vault_relay::payments::TestProvider::new())));
        for months in vault_relay::payments::PURCHASABLE_MONTHS {
            let fp = format!("fp-buy-{months}");
            let resp = relay_purchase_checkout(
                State(app.clone()),
                Json(checkout_req("pro", months, &fp)),
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::OK,
                "срок {months} месяцев должен покупаться, а не отклоняться"
            );
        }
    }

    /// Полный сценарий: чекаут → верификация → платный v2-токен.
    ///
    /// Проверяем главное: выпущенный токен — ИМЕННО v2 с планом Pro и
    /// подписка сохранена (иначе после рестарта релея покупка исчезнет).
    #[tokio::test]
    async fn purchase_checkout_then_verify_issues_paid_token() {
        let k = keys();
        // ServerKeys не Clone — берём вторую пару для проверки разбора токена.
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );

        let resp = relay_purchase_checkout(
            State(app.clone()),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .expect("body"),
        )
        .expect("json");
        let checkout_id = body["checkout_id"].as_str().expect("checkout_id").to_string();

        let vresp = relay_purchase_verify(
            State(app.clone()),
            Json(VerifyReq {
                checkout_id,
                fp: "fp-alice".to_string(),
            }),
        )
        .await;
        assert_eq!(vresp.status(), StatusCode::OK);
        let vbody: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(vresp.into_body(), 64 * 1024)
                .await
                .expect("body"),
        )
        .expect("json");
        let token = vbody["token"].as_str().expect("token").to_string();
        assert_eq!(vbody["plan"], "pro", "выданный токен — тариф Pro");
        let t = parse(&k, &token).expect("выданный токен разбирается");
        assert_eq!(t.plan, vault_relay::tokens::Plan::Pro);
        assert!(t.v >= 2, "платный токен — v2 (в нём план и срок)");
        assert!(!vbody["topic"].as_str().unwrap_or("").is_empty(), "адрес очереди не пуст");
        // Подписка сохранена: покупка не должна исчезнуть при рестарте релея.
        let subs = app.subscriptions.lock().expect("subscriptions lock");
        assert_eq!(subs.len(), 1, "подписка сохранена");
        assert_eq!(subs.values().next().unwrap().plan, "pro");
    }

    /// Чужой fingerprint не может забрать оплаченный чекаут (409 fp_mismatch):
    /// иначе оплативший «A» выдал бы токен «B».
    #[tokio::test]
    async fn purchase_verify_rejects_foreign_fp() {
        let app = pay_app_state(keys(), Some(Arc::new(vault_relay::payments::TestProvider::new())));
        let resp = relay_purchase_checkout(
            State(app.clone()),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .expect("body"),
        )
        .expect("json");
        let checkout_id = body["checkout_id"].as_str().expect("checkout_id").to_string();
        let vresp = relay_purchase_verify(
            State(app),
            Json(VerifyReq {
                checkout_id,
                fp: "fp-злодей".to_string(),
            }),
        )
        .await;
        assert_eq!(vresp.status(), StatusCode::CONFLICT);
    }

    async fn body_text(resp: axum::response::Response) -> String {
        String::from_utf8(
            axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .expect("body")
                .to_vec(),
        )
        .expect("utf-8")
    }

    fn pay_return_query(lang: Option<&str>) -> Query<PayReturnQuery> {
        Query(PayReturnQuery {
            lang: lang.map(str::to_string),
        })
    }

    async fn create_checkout_id(app: Arc<AppState>) -> String {
        let resp = relay_purchase_checkout(
            State(app),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        body_json(resp).await["checkout_id"]
            .as_str()
            .expect("checkout_id")
            .to_string()
    }

    /// Страница возврата НЕ подтверждает оплату: она только показывает текст.
    /// Токен и подписка появляются исключительно через /purchase/verify.
    #[tokio::test]
    async fn pay_return_known_checkout_shows_page_without_issuing_token() {
        let app = pay_app_state(
            keys(),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let checkout_id = create_checkout_id(app.clone()).await;

        let resp = pay_return(
            State(app.clone()),
            Path(checkout_id),
            pay_return_query(None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store"),
            "страница оплаты не кэшируется"
        );
        let html = body_text(resp).await;
        assert!(html.contains("Вернитесь в приложение"), "{html}");
        assert!(!html.contains("fp-alice"), "страница не раскрывает fingerprint");
        assert!(
            app.subscriptions.lock().expect("subscriptions").is_empty(),
            "просмотр страницы не выдаёт подписку"
        );
        assert!(
            app.token_bindings.lock().expect("bindings").is_empty(),
            "просмотр страницы не выпускает токен"
        );
    }

    /// Язык берётся из `?lang=ru|en|zh` (ЮKassa передаёт его из чекаута).
    /// Три языка — как в приложении, а не только ru/en.
    #[tokio::test]
    async fn pay_return_page_honours_lang() {
        let app = pay_app_state(
            keys(),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let checkout_id = create_checkout_id(app.clone()).await;
        let cases = [
            (Some("en"), "Checking your payment", r#"lang="en""#),
            (Some("zh"), "正在确认支付", r#"lang="zh""#),
            (Some("EN"), "Checking your payment", r#"lang="en""#),
            (Some("de"), "Проверяем оплату", r#"lang="ru""#),
            (None, "Проверяем оплату", r#"lang="ru""#),
        ];
        for (lang, text, tag) in cases {
            let resp = pay_return(
                State(app.clone()),
                Path(checkout_id.clone()),
                pay_return_query(lang),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::OK);
            let html = body_text(resp).await;
            assert!(html.contains(text), "lang={lang:?}: {html}");
            assert!(html.contains(tag), "lang={lang:?}: {html}");
        }
    }

    /// Неизвестный id (релей перезапускался, сессия потеряна) — 404, а не 500.
    #[tokio::test]
    async fn pay_return_unknown_session_is_404() {
        let app = pay_app_state(keys(), None);
        let resp = pay_return(
            State(app),
            Path("co_missing".to_string()),
            pay_return_query(None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let html = body_text(resp).await;
        assert!(html.contains("Ссылка устарела"), "{html}");
    }

    /// Истёкшая сессия — 410 Gone: человеку ясно, что оплата не ждёт.
    #[tokio::test]
    async fn pay_return_expired_session_is_410() {
        let app = pay_app_state(
            keys(),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let checkout_id = create_checkout_id(app.clone()).await;
        {
            let mut map = app.checkouts.lock().expect("checkouts");
            map.get_mut(&checkout_id).expect("checkout").expires_at = now() - 1;
        }
        let resp = pay_return(
            State(app),
            Path(checkout_id),
            pay_return_query(None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::GONE);
        let html = body_text(resp).await;
        assert!(html.contains("Сессия оплаты истекла"), "{html}");
    }

    /// Идемпотентность: повторный чекаут того же fp/плана/срока возвращает
    /// ТОТ ЖЕ checkout_id (иначе каждый клик плодил платёжные сессии).
    #[tokio::test]
    async fn purchase_checkout_is_idempotent_per_fp_plan_months() {
        let app = pay_app_state(keys(), Some(Arc::new(vault_relay::payments::TestProvider::new())));
        let id_of = |app: Arc<AppState>| async move {
            let resp = relay_purchase_checkout(
                State(app),
                Json(checkout_req("pro", 12, "fp-alice")),
            )
            .await;
            let body: serde_json::Value = serde_json::from_slice(
                &axum::body::to_bytes(resp.into_body(), 64 * 1024)
                    .await
                    .expect("body"),
            )
            .expect("json");
            body["checkout_id"].as_str().expect("checkout_id").to_string()
        };
        let first = id_of(app.clone()).await;
        let second = id_of(app.clone()).await;
        assert_eq!(first, second, "повторный чекаут возвращает тот же id");
    }

    /// Лимитер чекаутов: не больше 5 в час на fingerprint.
    #[tokio::test]
    async fn purchase_checkout_rate_limited_per_fp() {
        let app = pay_app_state(keys(), Some(Arc::new(vault_relay::payments::TestProvider::new())));
        let mut last = StatusCode::OK;
        for _ in 0..7 {
            last = relay_purchase_checkout(
                State(app.clone()),
                Json(checkout_req("pro", 1, "fp-alice")),
            )
            .await
            .status();
        }
        assert_eq!(
            last,
            StatusCode::TOO_MANY_REQUESTS,
            "шестой чекаут в час должен быть отклонён"
        );
    }

    // ── Роуты токена подписки: активация и остаток лимитов ──────────────

    /// Платный v2-токен для проверок: план Pro, подписка 42, срок — 10 лет.
    fn paid_token(k: &ServerKeys, sub: u64) -> String {
        vault_relay::tokens::issue_v2(
            k,
            Scope::Read,
            vault_relay::tokens::Plan::Pro,
            sub,
            (now() + 3650 * 86400) as u32,
        )
    }

    /// Активация платного токена: устройство привязывается, устройство = 1.
    #[tokio::test]
    async fn tokens_activate_binds_device_to_subscription() {
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let token = paid_token(&k, 42);
        let resp = relay_tokens_activate(
            State(app.clone()),
            Json(ActivateReq {
                token,
                fp: "fp-alice".to_string(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), 64 * 1024).await.expect("body"),
        )
        .expect("json");
        assert_eq!(body["bound"], true);
        assert_eq!(body["devices"], 1, "первое устройство подписки");
        assert_eq!(body["max_devices"], 3);
    }

    /// Повторная активация ТОГО ЖЕ токена не увеличивает число устройств:
    /// иначе перезапуск приложения съедал бы лимит.
    #[tokio::test]
    async fn tokens_activate_is_idempotent_for_same_token() {
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let token = paid_token(&k, 42);
        for _ in 0..3 {
            let resp = relay_tokens_activate(
                State(app.clone()),
                Json(ActivateReq {
                    token: token.clone(),
                    fp: "fp-alice".to_string(),
                }),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::OK);
        }
        assert_eq!(
            app.subscription_devices("42"),
            1,
            "один токен = одно устройство, сколько бы раз ни активировали"
        );
    }

    /// Лимит устройств: четвёртое устройство — 409 device_limit.
    #[tokio::test]
    async fn tokens_activate_enforces_device_limit() {
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        for i in 0..3u64 {
            let token = paid_token(&k, 42);
            let resp = relay_tokens_activate(
                State(app.clone()),
                Json(ActivateReq {
                    token,
                    fp: format!("fp-device-{i}"),
                }),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::OK, "устройство {i} должно активироваться");
        }
        // Четвёртое устройство — новый токен той же подписки.
        let token = paid_token(&k, 42);
        let resp = relay_tokens_activate(
            State(app.clone()),
            Json(ActivateReq {
                token,
                fp: "fp-device-4".to_string(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT, "четвёртое устройство — отказ");
    }

    /// Неплатный токен не активируется как платный (402).
    #[tokio::test]
    async fn tokens_activate_rejects_free_token() {
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let token = vault_relay::tokens::issue_install(&k, now() as u32);
        let resp = relay_tokens_activate(
            State(app),
            Json(ActivateReq {
                token,
                fp: "fp-alice".to_string(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
    }

    /// /tokens/info: без токена — 401; с платным — план, лимиты, устройства.
    #[tokio::test]
    async fn tokens_info_requires_token_and_reports_plan() {
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let resp = relay_tokens_info(State(app.clone()), HeaderMap::new()).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let token = paid_token(&k, 42);
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            format!("VaultRelay {token}").parse().expect("hdr"),
        );
        let resp = relay_tokens_info(State(app), h).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), 64 * 1024).await.expect("body"),
        )
        .expect("json");
        assert_eq!(body["plan"], "pro");
        assert_eq!(body["max_devices"], 3);
        assert_eq!(
            body["daily_limit"], PRO_DAILY_LIMIT,
            "экран Pro обязан видеть квоту тарифа, а не 0/безлимит"
        );
    }

    // ── Контракт с клиентом (общая фикстура) ───────────────────────────
    //
    // Фикстура tests/fixtures/pay-contract.json читают ОБЕ стороны: эти
    // тесты (релей) и JS-смоук клиента. Пока контракт проверялся с каждой
    // стороны отдельно, расхождение (имя поля, тип) проходило незамеченным:
    // релей отдавал одно, клиент ждал другое, и обе проверки были зелёными.
    fn pay_contract_fixture() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pay-contract.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("фикстура контракта читается"))
            .expect("фикстура контракта — валидный JSON")
    }

    /// Тип значения по имени фикстуры: string / number / boolean.
    fn json_type(v: &serde_json::Value) -> &'static str {
        match v {
            serde_json::Value::String(_) => "string",
            serde_json::Value::Number(_) => "number",
            serde_json::Value::Bool(_) => "boolean",
            _ => "other",
        }
    }

    /// Сверить ответ роута с фикстурой: те же поля и те же типы.
    fn assert_shape(actual: &serde_json::Value, expected: &serde_json::Value, ctx: &str) {
        let a = actual.as_object().expect("ответ — объект");
        let e = expected.as_object().expect("фикстура — объект");
        let mut ak: Vec<&String> = a.keys().collect();
        let mut ek: Vec<&String> = e.keys().collect();
        ak.sort();
        ek.sort();
        assert_eq!(ak, ek, "{}: набор полей ответа разошёлся с фикстурой", ctx);
        let types = pay_contract_fixture();
        for (k, v) in a {
            let want = types["field_types"][k]
                .as_str()
                .unwrap_or_else(|| panic!("{}: поле {} не описано в фикстуре типов", ctx, k));
            assert_eq!(
                json_type(v),
                want,
                "{}: тип поля {} разошёлся с фикстурой (клиент ждёт другой)",
                ctx,
                k
            );
        }
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .expect("body"),
        )
        .expect("json")
    }

    /// ЧЕКАУТ: набор полей и их типы совпадают с общей фикстурой.
    #[tokio::test]
    async fn pay_checkout_response_matches_contract_fixture() {
        let fixture = pay_contract_fixture();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let resp = relay_purchase_checkout(
            State(app),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_shape(&body, &fixture["checkout_ok"], "checkout");
    }

    /// ВЕРИФИКАЦИЯ: набор полей и их типы совпадают с общей фикстурой.
    #[tokio::test]
    async fn pay_verify_response_matches_contract_fixture() {
        let fixture = pay_contract_fixture();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let resp = relay_purchase_checkout(
            State(app.clone()),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        let body = body_json(resp).await;
        let checkout_id = body["checkout_id"].as_str().expect("checkout_id").to_string();
        let vresp = relay_purchase_verify(
            State(app),
            Json(VerifyReq {
                checkout_id,
                fp: "fp-alice".to_string(),
            }),
        )
        .await;
        assert_eq!(vresp.status(), StatusCode::OK);
        let vbody = body_json(vresp).await;
        assert_shape(&vbody, &fixture["verify_ok"], "verify");
    }

    /// ТОКЕНЫ/INFO: набор полей и их типы совпадают с общей фикстурой.
    #[tokio::test]
    async fn pay_tokens_info_response_matches_contract_fixture() {
        let fixture = pay_contract_fixture();
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let token = paid_token(&k, 42);
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            format!("VaultRelay {token}").parse().expect("hdr"),
        );
        let resp = relay_tokens_info(State(app), h).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_shape(&body, &fixture["tokens_info_ok"], "tokens_info");
    }

    /// АКТИВАЦИЯ: набор полей и их типы совпадают с общей фикстурой.
    #[tokio::test]
    async fn pay_tokens_activate_response_matches_contract_fixture() {
        let fixture = pay_contract_fixture();
        let k = keys();
        let app = pay_app_state(
            ServerKeys::new([7u8; 32]),
            Some(Arc::new(vault_relay::payments::TestProvider::new())),
        );
        let token = paid_token(&k, 42);
        let resp = relay_tokens_activate(
            State(app),
            Json(ActivateReq {
                token,
                fp: "fp-alice".to_string(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_shape(&body, &fixture["activate_ok"], "tokens_activate");
    }

    /// Коды ошибок платёжных роутов — те же строки, что в фикстуре: клиент
    /// по коду выбирает человеческий текст, и незнакомый код означал бы
    /// «что-то сломалось» вместо понятного объяснения.
    #[tokio::test]
    async fn pay_error_codes_match_contract_fixture() {
        let fixture = pay_contract_fixture();
        let codes = fixture["error_codes"].as_object().expect("коды ошибок");
        // 402 «покупка недоступна» — главный код, который видит пользователь.
        let app = pay_app_state(keys(), None);
        let resp = relay_purchase_checkout(
            State(app),
            Json(checkout_req("pro", 1, "fp-alice")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
        let body = body_json(resp).await;
        let got = body["error"].as_str().expect("error");
        assert_eq!(
            got,
            codes["checkout_disabled"].as_str().expect("код в фикстуре"),
            "код ошибки разошёлся с фикстурой"
        );
    }

    // ── Суточный лимит релея (по умолчанию 100 конвертов free) ──
    //
    // Счёт на ИЗДАТЕЛЯ (не на получателя и не на релей в целом), квота — по
    // ЯВНОМУ тарифу токена (Kind/daily_limit_for_token), а не по сроку:
    // эвристика «expiry дальше года» делала безлимитным любой долгий токен.
    // Trial — без лимита, Pro/Business — свои пороги. Почта лимита не имеет
    // никогда, поэтому 429 = «только ускорение выключено».

    fn limit_app(k: ServerKeys, limit: u32, anon: bool) -> Arc<AppState> {
        Arc::new(AppState::new(
            Store::new(),
            k,
            anon,
            String::new(),
            None,
            None,
            limit,
            None,
            None,
            None,
        ))
    }

    async fn pub_resp(app: &Arc<AppState>, req: PubRequest) -> axum::response::Response {
        relay_pub(
            State(app.clone()),
            ConnectInfo("127.0.0.1:1234".parse().expect("addr")),
            HeaderMap::new(),
            AxumJson(req),
        )
        .await
    }

    #[tokio::test]
    async fn daily_limit_blocks_the_publisher_and_names_midnight_utc() {
        let k = keys();
        let (to, hash) = fresh_topic(&k, 4_102_444_920);
        let sender = issue_install(&k, now() as u32);
        let app = limit_app(k, 2, false);
        for _ in 0..2 {
            let s = pub_resp(&app, pub_req(&to, Some(&sender))).await;
            assert_eq!(s.status(), StatusCode::OK, "в пределах лимита публикуется");
        }
        let blocked = pub_resp(&app, pub_req(&to, Some(&sender))).await;
        assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS, "третий — за лимит");
        // Заголовок и тело обязаны назвать ОДНО время: клиент по нему
        // показывает «до 00:00 UTC», а не «попробуйте позже».
        let hdr = blocked
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .expect("retry-after в заголовке");
        let body = body_json(blocked).await;
        assert_eq!(body["limit"].as_u64(), Some(2), "лимит в ответе = из конфига");
        assert_eq!(body["retry_after"].as_u64(), Some(hdr), "заголовок и тело разошлись");
        assert!(hdr > 0 && hdr <= 86400, "retry_after вне суток: {hdr}");
        assert_eq!((now() + hdr) % 86400, 0, "retry_after обязан указывать на полночь UTC");
        assert_eq!(
            app.store.peek(&hash, 0).expect("queue").len(),
            2,
            "отклонённый конверт не встал в очередь (иначе 429 — фикция)"
        );
        assert_eq!(app.metrics.limit_hit.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn daily_limit_is_per_publisher_not_per_recipient() {
        let k = keys();
        let (to, hash) = fresh_topic(&k, 4_102_444_930);
        let a = issue_install(&k, now() as u32);
        let b = issue_install(&k, now() as u32);
        let app = limit_app(k, 2, false);
        for _ in 0..2 {
            assert_eq!(pub_resp(&app, pub_req(&to, Some(&a))).await.status(), StatusCode::OK);
        }
        assert_eq!(pub_resp(&app, pub_req(&to, Some(&a))).await.status(), StatusCode::TOO_MANY_REQUESTS);
        // Тот же получатель, другой издатель — своя квота. Иначе общий чат
        // «замолкал» бы после ста ЧУЖИХ сообщений.
        assert_eq!(
            pub_resp(&app, pub_req(&to, Some(&b))).await.status(),
            StatusCode::OK,
            "лимит сосчитан по получателю, а не по издателю"
        );
        assert_eq!(app.store.peek(&hash, 0).expect("queue").len(), 3);
    }

    #[tokio::test]
    async fn trial_is_unlimited_while_paid_has_its_own_quota() {
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_940);
        let install = issue_install(&k, now() as u32);
        let trial = issue_test(&k, now() as u32);
        let pro = issue_v2(&k, Scope::Read, Plan::Pro, 7, (now() + 86_400) as u32);
        let app = limit_app(k, 1, false);
        assert_eq!(pub_resp(&app, pub_req(&to, Some(&install))).await.status(), StatusCode::OK);
        assert_eq!(
            pub_resp(&app, pub_req(&to, Some(&install))).await.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "Plan::Free обязан лимитироваться, каким бы долгим ни был"
        );
        for _ in 0..3 {
            assert_eq!(
                pub_resp(&app, pub_req(&to, Some(&trial))).await.status(),
                StatusCode::OK,
                "тестовый вид токена обязан остаться безлимитным"
            );
        }
        // Pro не упирается в БЕСПЛАТНЫЙ лимит: у него своя квота 1000/сут.
        for _ in 0..3 {
            assert_eq!(
                pub_resp(&app, pub_req(&to, Some(&pro))).await.status(),
                StatusCode::OK,
                "платный тариф не должен считать чужую (free) квоту"
            );
        }
        assert_eq!(app.metrics.limit_hit.load(Ordering::Relaxed), 1, "засчитан только установочному");
    }

    #[test]
    fn channel_token_does_not_bypass_the_daily_limit() {
        // Канальный write-токен несёт expiry = u32::MAX: легаси-эвристика
        // «срок дальше года = premium» сделала бы каждый пост в канал
        // безлимитным. Вид канала — не признак безлимита.
        let k = keys();
        let chan = issue(&k, Scope::ChannelWrite, u32::MAX);
        let req = pub_req("to-unused", Some(&chan));
        let app = limit_app(k, 1, false);
        let addr = "127.0.0.1:1234".parse().expect("addr");
        let (key, quota) = publisher_key(&app, &HeaderMap::new(), &req, &addr);
        assert_eq!(quota, Some(1), "канал не может обходить суточный лимит");
        assert!(key.starts_with("t:"), "издатель атрибутирован токеном, а не IP");
    }

    #[test]
    fn daily_quota_is_per_plan_and_independent_of_token_lifetime() {
        let k = keys();
        let now32 = now() as u32;
        let free = parse(&k, &issue_install(&k, now32)).expect("install");
        let trial = parse(&k, &issue_test(&k, now32)).expect("trial");
        let pro = parse(
            &k,
            &issue_v2(&k, Scope::Read, Plan::Pro, 1, 4_102_444_800),
        )
        .expect("pro");
        let business = parse(
            &k,
            &issue_v2(&k, Scope::Read, Plan::Business, 1, 4_102_444_800),
        )
        .expect("business");
        let channel = parse(&k, &issue(&k, Scope::ChannelWrite, u32::MAX)).expect("channel");
        let legacy_promo =
            parse(&k, &issue(&k, Scope::Read, (now() + 400 * 86_400) as u32)).expect("legacy");
        let legacy_short =
            parse(&k, &issue(&k, Scope::Read, (now() + 30 * 86_400) as u32)).expect("legacy");

        assert_eq!(daily_limit_for_token(&free, 100), Some(100));
        assert_eq!(daily_limit_for_token(&trial, 100), None, "Trial — безлимит");
        assert_eq!(PRO_DAILY_LIMIT, 1_000, "квота Pro из спеки");
        assert_eq!(BUSINESS_DAILY_LIMIT, 10_000, "квота Business из спеки");
        assert_eq!(daily_limit_for_token(&pro, 100), Some(1_000));
        assert_eq!(daily_limit_for_token(&business, 100), Some(10_000));
        assert_eq!(
            daily_limit_for_token(&channel, 100),
            Some(100),
            "канал лимитируется free-квотой по hash write-токена"
        );
        assert_eq!(
            daily_limit_for_token(&legacy_promo, 100),
            None,
            "легаси-promo (долгий v1) остаётся без лимита"
        );
        assert_eq!(daily_limit_for_token(&legacy_short, 100), Some(100));
        assert_eq!(
            daily_limit_for_token(&pro, 0),
            Some(PRO_DAILY_LIMIT),
            "free-выключатель не отключает квоту платного тарифа"
        );
    }

    /// Счётчик переживает рестарт релея: иначе квоту (и free, и Pro) можно
    /// было бы обходить простым деплоем.
    #[tokio::test]
    async fn daily_counter_survives_relay_restart() {
        let (to, _hash) = fresh_topic(&keys(), 4_102_444_960);
        let sender = issue_install(&keys(), now() as u32);
        let path = std::env::temp_dir().join(format!(
            "vault-relay-daily-{}-{}.json",
            std::process::id(),
            now()
        ));
        let state_app = |limit| {
            Arc::new(AppState::new(
                Store::new(),
                keys(),
                false,
                String::new(),
                None,
                None,
                limit,
                None,
                Some(path.clone()),
                None,
            ))
        };

        let first = state_app(2);
        assert_eq!(
            pub_resp(&first, pub_req(&to, Some(&sender))).await.status(),
            StatusCode::OK
        );
        drop(first);

        let second = state_app(2);
        assert_eq!(
            pub_resp(&second, pub_req(&to, Some(&sender))).await.status(),
            StatusCode::OK,
            "второй конверт в пределах квоты после рестарта"
        );
        drop(second);

        let third = state_app(2);
        assert_eq!(
            pub_resp(&third, pub_req(&to, Some(&sender))).await.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "рестарт релея не обнуляет суточную квоту"
        );
        assert_eq!(third.metrics.limit_hit.load(Ordering::Relaxed), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn anonymous_publishers_are_counted_per_ip() {
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_950);
        let app = limit_app(k, 1, true);
        assert_eq!(pub_status(&app, pub_req(&to, None)).await, StatusCode::OK);
        assert_eq!(
            pub_status(&app, pub_req(&to, None)).await,
            StatusCode::TOO_MANY_REQUESTS,
            "анонимный издатель считается по IP"
        );
        let other_ip = relay_pub(
            State(app.clone()),
            ConnectInfo("10.0.0.2:5".parse().expect("addr")),
            HeaderMap::new(),
            AxumJson(pub_req(&to, None)),
        )
        .await;
        assert_eq!(
            other_ip.status(),
            StatusCode::OK,
            "лимит не должен быть общим на весь релей"
        );
    }

    #[tokio::test]
    async fn zero_daily_limit_disables_the_counter_entirely() {
        // VAULT_RELAY_FREE_DAILY_LIMIT=0 — выключатель (стенд, отладка):
        // счётчик не ведётся, 429 нет.
        let k = keys();
        let (to, hash) = fresh_topic(&k, 4_102_444_970);
        let sender = issue_install(&k, now() as u32);
        let app = limit_app(k, 0, false);
        for _ in 0..6 {
            assert_eq!(pub_resp(&app, pub_req(&to, Some(&sender))).await.status(), StatusCode::OK);
        }
        assert_eq!(app.metrics.limit_hit.load(Ordering::Relaxed), 0);
        assert_eq!(app.store.peek(&hash, 0).expect("queue").len(), 6);
    }

    #[tokio::test]
    async fn legacy_long_v1_token_keeps_no_limit() {
        // Промо-токены, выданные до v2, не несут тариф: их вид выводится
        // эвристикой по сроку. Забыть её — значит дать суточный лимит живым
        // безлимитным аккаунтам (тот же класс, что «перевыдать адрес очереди»).
        let k = keys();
        let (to, _hash) = fresh_topic(&k, 4_102_444_945);
        let legacy = issue(&k, Scope::Read, (now() + 400 * 86_400) as u32);
        let app = limit_app(k, 1, false);
        for _ in 0..3 {
            assert_eq!(
                pub_resp(&app, pub_req(&to, Some(&legacy))).await.status(),
                StatusCode::OK,
                "легаси-promo упёрся в суточный лимит"
            );
        }
        assert_eq!(app.metrics.limit_hit.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn daily_limit_defaults_to_one_hundred_and_survives_junk() {
        // Ноль — штатный ВЫКЛЮЧАТЕЛЬ, поэтому «опечатка в конфиге» не имеет
        // права превратиться в ноль: иначе релей стал бы безлимитным для всех.
        assert_eq!(daily_limit_from_env(None), DEFAULT_FREE_DAILY_LIMIT);
        assert_eq!(DEFAULT_FREE_DAILY_LIMIT, 100, "требование: 100 конвертов/сутки");
        for junk in ["", "   ", "сто", "1e3", "-1", "100.5", &"9".repeat(12)] {
            assert_eq!(
                daily_limit_from_env(Some(junk)),
                DEFAULT_FREE_DAILY_LIMIT,
                "мусор «{junk}» обязан дать дефолт"
            );
        }
        assert_eq!(daily_limit_from_env(Some(" 250 ")), 250, "пробелы не ломают чтение");
        assert_eq!(daily_limit_from_env(Some("0")), 0, "ноль — сознательный выключатель");
    }

    #[test]
    fn tally_daily_counts_per_publisher_and_resets_at_utc_midnight() {
        // Смена суток — единственное, что HTTP-тестами не проверяется: они живут
        // внутри одной секунды, и ветка сброса днём не срабатывает никогда.
        let mut map: HashMap<String, (u64, u32)> = HashMap::new();
        let day = 20_000;
        let start = day * 86_400;
        assert_eq!(tally_daily(&mut map, "t:a", day, 2, start + 1), None);
        assert_eq!(tally_daily(&mut map, "t:a", day, 2, start + 2), None);
        // Отказ не должен засчитываться: иначе издатель «расходует» сутки
        // попытками, которые сервер отверг.
        assert_eq!(
            tally_daily(&mut map, "t:a", day, 2, start + 3),
            Some(86_400 - 3)
        );
        assert_eq!(map.get("t:a"), Some(&(day, 2)), "отклонённый pub не инкремент");
        // Чужой расход не наследуется.
        assert_eq!(tally_daily(&mut map, "t:b", day, 2, start + 4), None);
        // Полночь UTC — счётчик обнуляется, а не становится пожизненным.
        assert_eq!(
            tally_daily(&mut map, "t:a", day + 1, 2, start + 86_400),
            None,
            "новые сутки застали издателя заблокированным"
        );
        assert_eq!(map.get("t:a"), Some(&(day + 1, 1)), "день не обновлён");
        // retry_after — до ближайшей полуночи UTC, а не «24 часа от запроса».
        assert_eq!(tally_daily(&mut map, "t:a", day + 1, 1, start + 86_401), Some(86_400 - 1));
    }

    // ── GET /relay/turn: временные TURN-креды (т_18b4d871) ──
    // Проверяем контракт с coturn и с клиентом: пара считается на сервере,
    // срок живёт в username, квота TURN — ОБЩИЙ бюджет релея с конвертами (один
    // счётчик `t:<hash>`, один порог), решает её сервер (клиент лимит не
    // поднимает), а без конфигурации эндпоинт отвечает честный 503, а не пустые
    // креды.

    /// Порог бесплатного бюджета релея задаём явно: на нём держатся и тесты
    /// квоты TURN, потому что TURN больше не имеет собственной лестницы.
    fn turn_app_state_with_limit(k: ServerKeys, free_daily_limit: u32) -> Arc<AppState> {
        let mut app = AppState::new(
            Store::new(),
            k,
            true,
            String::new(),
            None,
            None,
            free_daily_limit,
            None,
            None,
            None,
        );
        app.turn = Some(vault_relay::turn::TurnConfig {
            secret: "test-secret".into(),
            host: "203.0.113.7".into(),
        });
        Arc::new(app)
    }

    /// По умолчанию — живой бесплатный бюджет (100), чтобы тесты квоты
    /// случайно не проверяли «выключатель».
    fn turn_app_state(k: ServerKeys) -> Arc<AppState> {
        turn_app_state_with_limit(k, DEFAULT_FREE_DAILY_LIMIT)
    }

    /// Секрета (ни promo-ключа, ни TURN-секрета) в ответе быть не должно —
    /// проверяем это в каждом тесте выдачи одним хелпером.
    async fn turn_issue(app: &Arc<AppState>, token: &str) -> axum::response::Response {
        relay_turn(State(app.clone()), auth_headers(token)).await
    }

    #[tokio::test]
    async fn turn_bez_konfiguracii_otvechaet_503_a_ne_pustymi_kredami() {
        // Важен сам ответ: пустая пара (200 с "") стоила бы клиенту
        // «turn server credentials required» на сборке PeerConnection.
        let app = app_state(keys());
        let tok = issue_install(&app.keys, now() as u32);
        assert_eq!(
            turn_issue(&app, &tok).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn turn_bez_tokena_i_bityj_token_401() {
        let app = turn_app_state(keys());
        assert_eq!(
            relay_turn(State(app.clone()), HeaderMap::new()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            turn_issue(&app, "мусор-а-не-токен").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn turn_prosrochennyj_token_402() {
        let app = turn_app_state(keys());
        let dead = issue_install(&app.keys, 0); // заведомо в прошлом
        assert_eq!(
            turn_issue(&app, &dead).await.status(),
            StatusCode::PAYMENT_REQUIRED
        );
    }

    #[tokio::test]
    async fn turn_kanalnomu_tokenu_otkaz_403() {
        // Канальный токен — не аккаунт звонящего: relay-трафик за наш счёт.
        let app = turn_app_state(keys());
        // Capability-токен канала живёт без срока (u32::MAX) — иначе parse
        // его отвергает как битый, а это 401, а не 403.
        let ch = issue(&app.keys, Scope::ChannelRead, u32::MAX);
        assert_eq!(
            turn_issue(&app, &ch).await.status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn turn_vydaet_paru_po_sheme_coturn() {
        let app = turn_app_state(keys());
        let tok = issue_install(&app.keys, now() as u32);
        let t = parse(&app.keys, &tok).expect("token parses");
        let resp = turn_issue(&app, &tok).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let j = body_json(resp).await;
        let username = j["username"].as_str().expect("username").to_string();
        // `<истечение>:<метка>` — метка есть hash очереди, срок = now + TTL.
        let (exp, tag) = username.split_once(':').expect("формат username");
        assert_eq!(tag, t.hash, "меткой идёт hash очереди, а не токен");
        let left: u64 = exp.parse().expect("expiry числом");
        let ttl = j["ttl"].as_u64().expect("ttl");
        assert_eq!(ttl, vault_relay::turn::CRED_TTL);
        let now_now = now();
        assert!(
            left >= now_now + ttl && left <= now_now + ttl + 5,
            "истечение = выдача + ttl, а не произвольная дата: {left} vs {now_now}"
        );
        // Пару сверяем пересчётом: тот же секрет + тот же username ⇒ тот же
        // credential. Иначе coturn отвергает Allocate, а symptom — «нет звука».
        assert_eq!(
            j["credential"].as_str().expect("credential"),
            vault_relay::turn::credential("test-secret", &username)
        );
        let uris = j["uris"].as_array().expect("uris");
        assert_eq!(uris.len(), 2, "UDP + TCP страховка");
        assert_eq!(uris[0], "turn:203.0.113.7:3478");
        // Секрет наружу не уезжает никогда.
        assert!(!j.to_string().contains("test-secret"), "секрет в ответе");
    }

    #[tokio::test]
    async fn turn_tratit_obshchiy_byudzhet_releya_vmeste_s_konvertami() {
        // Мера ОДНА: суточный бюджет релея на токен. Здесь 4 unit, и они
        // кончаются на смеси писем и выдач — отказывают оба пути. Смысл
        // именно такой: «100 сообщений в сутки» в тарифе не должно врать, а
        // лимит не должен обходиться одним звонком.
        let k = keys();
        let (to, _) = fresh_topic(&k, 4_102_444_930);
        let app = turn_app_state_with_limit(k, 4);
        let tok = issue_install(&app.keys, now() as u32);
        let t = parse(&app.keys, &tok).expect("token parses");
        // Бюджет тратят оба пути по очереди — так видно, что счётчик один.
        assert_eq!(pub_resp(&app, pub_req(&to, Some(&tok))).await.status(), StatusCode::OK, "конверт 1");
        assert_eq!(turn_issue(&app, &tok).await.status(), StatusCode::OK, "выдача TURN 1");
        assert_eq!(pub_resp(&app, pub_req(&to, Some(&tok))).await.status(), StatusCode::OK, "конверт 2");
        assert_eq!(turn_issue(&app, &tok).await.status(), StatusCode::OK, "выдача TURN 2");
        let over_turn = turn_issue(&app, &tok).await;
        assert_eq!(
            over_turn.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "бюджет израсходован — TURN обязан отказать"
        );
        assert!(
            over_turn.headers().contains_key("retry-after"),
            "429 обязан говорить, когда повторить"
        );
        let j = body_json(over_turn).await;
        assert_eq!(j["limit"].as_u64(), Some(4), "в ответе — общий бюджет, не свой");
        assert_eq!(
            pub_resp(&app, pub_req(&to, Some(&tok))).await.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "звонки не должны оставлять письма за пределами лимита"
        );
        let map = app.daily_pub.lock().unwrap();
        assert_eq!(
            map.get(&format!("t:{}", t.hash)).map(|v| v.1),
            Some(4),
            "TURN и конверты считают в одном ключе"
        );
        assert!(
            !map.contains_key(&format!("turn:{}", t.hash)),
            "отдельного счётчика TURN быть не должно"
        );
        drop(map);
        assert_eq!(app.metrics.limit_hit.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn turn_testovomu_tokenu_limit_ne_ponyaetsya() {
        // Тестовый вид (промо) — без лимита, как и с конвертами: иначе
        // приёмка на X50 упёрлась бы в 429 посреди проверки звонка.
        let app = turn_app_state(keys());
        let tok = issue_test(&app.keys, now() as u32);
        for i in 0..DEFAULT_FREE_DAILY_LIMIT + 5 {
            assert_eq!(
                turn_issue(&app, &tok).await.status(),
                StatusCode::OK,
                "тестовому токену поставили лимит (выдача №{})",
                i + 1
            );
        }
        assert!(
            app.daily_pub.lock().unwrap().is_empty(),
            "безлимитный вид не должен тратить счётчик"
        );
    }

    #[tokio::test]
    async fn turn_platnyj_token_zhivet_po_kvote_tarifa() {
        // Купленный Pro даёт 1000 unit вместо 100 — деньги взяты, и звонок
        // обязан подорожать вместе с письмами: отдельной лестницы выдач
        // больше нет, поэтому рост берётся из daily_limit_for_token.
        let app = turn_app_state(keys());
        let tok = issue_install(&app.keys, now() as u32);
        let mut t = parse(&app.keys, &tok).expect("token parses");
        t.plan = Plan::Pro;
        t.paid_until = u32::MAX;
        assert_eq!(
            daily_limit_for_token(&t, app.free_daily_limit),
            Some(PRO_DAILY_LIMIT),
            "TURN тратит тот же порог, что и конверты"
        );
    }

    #[tokio::test]
    async fn turn_bez_limita_konvertov_ne_gasitsya_vypuskatellyom() {
        // free_daily_limit=0 — выключатель стенда: он снимает счётчик и с
        // выдач (тот же путь, что у publish), иначе на dev-стенде звонки
        // молча умрут после первой же проверки.
        let app = turn_app_state_with_limit(keys(), 0);
        let tok = issue_install(&app.keys, now() as u32);
        for i in 0..3 {
            assert_eq!(
                turn_issue(&app, &tok).await.status(),
                StatusCode::OK,
                "выдача №{} при выключенном лимите",
                i + 1
            );
        }
        assert!(app.daily_pub.lock().unwrap().is_empty());
    }
}
