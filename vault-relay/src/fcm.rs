//! FCM-v1 (HTTP v1) — доставка пуша-«будильника» на Android-клиент.
//!
//! Альтернатива ntfy-мосту (M2.3-b) для клиентов с FCM-токеном: пуш уходит
//! напрямую через Firebase, без стороннего ntfy-сервера. Пути ВЗАИМОИСКЛЮЧАЮЩИЕ
//! (см. relay_pub): тема с FCM-токеном получает FCM, остальные — ntfy.
//!
//! Ключи лежат в fcm-key.json (service-account от Firebase), путь — в
//! VAULT_FCM_KEY. Пусто/нет файла/битый файл → отправитель не создаётся
//! (сервер живёт на ntfy). Секреты в логи НЕ попадают: ни private_key, ни
//! выданный access_token, ни сам reg_token не логируются.
//!
//! Токен доступа — OAuth2 JWT-bearer, подписанный САМИМ сервис-аккаунтом
//! (RS256, PKCS#1 v1.5): POST https://oauth2.googleapis.com/token с
//! grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer. Кэшируется на
//! 55 минут (Google живёт час, запас на расхождение часов).

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::RsaPrivateKey;
use rsa::signature::{SignatureEncoding, Signer};
use serde::Deserialize;
use sha2::Sha256;

/// Токен доступа Google живёт 3600с; берём 55 минут — с запасом на дрейф часов
/// и на сетевые задержки, но с запасом же НЕ пересекаем expiry.
const TOKEN_TTL: Duration = Duration::from_secs(55 * 60);
/// Время жизни JWT-assertion (требование Google: exp ≤ 1 час).
const JWT_TTL_SECS: u64 = 3600;
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const FCM_SEND_URL: &str = "https://fcm.googleapis.com/v1/projects";
const SCOPE_MESSAGING: &str = "https://www.googleapis.com/auth/firebase.messaging";
const JWT_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/// Таймауты сетевого обмена: пуши — «тише ошибки», но и не должны висеть
/// вечно (вызывается из spawn_blocking, пул потоков не бесконечен).
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Ключи service-account (как в скачанном из Firebase Console fcm-key.json).
/// Имена полей стандартные, но принимаем и camelCase-вариант.
#[derive(Debug, Deserialize)]
struct KeyFile {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "clientEmail")]
    client_email: String,
    #[serde(alias = "privateKey")]
    private_key: String,
}

/// Кэшированный OAuth2-токен + момент протухания по локальным часам.
struct CachedToken {
    value: String,
    fresh_until: Instant,
}

/// Отправитель FCM-v1. `Send + Sync`: лежит в `AppState` (Arc) и используется
/// из пула blocking-потоков.
pub struct FcmSender {
    project_id: String,
    client_email: String,
    key: SigningKey<Sha256>,
    /// async-клиент: blocking-вариант reqwest паникует при создании внутри
    /// async-контекста (`#[tokio::main]`), а мы создаём отправителя именно там.
    http: reqwest::Client,
    /// Один токен на весь процесс: refresh-гонку сериализуем мьютексом.
    token: Mutex<Option<CachedToken>>,
}

/// Данные data-only пуша. Значения — строки (требование FCM: value в `data`
/// всегда строка), клиент сам рисует полноэкранный экран звонка.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallPush {
    /// Тип события: `call_request` (входящий звонок) или `message`.
    pub kind: &'static str,
    pub call_id: String,
    pub from: String,
    pub name: String,
    /// Счётчик непрочитанных конвертов у получателя (как у ntfy-заголовка).
    pub total: String,
    pub urgent: bool,
    /// URL рингтона из настроек получателя (тот же, что у ntfy Audio).
    pub ring: String,
    /// Deep-link: `vault://open` или `vault://open?chat=...`.
    pub click: String,
}

