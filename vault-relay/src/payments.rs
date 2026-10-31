//! Платёжный провайдер и платёжная сессия (чекаут) — шаги 4–5 плана
//! платных relay-токенов (docs/design/paid-tokens-spec.md §3, §7).
//!
//! ПОЧЕМУ ТАК. Сервер сам опрашивает провайдера и НЕ доверяет клиенту:
//! клиент может прислать «я заплатил» — это ничего не значит, пока
//! провайдер не подтвердил оплату. Поэтому проверка вынесена в провайдера, а
//! релей только спрашивает.
//!
//! ПРОВАЙДЕРЫ. `YkProvider` — ЮKassa (HTTP API v3, POST /payments): код
//! готов, живая оплата ждёт ключи магазинa (ИП + договор, канбан ORG-2;
//! ключи — только в `VAULT_RELAY_YOOKASSA_SHOPID`/`_SECRET_KEY`, не в коде).
//! Рабочий провайдер для приёмки без реальных платежей — `TestProvider`:
//! оплата подтверждается мгновенно, так выдаются ТЕСТОВЫЕ Pro-токены.
//! Остальные (`GpProvider`, `StripeProvider`) — заглушки, отвечающие
//! «недоступно»: клиент увидит честную ошибку, а не выдуманный успех.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::tokens::Plan;

/// Что пошло не так с оплатой. Каждый вариант — свой HTTP-код на маршруте.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentError {
    /// Провайдер не настроен или платежи выключены → 402.
    Unavailable,
    /// Оплата ещё не подтверждена → 402 not_paid_yet.
    NotPaidYet,
    /// Платёжная сессия истекла → 410.
    Expired,
    /// Провайдер отклонил платёж (текст — для показа пользователю).
    Rejected(String),
}

impl std::fmt::Display for PaymentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PaymentError::Unavailable => write!(f, "payment provider unavailable"),
            PaymentError::NotPaidYet => write!(f, "not paid yet"),
            PaymentError::Expired => write!(f, "checkout expired"),
            PaymentError::Rejected(why) => write!(f, "payment rejected: {why}"),
        }
    }
}

/// unix-секунды сейчас (в модуле — свой, чтобы payments не зависел от main).
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Запрос на создание платёжной сессии.
#[derive(Debug, Clone)]
pub struct CheckoutRequest {
    /// fingerprint покупателя.
    pub fp: String,
    /// Тариф: Pro или Business.
    pub plan: Plan,
    /// На сколько месяцев оплачивается (1 или 12).
    pub months: u32,
    /// Язык интерфейса платёжной страницы.
    pub lang: String,
}

/// Созданная платёжная сессия.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkout {
    /// Идентификатор сессии (co_…).
    pub id: String,
    /// Имя провайдера (test / yookassa / …).
    pub provider: String,
    /// Куда клиенту вести пользователя для оплаты.
    pub payment_url: String,
    /// Сколько секунд сессия действительна.
    pub expires_in: u64,
    /// unix-сек, до какого действует сессия.
    pub expires_at: u64,
    /// fingerprint покупателя: при верификации он обязан совпасть, иначе
    /// оплаченный чекаут можно было бы забрать чужому аккаунту.
    pub fp: String,
    /// Тариф.
    pub plan: Plan,
    /// Срок оплаты в месяцах.
    pub months: u32,
    /// unix-сек создания.
    pub created_at: u64,
    /// Идентификатор платежа У ПРОВАЙДЕРА (для ЮKassa — `id` платежа из
    /// `POST /payments`). Нужен, чтобы при verify спросить провайдера именно
    /// про этот платёж; у тестового провайдера пустой.
    #[serde(default)]
    pub provider_ref: String,
}

/// Статус оплаты по чекауту.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentStatus {
    Paid,
    Pending,
    Failed(String),
}

/// Строка списка платежей провайдера (ЮKassa `GET /payments`).
///
/// Источник истины для учёта денег: банковская выписка показывает только
/// сводную выплату, а каждый платёж виден здесь. Сумма — строкой, как её
/// отдаёт ЮKassa; разбор в копейки — в `accounting`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaymentRow {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub paid: bool,
    pub created_at: String,
    pub amount: PaymentAmount,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub test: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaymentAmount {
    pub value: String,
    pub currency: String,
}

/// Разбор ответа `GET /payments`: список строк, кривые записи отбрасываются.
///
/// Отсутствие `items` — ошибка провайдера, а не «платежей нет»: пустой учёт
/// при живой кассе опаснее честной ошибки (владелец решил бы, что доход 0).
pub fn parse_payments_list(body: &serde_json::Value) -> Result<Vec<PaymentRow>, PaymentError> {
    let items = body
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| PaymentError::Rejected("yookassa: no items in list".into()))?;
    Ok(items
        .iter()
        .filter_map(|it| serde_json::from_value::<PaymentRow>(it.clone()).ok())
        .collect())
}

