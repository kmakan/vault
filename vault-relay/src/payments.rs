//! Платёжный провайдер и платёжная сессия (чекаут) — шаги 4–5 плана
//! платных relay-токенов (docs/design/paid-tokens-spec.md §3, §7).
//!
//! ПОЧЕМУ ТАК. Сервер сам опрашивает провайдера и НЕ доверяет клиенту:
//! клиент может прислать «я заплатил» — это ничего не значит, пока
//! провайдер не подтвердил оплату. Поэтому проверка вынесена в провайдера, а
//! релей только спрашивает.
//!
//! РЕАЛЬНЫХ ПРОВАЙДЕРОВ ПОКА НЕТ (нужно ИП: см. канбан ORG-2 — ЮKassa).
//! Рабочий провайдер — `TestProvider`: оплата подтверждается мгновенно, и
//! так выдаются ТЕСТОВЫЕ Pro-токены без реальных платежей. Остальные
//! провайдеры — заглушки, отвечающие «недоступно»: клиент увидит честную
//! ошибку, а не выдуманный успех.

use std::collections::HashMap;
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
}

/// Статус оплаты по чекауту.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentStatus {
    Paid,
    Pending,
    Failed(String),
}

/// Платёжный провайдер.
///
/// Реализация отвечает на два вопроса: «создай сессию оплаты» и «оплачено ли».
/// Всё остальное (идемпотентность, срок, выпуск токена) — на стороне релея.
pub trait PaymentProvider: Send + Sync {
    /// Имя провайдера (показывается клиенту и попадает в логи).
    fn name(&self) -> &str;
    /// Создать платёжную сессию.
    fn create_checkout(&self, req: &CheckoutRequest) -> Result<Checkout, PaymentError>;
    /// Проверить статус оплаты по чекауту.
    fn verify(&self, checkout: &Checkout) -> Result<PaymentStatus, PaymentError>;
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

    fn create_checkout(&self, req: &CheckoutRequest) -> Result<Checkout, PaymentError> {
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
        })
    }

    fn verify(&self, checkout: &Checkout) -> Result<PaymentStatus, PaymentError> {
        let issued = self.issued.lock().expect("issued lock");
        match issued.get(&checkout.id) {
            Some(_) => Ok(PaymentStatus::Paid),
            None => Ok(PaymentStatus::Pending),
        }
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

    fn create_checkout(&self, _req: &CheckoutRequest) -> Result<Checkout, PaymentError> {
        Err(PaymentError::Unavailable)
    }

    fn verify(&self, _checkout: &Checkout) -> Result<PaymentStatus, PaymentError> {
        Err(PaymentError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(plan: Plan, months: u32) -> CheckoutRequest {
        CheckoutRequest {
            fp: "fp-alice".into(),
            plan,
            months,
            lang: "ru".into(),
        }
    }

    #[test]
    fn test_provider_creates_checkout_with_expiry() {
        let p = TestProvider::new();
        let c = p.create_checkout(&req(Plan::Pro, 1)).expect("чекаут создан");
        assert!(c.id.starts_with("co_test_"), "ид чеката: {}", c.id);
        assert_eq!(c.provider, "test");
        assert_eq!(c.plan, Plan::Pro);
        assert_eq!(c.months, 1);
        assert!(c.expires_at > c.created_at, "срок чеката должен быть в будущем");
        assert_eq!(c.expires_at - c.created_at, 1800);
    }

    #[test]
    fn test_provider_confirms_paid_immediately() {
        let p = TestProvider::new();
        let c = p.create_checkout(&req(Plan::Pro, 12)).expect("чекаут создан");
        assert_eq!(
            p.verify(&c).expect("verify"),
            PaymentStatus::Paid,
            "тестовый провайдер подтверждает оплату сразу"
        );
    }

    #[test]
    fn test_provider_does_not_confirm_unknown_checkout() {
        let p = TestProvider::new();
        let mut c = p
            .create_checkout(&req(Plan::Pro, 1))
            .expect("чекаут создан");
        c.id = "co_test_несуществующий".into();
        assert_eq!(
            p.verify(&c).expect("verify"),
            PaymentStatus::Pending,
            "неизданный чекаут не оплачен"
        );
    }

    #[test]
    fn test_unavailable_provider_refuses() {
        let p = UnavailableProvider::new("yookassa");
        assert_eq!(p.name(), "yookassa");
        assert!(
            matches!(
                p.create_checkout(&req(Plan::Pro, 1)),
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
        };
        assert_eq!(p.verify(&c), Err(PaymentError::Unavailable));
    }
}