impl CallPush {
    /// Тело POST messages:send. Только `data` + `android.priority: high` —
    /// системной нотификации нет, клиент рисует экран сам (content-available).
    ///
    /// КЛЮЧ `sender`, А НЕ `from`: FCM зарезервировал `from` в data-payload
    /// и отвечает 400 «Invalid data payload key: from» на КАЖДЫЙ пуш
    /// (проверено на живом FCM API 30.09). Имя отправителя едет под `sender`;
    /// поле Rust `from` остаётся — переименован только ключ в JSON.
    fn to_send_body(&self, reg_token: &str) -> serde_json::Value {
        serde_json::json!({
            "message": {
                "token": reg_token,
                "android": { "priority": "high" },
                "data": {
                    "type": self.kind,
                    "call_id": self.call_id,
                    "sender": self.from,
                    "name": self.name,
                    "total": self.total,
                    "urgent": if self.urgent { "1" } else { "0" },
                    "ring": self.ring,
                    "click": self.click,
                }
            }
        })
    }
}

impl FcmSender {
    /// Создать отправителя из fcm-key.json. Любая проблема (нет файла, битый
    /// JSON, не RSA-ключ) — Err: вызывающий оставляет FCM выключенным.
    pub fn from_key_file(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
        Self::from_key_json(&raw)
    }

    /// Разобрать ключ из JSON-строки (тесты/инициализация без файловой FS).
    pub fn from_key_json(raw: &str) -> Result<Self, String> {
        let kf: KeyFile =
            serde_json::from_str(raw).map_err(|e| format!("invalid key json: {e}"))?;
        if kf.project_id.trim().is_empty()
            || kf.client_email.trim().is_empty()
            || kf.private_key.trim().is_empty()
        {
            return Err("key json: empty project_id/client_email/private_key".into());
        }
        // PEM из Firebase — PKCS#8 («BEGIN PRIVATE KEY»). Секрет в ошибку не
        // тащим: в Err уходит только фиксированный текст.
        let key = RsaPrivateKey::from_pkcs8_pem(&kf.private_key)
            .map_err(|_| "private_key is not a valid PKCS#8 RSA key".to_string())?;
        Ok(Self {
            project_id: kf.project_id.trim().to_string(),
            client_email: kf.client_email.trim().to_string(),
            key: SigningKey::<Sha256>::new(key),
            http: reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .map_err(|e| format!("http client: {e}"))?,
            token: Mutex::new(None),
        })
    }

    /// Инициализация из переменной окружения VAULT_FCM_KEY (путь к JSON).
    /// Пусто/нет файла/ошибка → None + tracing::warn: сервер продолжает
    /// работать на ntfy-мосте. Дефолтного пути НЕТ намеренно (секрет не должен
    /// подхватываться «нечаянно» из домашнего каталога).
    pub fn from_env() -> Option<Self> {
        let path = std::env::var("VAULT_FCM_KEY").unwrap_or_default();
        let path = path.trim();
        if path.is_empty() {
            tracing::info!("FCM: VAULT_FCM_KEY not set — FCM push disabled");
            return None;
        }
        match Self::from_key_file(Path::new(path)) {
            Ok(_s) => {
                // Ни путь, ни содержимое ключа в лог не идут — только факт вкл.
                tracing::info!("FCM: push enabled (service account loaded)");
                Some(_s)
            }
            Err(e) => {
                tracing::warn!(error = %e, "FCM: key load failed — FCM push disabled");
                None
            }
        }
    }