/// Платёжный провайдер.
///
/// Реализация отвечает на два вопроса: «создай сессию оплаты» и «оплачено ли».
/// Всё остальное (идемпотентность, срок, выпуск токена) — на стороне релея.
/// Методы асинхронные (boxed-футур — провайдер живёт как `Arc<dyn …>`):
/// живой провайдер — HTTP-вызов на tokio, блокирующий клиент внутри
/// async-обработчика устроил бы дедлок рантайма.
pub trait PaymentProvider: Send + Sync {
    /// Имя провайдера (показывается клиенту и попадает в логи).
    fn name(&self) -> &str;
    /// Создать платёжную сессию.
    fn create_checkout<'a>(
        &'a self,
        req: &'a CheckoutRequest,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Checkout, PaymentError>> + Send + 'a>>;
    /// Проверить статус оплаты по чекауту.
    fn verify<'a>(
        &'a self,
        checkout: &'a Checkout,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<PaymentStatus, PaymentError>> + Send + 'a>>;
    /// Список платежей для учёта (свежие первыми). По умолчанию — недоступно:
    /// тестовый провайдер денег не принимает, и выдумывать ему список нельзя.
    fn list_payments<'a>(
        &'a self,
        limit: u32,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Vec<PaymentRow>, PaymentError>> + Send + 'a>> {
        let _ = limit;
        Box::pin(async move { Err(PaymentError::Unavailable) })
    }
}

/// Тестовый провайдер: оплата подтверждается МГНОВЕННО.
///
/// Нужен, чтобы выдавать тестовые Pro-токены без реального платёжного
/// провайдера (ЮKassa/Google Play/Stripe требуют ИП, которого пока нет —
/// см. канбан ORG-2). Реальный провайдер подключается заменой этого типа на
/// реализацию с HTTP-вызовом API платёжной системы.
pub struct TestProvider {
    /// Выданные чекауты: id → создан.
    issued: Mutex<HashMap<String, bool>>,
}