    /// Подписать JWT-assertion (RS256) для обмена на access_token.
    /// Три части через '.', каждая — base64url без паддинга.
    fn make_assertion(&self) -> Result<String, String> {
        let iat = unix_now();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = serde_json::json!({
            "iss": self.client_email,
            "scope": SCOPE_MESSAGING,
            "aud": "https://oauth2.googleapis.com/token",
            "iat": iat,
            "exp": iat + JWT_TTL_SECS,
        });
        let payload_json = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let signing_input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(payload_json));
        let sig = self.key.sign(signing_input.as_bytes());
        Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes())))
    }

    /// Текущий access_token: из кэша либо свежий обмен JWT→token.
    /// Кэш живёт 55 минут; при истечении — новый обмен.
    ///
    /// Мьютекс НЕ держится через await (иначе будущее не Send, и tokio::spawn
    /// в relay_pub не собрался бы): блокировка живёт только внутри
    /// `cached_token`, сетевая часть — уже без lock. Плата за это — при
    /// одновременном протухании возможен лишний обмен; на результат это не
    /// влияет (все получат один и тот же валидный токен).
    async fn access_token(&self) -> Result<String, String> {
        if let Some(t) = self.cached_token() {
            return Ok(t);
        }
        let assertion = self.make_assertion()?;
        let body = format!(
            "grant_type={}&assertion={}",
            urlencode(JWT_GRANT_TYPE),
            urlencode(&assertion)
        );
        let resp = self
            .http
            .post(TOKEN_URL)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("token exchange request: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Тело ошибки Google не содержит нашего секрета; access_token там
            // тоже не бывает — но логируем коротко и без заголовков.
            return Err(format!(
                "token exchange http {status}: {}",
                truncate(&text, 200)
            ));
        }
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("token exchange json: {e}"))?;
        let value = v
            .get("access_token")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "token exchange: no access_token in response".to_string())?
            .to_string();
        self.store_token(&value);
        Ok(value)
    }

    /// Прочитать кэш (синхронно — без await, guard не пересекает точку подвеса).
    fn cached_token(&self) -> Option<String> {
        let guard = self.token.lock().ok()?;
        guard
            .as_ref()
            .filter(|t| Instant::now() < t.fresh_until)
            .map(|t| t.value.clone())
    }

    fn store_token(&self, value: &str) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = Some(CachedToken {
                value: value.to_string(),
                fresh_until: Instant::now() + TOKEN_TTL,
            });
        }
    }

    /// Отправить один data-only пуш на reg_token. Err логируется вызывающим и
    /// НЕ фатален: конверт уже в очереди, клиент заберёт его poll'ом.
    async fn send_async(&self, reg_token: &str, push: &CallPush) -> Result<(), String> {
        let token = self.access_token().await?;
        let url = format!("{FCM_SEND_URL}/{}/messages:send", self.project_id);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&token)
            .header("content-type", "application/json")
            .body(push.to_send_body(reg_token).to_string())
            .send()
            .await
            .map_err(|e| format!("fcm request: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            // Ни access_token, ни reg_token в текст не попадают — диагностика.
            return Err(format!("fcm http {status}: {}", truncate(&text, 200)));
        }
        Ok(())
    }

    /// Отправить один data-only пуш на reg_token — публичная точка входа.
    ///
    /// Полностью async: вызывающий (relay_pub) делает `tokio::spawn`, поэтому
    /// сетевое ожидание не занимает воркер и НЕ требует block_on (тот внутри
    /// рантайма паникует). Err НЕ фатален: конверт уже в очереди, клиент
    /// заберёт его poll'ом — теряем только «будильник».
    pub async fn send(&self, reg_token: &str, push: &CallPush) -> Result<(), String> {
        self.send_async(reg_token, push).await
    }

    /// Только для тестов/диагностики: кэширован ли токен прямо сейчас.
    #[cfg(test)]
    pub fn has_cached_token(&self) -> bool {
        self.token
            .lock()
            .map(|g| g.as_ref().is_some_and(|t| Instant::now() < t.fresh_until))
            .unwrap_or(false)
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Минимальный percent-энкод для тела x-www-form-urlencoded: JWT и grant_type
/// содержат ':' и '.', которые в форме должны быть экранированы.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Обрезать диагностический текст (ответы Google не должны упираться в лог).
fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        return t.to_string();
    }
    let mut end = max;
    while end > 0 && !t.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &t[..end])
}

// ───────────────────────────── Тесты ─────────────────────────────
// Без сети и без чтения реальных файлов: ключ генерируется на лету
// (RSA-2048), пишется во временный файл, который затирается.
#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs1v15::{Signature, VerifyingKey};
    use rsa::pkcs8::{EncodePrivateKey, LineEnding};
    use rsa::signature::Verifier;
    use rsa::RsaPublicKey;

    /// Свежий RSA-ключ + содержимое fcm-key.json из него. Возвращает
    /// (json, public_key) — public нужен, чтобы проверить подпись.
    fn test_key_json() -> (String, RsaPublicKey) {
        let mut rng = rand::rngs::OsRng;
        let sk = RsaPrivateKey::new(&mut rng, 2048).expect("keygen");
        let pem = sk.to_pkcs8_pem(LineEnding::LF).expect("pem");
        let json = serde_json::json!({
            "type": "service_account",
            "project_id": "vault-test",
            "private_key": pem.as_str(),
            "client_email": "pusher@vault-test.iam.gserviceaccount.com",
        })
        .to_string();
        (json, RsaPublicKey::from(&sk))
    }

    fn sender() -> FcmSender {
        let (json, _pk) = test_key_json();
        FcmSender::from_key_json(&json).expect("sender from test key")
    }

    /// Отправитель ИЗ КОНКРЕТНОГО json — чтобы public-ключ в тесте был от
    /// того же ключа, которым подписан JWT (иначе verify бессмысленен).
    fn sender_from(json: &str) -> FcmSender {
        FcmSender::from_key_json(json).expect("sender from given key")
    }

    fn push() -> CallPush {
        CallPush {
            kind: "call_request",
            call_id: "env-42".into(),
            from: "anna@example.com".into(),
            name: "Anna".into(),
            total: "3".into(),
            urgent: true,
            ring: "https://vault-msg.ru/ring_incoming.mp3".into(),
            click: "vault://open?chat=anna%40example.com".into(),
        }
    }

    #[test]
    fn loads_service_account_json() {
        let s = sender();
        assert_eq!(s.project_id, "vault-test");
        assert_eq!(s.client_email, "pusher@vault-test.iam.gserviceaccount.com");
        assert!(!s.has_cached_token(), "токен до первого обмена не кэширован");
    }

    #[test]
    fn accepts_camel_case_aliases() {
        let (json, _pk) = test_key_json();
        let camel = json
            .replace("project_id", "projectId")
            .replace("client_email", "clientEmail")
            .replace("private_key", "privateKey");
        assert!(FcmSender::from_key_json(&camel).is_ok(), "camelCase-ключи читаются");
    }

    #[test]
    fn rejects_broken_key_material() {
        let missing = Path::new("/nonexistent/vault-relay/fcm-key.json");
        assert!(FcmSender::from_key_file(missing).is_err(), "нет файла → Err");
        assert!(FcmSender::from_key_json("not json").is_err());
        assert!(FcmSender::from_key_json("{}").is_err());
        let bad = r#"{"project_id":"p","client_email":"e@x","private_key":"nope"}"#;
        assert!(FcmSender::from_key_json(bad).is_err());
        let empty = r#"{"project_id":"p","client_email":"e@x","private_key":"   "}"#;
        assert!(FcmSender::from_key_json(empty).is_err());
    }

    #[test]
    fn loads_key_from_temp_file() {
        let (json, _pk) = test_key_json();
        let path = std::env::temp_dir().join(format!("vault-relay-fcm-test-{}.json", unix_now()));
        std::fs::write(&path, &json).expect("write temp key");
        let s = FcmSender::from_key_file(&path).expect("load from temp file");
        assert_eq!(s.project_id, "vault-test");
        // Приватный ключ во временном файле — обязательно снести.
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn assertion_is_rs256_jwt_with_expected_claims() {
        let (json, pk) = test_key_json();
        let s = sender_from(&json);
        let jwt = s.make_assertion().expect("assertion");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT = header.payload.signature");

        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).expect("b64 header"))
                .expect("header json");
        assert_eq!(header["alg"], "RS256");
        assert_eq!(header["typ"], "JWT");

        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).expect("b64 payload"))
                .expect("claims json");
        assert_eq!(claims["iss"], "pusher@vault-test.iam.gserviceaccount.com");
        assert_eq!(claims["aud"], "https://oauth2.googleapis.com/token");
        assert_eq!(claims["scope"], "https://www.googleapis.com/auth/firebase.messaging");
        let iat = claims["iat"].as_u64().expect("iat");
        let exp = claims["exp"].as_u64().expect("exp");
        assert_eq!(exp - iat, JWT_TTL_SECS, "exp = iat + 1ч");
        assert!(iat <= unix_now() + 5, "iat ≈ сейчас");

        // Подпись проверяем ПУБЛИЧНЫМ ключом: сервер подписал приватным.
        let sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).expect("b64 sig");
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        VerifyingKey::<Sha256>::new(pk)
            .verify(signing_input.as_bytes(), &Signature::try_from(sig_bytes.as_slice()).expect("sig"))
            .expect("RS256 signature must verify");
    }

    #[test]
    fn send_body_is_data_only_high_priority() {
        let body = push().to_send_body("reg-token-123");
        let msg = &body["message"];
        assert_eq!(msg["token"], "reg-token-123");
        assert_eq!(msg["android"]["priority"], "high");
        // Системной нотификации быть не должно — рисует клиент.
        assert!(msg.get("notification").is_none(), "notification не рисуем");
        let data = &msg["data"];
        assert_eq!(data["type"], "call_request");
        assert_eq!(data["call_id"], "env-42");
        assert_eq!(data["sender"], "anna@example.com");
        assert_eq!(data["name"], "Anna");
        assert_eq!(data["total"], "3");
        assert_eq!(data["urgent"], "1");
        assert_eq!(data["ring"], "https://vault-msg.ru/ring_incoming.mp3");
        assert_eq!(data["click"], "vault://open?chat=anna%40example.com");
        // FCM требует строковые значения в data
        for (k, v) in data.as_object().expect("data object") {
            assert!(v.is_string(), "data[{k}] должен быть строкой");
        }
    }

    #[test]
    fn non_urgent_push_is_flagged_zero() {
        let mut p = push();
        p.urgent = false;
        p.kind = "message";
        let body = p.to_send_body("reg");
        assert_eq!(body["message"]["data"]["urgent"], "0");
        assert_eq!(body["message"]["data"]["type"], "message");
    }

    #[test]
    fn urlencode_escapes_form_separators() {
        assert_eq!(
            urlencode(JWT_GRANT_TYPE),
            "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"
        );
        assert_eq!(urlencode("abc-_.~XYZ019"), "abc-_.~XYZ019");
        assert_eq!(urlencode("a+b/c"), "a%2Bb%2Fc");
    }

    #[test]
    fn truncate_is_utf8_safe() {
        assert_eq!(truncate("  коротко  ", 100), "коротко");
        let long = "я".repeat(100);
        let cut = truncate(&long, 51);
        assert!(cut.chars().count() <= 26, "режем по границе UTF-8: {cut:?}");
        assert!(cut.ends_with('…'));
    }

    #[tokio::test]
    async fn token_cache_lifecycle_is_locked() {
        let s = sender();
        assert!(!s.has_cached_token());
        // Кэшируем токен вручную (обмен с Google в тестах не делаем) и читаем
        // его обратно — второй вызов access_token обязан вернуть кэш.
        s.store_token("cached-access-token");
        assert!(s.has_cached_token());
        assert_eq!(
            s.access_token().await.expect("cached token"),
            "cached-access-token",
            "кэш отдаётся без сетевого обмена"
        );
        // Протухший токен кэшем не считается: читаемо только свежее.
        *s.token.lock().expect("lock") = Some(CachedToken {
            value: "stale".into(),
            fresh_until: Instant::now() - Duration::from_secs(1),
        });
        assert!(!s.has_cached_token());
        assert!(s.cached_token().is_none(), "протухший токен не отдаётся");
    }

    #[tokio::test]
    async fn send_is_async_and_never_panics() {
        // Реальной сети в тестах нет: проверяем, что путь отправки возвращает
        // Err (тихо), а НЕ паникует. Регрессия на «block_on внутри рантайма»
        // и на blocking-клиент reqwest, который паникует при создании в async.
        let s = sender();
        let res = s.send("reg-token", &push()).await;
        if let Err(e) = &res {
            assert!(!e.is_empty(), "ошибка должна быть описана");
        }
    }

    #[tokio::test]
    async fn send_survives_spawn_like_relay_pub_does() {
        // Ровно тот путь, который использует relay_pub: tokio::spawn с
        // Arc<FcmSender> внутри — «отправили и забыли», ошибка не фатальна.
        let s = std::sync::Arc::new(sender());
        let t = s.clone();
        let h = tokio::spawn(async move { t.send("reg-token", &push()).await });
        let res = h.await.expect("spawn must not panic");
        assert!(res.is_err() || res.is_ok()); // без сети — Err, но не паника
    }

    #[test]
    fn sender_is_shareable_across_threads() {
        // FcmSender лежит в Arc<AppState> и уходит в spawn_blocking.
        let s = std::sync::Arc::new(sender());
        let t = s.clone();
        let h = std::thread::spawn(move || {
            assert_eq!(t.project_id, "vault-test");
            assert!(t.make_assertion().is_ok());
        });
        h.join().expect("thread join");
    }
}