impl TestProvider {
    pub fn new() -> Self {
        Self {
            issued: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for TestProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl PaymentProvider for TestProvider {
    fn name(&self) -> &str {
        "test"
    }

    fn create_checkout<'a>(
        &'a self,
        req: &'a CheckoutRequest,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Checkout, PaymentError>> + Send + 'a>> {
        Box::pin(async move {
            let id = format!("co_test_{}", uuid::Uuid::new_v4().simple());
            self.issued
                .lock()
                .expect("issued lock")
                .insert(id.clone(), true);
            let now = now_unix();
            Ok(Checkout {
                id,
                provider: self.name().to_string(),
                payment_url: format!("vault-relay://pay/test/{}", req.fp),
                expires_in: 1800,
                expires_at: now + 1800,
                fp: req.fp.clone(),
                plan: req.plan,
                months: req.months,
                created_at: now,
                provider_ref: String::new(),
            })
        })
    }

    fn verify<'a>(
        &'a self,
        checkout: &'a Checkout,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<PaymentStatus, PaymentError>> + Send + 'a>>
    {
        Box::pin(async move {
            let issued = self.issued.lock().expect("issued lock");
            match issued.get(&checkout.id) {
                Some(_) => Ok(PaymentStatus::Paid),
                None => Ok(PaymentStatus::Pending),
            }
        })
    }
}

/// Провайдер-заглушка: платежи выключены (нет ИП/ключей).
///
/// Отвечает «недоступно», а не «одобрить»: клиент должен честно увидеть, что
/// оплата невозможна, а не получить токен, за который никто не заплатил.
pub struct UnavailableProvider {
    name: String,
}

impl UnavailableProvider {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }
}

impl PaymentProvider for UnavailableProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn create_checkout<'a>(
        &'a self,
        _req: &'a CheckoutRequest,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Checkout, PaymentError>> + Send + 'a>> {
        Box::pin(std::future::ready(Err(PaymentError::Unavailable)))
    }

    fn verify<'a>(
        &'a self,
        _checkout: &'a Checkout,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<PaymentStatus, PaymentError>> + Send + 'a>>
    {
        Box::pin(std::future::ready(Err(PaymentError::Unavailable)))
    }
}

/// Транспорт одного HTTP-обмена: запрос + базовая авторизация → тело ответа.
///
/// Выделен в тип, чтобы YkProvider можно было тестировать без сети: живой
/// клиент — `ReqwestYkHttp`, в тестах — заглушка с заготовленным ответом.
/// Boxed-футур намеренно: транспорт держится как `Arc<dyn YkHttp>` —
/// объектная безопасность важнее лишнего allocation на обмен.
pub trait YkHttp: Send + Sync {
    fn send<'a>(
        &'a self,
        method: &'a str,
        url: &'a str,
        user: &'a str,
        password: &'a str,
        idempotence_key: Option<&'a str>,
        json_body: Option<serde_json::Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(u16, serde_json::Value), String>> + Send + 'a>>;
}

/// Живой транспорт на reqwest (rustls-tls, без system-SSL).
pub struct ReqwestYkHttp {
    client: reqwest::Client,
}

impl ReqwestYkHttp {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for ReqwestYkHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl YkHttp for ReqwestYkHttp {
    fn send<'a>(
        &'a self,
        method: &'a str,
        url: &'a str,
        user: &'a str,
        password: &'a str,
        idempotence_key: Option<&'a str>,
        json_body: Option<serde_json::Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(u16, serde_json::Value), String>> + Send + 'a>> {
        Box::pin(async move {
            let mut req = self
                .client
                .request(
                    reqwest::Method::from_bytes(method.as_bytes())
                        .map_err(|e| format!("bad method: {e}"))?,
                    url,
                )
                .basic_auth(user, Some(password));
            if let Some(k) = idempotence_key {
                req = req.header("Idempotence-Key", k);
            }
            if let Some(body) = json_body {
                req = req.json(&body);
            }
            let resp = req.send().await.map_err(|e| format!("http: {e}"))?;
            let status = resp.status().as_u16();
            let body = resp.json::<serde_json::Value>().await.map_err(|e| format!("json: {e}"))?;
            Ok((status, body))
        })
    }
}

/// ЮKassa, HTTP API v3 (docs.design/paid-tokens-spec.md §7, шаг 5).
///
/// КОД ГОТОВ, ЖИВЫХ КЛЮЧЕЙ НЕТ: shopId и секрет приходят после ИП и договора
/// (канбан ORG-2) в `VAULT_RELAY_YOOKASSA_SHOPID`/`VAULT_RELAY_YOOKASSA_SECRET_KEY`
/// — в код и в чат они НЕ попадают. Цена считается ЗДЕСЬ по плану/сроку
/// (§2: Pro 149 ₽/мес, 1490 ₽/год; Business 499/4990) — с клиента приходит
/// только план, сумму клиент не задаёт.
///
/// Статус-коды ЮKassa → наш контракт: 200 → состояние платежа; 204 (платежа
/// ещё нет) → NotPaidYet; 401/404/иное → Unavailable/Rejected — честный
/// отказ, а не молчаливый «не оплачено».
pub struct YkProvider {
    shop_id: String,
    secret: String,
    api_base: String,
    /// Публичный базовый URL релея — туда возвращаем платёж после оплаты
    /// (`return_url`). Абсолютный адрес требует провайдер, поэтому без него
    /// провайдер не собирается.
    return_base: String,
    http: std::sync::Arc<dyn YkHttp + Send + Sync>,
}

impl YkProvider {
    /// Живой провайдер из переменных окружения. Без ключей — Err: конфигурить
    /// полупровидный провайдер хуже, чем честно оставить платежи выключенными.
    pub fn from_env() -> Result<Self, String> {
        let shop_id = std::env::var("VAULT_RELAY_YOOKASSA_SHOPID").unwrap_or_default();
        let secret = std::env::var("VAULT_RELAY_YOOKASSA_SECRET_KEY").unwrap_or_default();
        if shop_id.trim().is_empty() || secret.trim().is_empty() {
            return Err("VAULT_RELAY_YOOKASSA_SHOPID/_SECRET_KEY not set".to_string());
        }
        let return_base = std::env::var("VAULT_RELAY_PUBLIC_URL").unwrap_or_default();
        if return_base.trim().is_empty() {
            return Err("VAULT_RELAY_PUBLIC_URL not set (return_url must be absolute)".to_string());
        }
        let base = std::env::var("VAULT_RELAY_YOOKASSA_API")
            .unwrap_or_else(|_| "https://api.yookassa.ru/v3".to_string());
        Ok(Self::with_http(
            shop_id.trim().to_string(),
            secret.trim().to_string(),
            base.trim_end_matches('/').to_string(),
            return_base.trim_end_matches('/').to_string(),
            std::sync::Arc::new(ReqwestYkHttp::new()),
        ))
    }

    /// Сборка с инъекцией транспорта (тесты подменяют `http`).
    pub fn with_http(
        shop_id: String,
        secret: String,
        api_base: String,
        return_base: String,
        http: std::sync::Arc<dyn YkHttp + Send + Sync>,
    ) -> Self {
        Self {
            shop_id,
            secret,
            api_base,
            return_base,
            http,
        }
    }

    /// Цена в копейках (ЮKassa требует целые копейки). @paid-tokens-spec §2.
    pub fn amount_kopecks(plan: Plan, months: u32) -> u64 {
        let rub_month: u64 = match plan {
            Plan::Pro => 149,
            Plan::Business => 499,
            // Free/Trial не продаются (маршрут их отсекает); если долетело —
            // считаем по Pro: завысить цену безопаснее, чем продать дешевле.
            _ => 149,
        };
        let total = if months >= 12 {
            rub_month * 10 // год со скидкой: 12 мес по цене 10
        } else {
            rub_month * months as u64
        };
        total * 100
    }
}

/// Что вообще можно купить и на какой срок. ЕДИНЫЙ источник и для витрины
/// (`/relay/plans`), и для проверки чекаута: периода, которого нет здесь,
/// клиент не увидит, а реле не примет к оплате — так витрина и касса не
/// разъезжаются (иначе можно показать срок, за который нельзя заплатить).
pub const PURCHASABLE_MONTHS: [u32; 5] = [1, 3, 6, 9, 12];

/// Витрина тарифов Pro для клиента. Цена — ровно `amount_kopecks`, поэтому
/// показанное в приложении и списанное ЮKassa — одно и то же число (ADR-005:
/// цену считает Rust, JS лишь рисует ответ сервера, своей цены у клиента нет).
pub fn pro_catalog() -> Vec<serde_json::Value> {
    PURCHASABLE_MONTHS
        .iter()
        .map(|&months| {
            let kopecks = YkProvider::amount_kopecks(Plan::Pro, months);
            serde_json::json!({
                "plan": "pro",
                "months": months,
                "kopecks": kopecks,
                "amount": format!("{:.2}", kopecks as f64 / 100.0),
                "currency": "RUB",
            })
        })
        .collect()
}

impl PaymentProvider for YkProvider {
    fn name(&self) -> &str {
        "yookassa"
    }

    fn create_checkout<'a>(
        &'a self,
        req: &'a CheckoutRequest,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Checkout, PaymentError>> + Send + 'a>> {
        let id = format!("co_{}", uuid::Uuid::new_v4().simple());
        let amount = Self::amount_kopecks(req.plan, req.months);
        let body = serde_json::json!({
            "amount": { "value": format!("{}", amount / 100), "currency": "RUB" },
            "capture": true,
            "confirmation": {
                "type": "redirect",
                "return_url": format!("{}/pay-return/{}?lang={}", self.return_base, id, req.lang),
            },
            "description": format!("Vault {}: {} мес", format!("{:?}", req.plan).to_lowercase(), req.months),
            "metadata": { "checkout_id": id },
        });
        let shop_id = self.shop_id.clone();
        let secret = self.secret.clone();
        let url = format!("{}/payments", self.api_base);
        let fp = req.fp.clone();
        let plan = req.plan;
        let months = req.months;
        let http = &*self.http;
        Box::pin(async move {
        let (status, resp) = http
            .send(
                "POST",
                &url,
                &shop_id,
                &secret,
                Some(&id),
                Some(body),
            )
            .await
            .map_err(PaymentError::Rejected)?;
        if status != 200 {
            return Err(match status {
                401 | 403 => PaymentError::Unavailable,
                429 => PaymentError::Rejected("too many requests".into()),
                other => PaymentError::Rejected(format!("yookassa create: HTTP {other}")),
            });
        }
        let payment_id = resp.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let confirmation_url = resp
            .get("confirmation")
            .and_then(|c| c.get("confirmation_url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if payment_id.is_empty() || confirmation_url.is_empty() {
            return Err(PaymentError::Rejected(
                "yookassa: no confirmation url in response".into(),
            ));
        }
        let now = now_unix();
        Ok(Checkout {
            id,
            provider: "yookassa".to_string(),
            payment_url: confirmation_url.to_string(),
            expires_in: 1800,
            expires_at: now + 1800,
            fp,
            plan,
            months,
            created_at: now,
            provider_ref: payment_id.to_string(),
        })
        })
    }

    fn verify<'a>(
        &'a self,
        checkout: &'a Checkout,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<PaymentStatus, PaymentError>> + Send + 'a>>
    {
        if checkout.provider_ref.is_empty() {
            // Ни одного успешного create — спрашивать провайдера не про что.
            return Box::pin(std::future::ready(Err(PaymentError::Unavailable)));
        }
        let url = format!("{}/payments/{}", self.api_base, checkout.provider_ref);
        let http = &*self.http;
        Box::pin(async move {
        let (status, resp) = http
            .send("GET", &url, &self.shop_id, &self.secret, None, None)
            .await
            .map_err(PaymentError::Rejected)?;
        match status {
            200 => {
                let s = resp.get("status").and_then(|v| v.as_str()).unwrap_or("");
                match s {
                    "succeeded" => Ok(PaymentStatus::Paid),
                    "pending" | "in_progress" => Ok(PaymentStatus::Pending),
                    other => Ok(PaymentStatus::Failed(format!("status={other}"))),
                }
            }
            // 204 — платёж ещё не существует у провайдера: не оплачено.
            204 => Err(PaymentError::NotPaidYet),
            401 | 404 => Err(PaymentError::Unavailable),
            other => Err(PaymentError::Rejected(format!("yookassa verify: HTTP {other}"))),
        }
        })
    }

    fn list_payments<'a>(
        &'a self,
        limit: u32,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Vec<PaymentRow>, PaymentError>> + Send + 'a>>
    {
        let limit = limit.clamp(1, 100);
        let url = format!("{}/payments?limit={}", self.api_base, limit);
        let http = &*self.http;
        Box::pin(async move {
            let (status, resp) = http
                .send("GET", &url, &self.shop_id, &self.secret, None, None)
                .await
                .map_err(PaymentError::Rejected)?;
            match status {
                200 => parse_payments_list(&resp),
                401 | 403 | 404 => Err(PaymentError::Unavailable),
                other => Err(PaymentError::Rejected(format!("yookassa list: HTTP {other}"))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn req(plan: Plan, months: u32) -> CheckoutRequest {
        CheckoutRequest {
            fp: "fp-alice".into(),
            plan,
            months,
            lang: "ru".into(),
        }
    }

    #[tokio::test]
    async fn test_provider_creates_checkout_with_expiry() {
        let p = TestProvider::new();
        let c = p.create_checkout(&req(Plan::Pro, 1)).await.expect("чекаут создан");
        assert!(c.id.starts_with("co_test_"), "ид чеката: {}", c.id);
        assert_eq!(c.provider, "test");
        assert_eq!(c.plan, Plan::Pro);
        assert_eq!(c.months, 1);
        assert!(c.expires_at > c.created_at, "срок чеката должен быть в будущем");
        assert_eq!(c.expires_at - c.created_at, 1800);
    }

    #[tokio::test]
    async fn test_provider_confirms_paid_immediately() {
        let p = TestProvider::new();
        let c = p.create_checkout(&req(Plan::Pro, 12)).await.expect("чекаут создан");
        assert_eq!(
            p.verify(&c).await.expect("verify"),
            PaymentStatus::Paid,
            "тестовый провайдер подтверждает оплату сразу"
        );
    }

    #[tokio::test]
    async fn test_provider_does_not_confirm_unknown_checkout() {
        let p = TestProvider::new();
        let mut c = p
            .create_checkout(&req(Plan::Pro, 1))
            .await
            .expect("чекаут создан");
        c.id = "co_test_несуществующий".into();
        assert_eq!(
            p.verify(&c).await.expect("verify"),
            PaymentStatus::Pending,
            "неизданный чекаут не оплачен"
        );
    }

    #[tokio::test]
    async fn test_unavailable_provider_refuses() {
        let p = UnavailableProvider::new("yookassa");
        assert_eq!(p.name(), "yookassa");
        assert!(
            matches!(
                p.create_checkout(&req(Plan::Pro, 1)).await,
                Err(PaymentError::Unavailable)
            ),
            "без ИП провайдер честно отказывает"
        );
        let c = Checkout {
            id: "co_x".into(),
            provider: "yookassa".into(),
            payment_url: String::new(),
            expires_in: 1800,
            expires_at: 0,
            fp: "fp".into(),
            plan: Plan::Pro,
            months: 1,
            created_at: 0,
            provider_ref: String::new(),
        };
        assert_eq!(p.verify(&c).await, Err(PaymentError::Unavailable));
    }

    /// Транспорт-заглушка: ОТДЕЛЬНЫЙ заготовленный ответ на POST (create) и
    /// на GET (verify) — один вызов не съедает ответ другого; GET повторяет
    /// последний ответ. Запоминает запросы для проверок.
    struct FakeYkHttp {
        post_reply: Mutex<Option<(u16, serde_json::Value)>>,
        get_replies: Mutex<VecDeque<(u16, serde_json::Value)>>,
        pub_calls: Mutex<Vec<(String, String, Option<String>, Option<serde_json::Value>)>>,
    }

    impl FakeYkHttp {
        fn new(replies: Vec<(u16, serde_json::Value)>) -> Self {
            let mut q = VecDeque::from(replies);
            Self {
                post_reply: Mutex::new(q.pop_front()),
                get_replies: Mutex::new(q),
                pub_calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl YkHttp for FakeYkHttp {
        fn send<'a>(
            &'a self,
            method: &'a str,
            url: &'a str,
            _user: &'a str,
            _password: &'a str,
            idempotence_key: Option<&'a str>,
            json_body: Option<serde_json::Value>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(u16, serde_json::Value), String>> + Send + 'a>,
        > {
            Box::pin(async move {
                self.pub_calls.lock().unwrap().push((
                    method.to_string(),
                    url.to_string(),
                    idempotence_key.map(str::to_string),
                    json_body,
                ));
                if method == "POST" {
                    return self
                        .post_reply
                        .lock()
                        .unwrap()
                        .clone()
                        .ok_or_else(|| "no POST reply".to_string());
                }
                let mut q = self.get_replies.lock().unwrap();
                if q.len() > 1 {
                    Ok(q.pop_front().unwrap())
                } else {
                    q.front()
                        .cloned()
                        .ok_or_else(|| "no GET reply".to_string())
                }
            })
        }
    }

    fn yk(replies: Vec<(u16, serde_json::Value)>) -> (YkProvider, std::sync::Arc<FakeYkHttp>) {
        // Один Arc на провайдер и тест: заглушка видит те же вызовы,
        // которые проверяет тест.
        let fake = std::sync::Arc::new(FakeYkHttp::new(replies));
        let p = YkProvider::with_http(
            "shop".into(),
            "secret".into(),
            "https://api.example.test/v3".into(),
            "https://relay.example.test".into(),
            fake.clone(),
        );
        (p, fake)
    }

    /// Заглушка под list_payments: ответы только на GET (POST не нужен).
    fn yk_get(
        replies: Vec<(u16, serde_json::Value)>,
    ) -> (YkProvider, std::sync::Arc<FakeYkHttp>) {
        let fake = std::sync::Arc::new(FakeYkHttp {
            post_reply: Mutex::new(None),
            get_replies: Mutex::new(VecDeque::from(replies)),
            pub_calls: Mutex::new(Vec::new()),
        });
        let p = YkProvider::with_http(
            "shop".into(),
            "secret".into(),
            "https://api.example.test/v3".into(),
            "https://relay.example.test".into(),
            fake.clone(),
        );
        (p, fake)
    }

    #[tokio::test]
    async fn yk_create_checkout_posts_amount_and_keeps_payment_ref() {
        let (p, calls) = yk(vec![(
            200,
            serde_json::json!({
                "id": "pay_001",
                "confirmation": { "confirmation_url": "https://yandex.money/pay/001" },
            }),
        )]);
        let c = p.create_checkout(&req(Plan::Pro, 1)).await.expect("чекаут");
        assert_eq!(c.provider, "yookassa");
        assert_eq!(c.provider_ref, "pay_001", "платёж провайдера запоминается");
        assert_eq!(c.payment_url, "https://yandex.money/pay/001");
        assert!(c.id.starts_with("co_") && !c.id.starts_with("co_test_"));
        let (method, url, idem, body) = &calls.pub_calls.lock().unwrap()[0];
        assert_eq!(method, "POST");
        assert_eq!(url, "https://api.example.test/v3/payments");
        assert_eq!(idem.as_deref(), Some(c.id.as_str()), "идемпотентность = наш id чекаута");
        let body = body.as_ref().expect("тело POST /payments");
        assert_eq!(body["amount"]["value"], "149", "Pro/мес — 149 ₽");
        assert_eq!(body["amount"]["currency"], "RUB");
        // Немедленный захват: без capture провайдер только авторизует деньги,
        // а статус никогда не дойдёт до succeeded — подписка не выдаётся.
        assert_eq!(body["capture"], serde_json::json!(true), "capture должен быть true");
        // Срок чекаута: 30 минут от создания (иначе «оплачу завтра» / «истёк сразу»).
        assert!(c.expires_at > c.created_at, "чекаут протух в момент создания");
        assert_eq!(c.expires_at - c.created_at, 1800);
        assert_eq!(c.expires_in, 1800);
        assert_eq!(
            body["confirmation"]["return_url"]
                .as_str()
                .unwrap()
                .strip_suffix(&format!("{}?lang=ru", c.id))
                .unwrap_or_default(),
            "https://relay.example.test/pay-return/",
            "возврат — на публичный URL релея"
        );
    }

    #[tokio::test]
    async fn yk_list_payments_reads_items_and_skips_broken_rows() {
        let (p, calls) = yk_get(vec![(
            200,
            serde_json::json!({
                "items": [
                    {
                        "id": "pay_1",
                        "status": "succeeded",
                        "paid": true,
                        "created_at": "2026-10-31T06:45:44.123Z",
                        "amount": { "value": "149.00", "currency": "RUB" },
                        "description": "Vault pro: 1 мес",
                        "test": false,
                    },
                    {
                        "id": "pay_2",
                        "status": "pending",
                        "paid": false,
                        "created_at": "2026-10-31T06:47:53.187Z",
                        "amount": { "value": "149.00", "currency": "RUB" },
                        "description": "Vault pro: 1 мес",
                    },
                    { "id": "broken_without_amount", "status": "canceled" },
                ],
            }),
        )]);
        let rows = p.list_payments(50).await.expect("список платежей");
        assert_eq!(rows.len(), 2, "кривая запись отброшена, остальные прочитаны");
        assert_eq!(rows[0].id, "pay_1");
        assert!(rows[0].paid);
        assert_eq!(rows[0].amount.value, "149.00");
        assert_eq!(rows[1].status, "pending");
        let (method, url, _, _) = &calls.pub_calls.lock().unwrap()[0];
        assert_eq!(method, "GET");
        assert_eq!(url, "https://api.example.test/v3/payments?limit=50");
    }

    #[tokio::test]
    async fn yk_list_payments_without_items_is_error_not_empty() {
        let (p, _) = yk_get(vec![(200, serde_json::json!({ "type": "list" }))]);
        assert!(
            matches!(p.list_payments(10).await, Err(PaymentError::Rejected(_))),
            "пустой учёт при живой кассе опаснее ошибки"
        );
        let (p401, _) = yk_get(vec![(401, serde_json::json!({}))]);
        assert_eq!(
            p401.list_payments(10).await,
            Err(PaymentError::Unavailable),
            "неверные ключи — не «платежей нет»"
        );
    }

    #[tokio::test]
    async fn yk_list_limit_is_clamped() {
        let (p, calls) = yk_get(vec![(200, serde_json::json!({ "items": [] }))]);
        let _ = p.list_payments(5000).await;
        let (_, url, _, _) = &calls.pub_calls.lock().unwrap()[0];
        assert_eq!(url, "https://api.example.test/v3/payments?limit=100");
    }

    #[tokio::test]
    async fn yk_amounts_follow_price_table() {
        assert_eq!(YkProvider::amount_kopecks(Plan::Pro, 1), 14_900);
        assert_eq!(YkProvider::amount_kopecks(Plan::Pro, 12), 149_000);
        assert_eq!(YkProvider::amount_kopecks(Plan::Business, 1), 49_900);
        assert_eq!(YkProvider::amount_kopecks(Plan::Business, 12), 499_000);
        // Непродаваемые тарифы не должны становиться «бесплатными»: маршрут
        // их отсекает, а нулевая цена в теле платежа — это проданная подписка за 0.
        assert_eq!(YkProvider::amount_kopecks(Plan::Free, 1), 14_900);
        assert_eq!(YkProvider::amount_kopecks(Plan::Trial, 1), 14_900);
    }

    #[test]
    fn pro_catalog_matches_kassa() {
        // Витрина = касса: только сроки из PURCHASABLE_MONTHS и цена ровно из
        // amount_kopecks. Разъезд здесь — обещание в приложении, которое платёж
        // не исполнит, либо срок, который вообще нельзя купить.
        assert_eq!(PURCHASABLE_MONTHS, [1, 3, 6, 9, 12]);
        let cat = pro_catalog();
        assert_eq!(cat.len(), 5, "витрина обязана предлагать ровно покупаемые сроки");
        for row in &cat {
            let months = row["months"].as_u64().unwrap() as u32;
            assert!(
                PURCHASABLE_MONTHS.contains(&months),
                "витрина предлагает некупый срок {months}"
            );
            assert_eq!(
                row["kopecks"].as_u64().unwrap(),
                YkProvider::amount_kopecks(Plan::Pro, months),
                "цена витрины ≠ касса для {months} мес"
            );
            assert_eq!(row["plan"], "pro");
            assert_eq!(row["currency"], "RUB");
        }
        // Конкретные числа живого платёжа: месяц 149 ₽, 3/6/9 — по 149·n,
        // год 1490 ₽ (единственный срок со скидкой ×10).
        assert_eq!(cat[0]["amount"], "149.00");
        assert_eq!(cat[1]["amount"], "447.00");
        assert_eq!(cat[2]["amount"], "894.00");
        assert_eq!(cat[3]["amount"], "1341.00");
        assert_eq!(cat[4]["amount"], "1490.00");
    }

    fn checkout_with_ref(ref_: &str) -> Checkout {
        Checkout {
            id: "co_1".into(),
            provider: "yookassa".into(),
            payment_url: "https://x".into(),
            expires_in: 1800,
            expires_at: 100,
            fp: "fp".into(),
            plan: Plan::Pro,
            months: 1,
            created_at: 1,
            provider_ref: ref_.into(),
        }
    }

    #[tokio::test]
    async fn yk_verify_maps_status() {
        // Первый ответ — POST (create), второй — GET (verify).
        let (p, calls) = yk(vec![
            (
                200,
                serde_json::json!({
                    "id": "pay_001",
                    "confirmation": { "confirmation_url": "https://ym/pay/001" },
                }),
            ),
            (200, serde_json::json!({ "id": "pay_001", "status": "succeeded" })),
        ]);
        let c = p.create_checkout(&req(Plan::Pro, 1)).await.unwrap();
        assert_eq!(p.verify(&c).await.unwrap(), PaymentStatus::Paid);
        // Ссылка на платёж берётся из provider_ref: GET — по id платежа.
        assert_eq!(
            calls.pub_calls.lock().unwrap()[1].1,
            "https://api.example.test/v3/payments/pay_001",
            "verify спрашивает именно платёж из provider_ref"
        );
        // 204 (платежа ещё нет) — честное not_paid_yet.
        let (p2, _calls2) = yk(vec![
            (
                200,
                serde_json::json!({
                    "id": "pay_001",
                    "confirmation": { "confirmation_url": "https://ym/pay/001" },
                }),
            ),
            (204, serde_json::json!({})),
        ]);
        assert_eq!(p2.verify(&c).await, Err(PaymentError::NotPaidYet));
    }

    #[tokio::test]
    async fn yk_verify_canceled_is_failed_not_paid() {
        let (p, _calls) = yk(vec![
            (200, serde_json::json!({})),
            (
                200,
                serde_json::json!({ "id": "pay_001", "status": "canceled" }),
            ),
        ]);
        let c = checkout_with_ref("pay_001");
        assert!(matches!(
            p.verify(&c).await.unwrap(),
            PaymentStatus::Failed(s) if s.contains("canceled")
        ));
    }

    #[tokio::test]
    async fn yk_verify_without_payment_ref_refuses() {
        let (p, _calls) = yk(vec![
            (200, serde_json::json!({})),
            (200, serde_json::json!({ "status": "succeeded" })),
        ]);
        let c = checkout_with_ref("");
        assert_eq!(p.verify(&c).await, Err(PaymentError::Unavailable));
        assert!(
            p.create_checkout(&req(Plan::Pro, 1)).await.is_err(),
            "POST-заглушка не съедена verify: create тоже работает"
        );
    }

    #[tokio::test]
    async fn yk_http_errors_are_honest() {
        // 401 — ключи негодны: «провайдер недоступен», а не «не оплачено».
        let (p, _c) = yk(vec![(401, serde_json::json!({}))]);
        assert!(matches!(
            p.create_checkout(&req(Plan::Pro, 1)).await,
            Err(PaymentError::Unavailable)
        ));
        // 500 на create — отклонение с текстом, клиент видит причину.
        let (p, _c) = yk(vec![(500, serde_json::json!({ "description": "boom" }))]);
        assert!(matches!(
            p.create_checkout(&req(Plan::Pro, 1)).await,
            Err(PaymentError::Rejected(s)) if s.contains("500")
        ));
        // 200 без confirmation_url — не выдумываем успех.
        let (p, _c) = yk(vec![(200, serde_json::json!({ "id": "pay_x" }))]);
        assert!(matches!(
            p.create_checkout(&req(Plan::Pro, 1)).await,
            Err(PaymentError::Rejected(s)) if s.contains("confirmation")
        ));
    }

    #[tokio::test]
    async fn yk_status_codes_and_provider_statuses_are_not_confused() {
        // 429 на create — «повтори позже» как отклонение с текстом, а не
        // недоступность: по Unavailable клиент гасит релей, а тут достаточно
        // просто повторить запрос.
        let (p, _c) = yk(vec![(429, serde_json::json!({}))]);
        assert!(matches!(
            p.create_checkout(&req(Plan::Pro, 1)).await,
            Err(PaymentError::Rejected(s)) if s.contains("many")
        ));
        // 200 со ссылкой подтверждения, но БЕЗ id платежа: спрашивать провайдера
        // потом не о чём — это отказ, а не чекаут.
        let (p, _c) = yk(vec![(
            200,
            serde_json::json!({ "confirmation": { "confirmation_url": "https://ym/pay/1" } }),
        )]);
        assert!(matches!(
            p.create_checkout(&req(Plan::Pro, 1)).await,
            Err(PaymentError::Rejected(_))
        ));
        // pending/in_progress у провайдера — ещё не оплата (токен не выдаётся).
        for s in ["pending", "in_progress"] {
            let (p, _c) = yk(vec![
                (200, serde_json::json!({})),
                (200, serde_json::json!({ "id": "pay_001", "status": s })),
            ]);
            assert_eq!(
                p.verify(&checkout_with_ref("pay_001")).await.unwrap(),
                PaymentStatus::Pending,
                "статус провайдера {s} не считается оплатой"
            );
        }
        // 401/404 на verify — недоступность, а не «платёж идёт».
        for code in [401u16, 404] {
            let (p, _c) = yk(vec![(200, serde_json::json!({})), (code, serde_json::json!({}))]);
            assert_eq!(
                p.verify(&checkout_with_ref("pay_001")).await,
                Err(PaymentError::Unavailable),
                "HTTP {code} на verify не должен выглядеть как ожидание оплаты"
            );
        }
    }

    #[test]
    fn yk_checkout_roundtrip_keeps_provider_ref() {
        // provider_ref переживает сериализацию: чекаут живёт в хранилище
        // релея (JSON) между create и verify, в том числе после рестарта.
        let mut c = Checkout {
            id: "co_1".into(),
            provider: "yookassa".into(),
            payment_url: "https://x".into(),
            expires_in: 1800,
            expires_at: 100,
            fp: "fp".into(),
            plan: Plan::Pro,
            months: 12,
            created_at: 1,
            provider_ref: "pay_42".into(),
        };
        let json = serde_json::to_string(&c).unwrap();
        c.provider_ref = String::new();
        let back: Checkout = serde_json::from_str(&json).unwrap();
        assert_eq!(back.provider_ref, "pay_42");
        // Старый сохранённый чекаут без поля читается (серде-дефолт).
        let old: Checkout =
            serde_json::from_str(r#"{"id":"co","provider":"test","payment_url":"","expires_in":0,"expires_at":0,"fp":"f","plan":"Pro","months":1,"created_at":0}"#)
                .unwrap();
        assert!(old.provider_ref.is_empty());
    }
}
