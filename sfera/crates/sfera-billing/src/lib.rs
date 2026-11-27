//! Vault Sfera: контракт монетизации (ADR-006 §17).
//!
//! Цены, сроки и доступность приходят с сервера (`GET /relay/plans`) — того
//! же, что использует мессенджер. Здесь нет ни одной цены, ни правила «сколько
//! стоит год». Rust проверяет форму ответа и превращает её в типизированную
//! витрину; UI только показывает строки и кнопку.
//!
//! Платные возможности Sfera: каналы сверх лимита, premium-релей и больше
//! места для блобов. Все три уже имеют Rust-порты; биллинг не изобретает
//! новую систему прав.

use serde::{Deserialize, Serialize};

pub mod creator;

/// Одна позиция витрины — точная форма ответа `/relay/plans`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerPlan {
    pub plan: String,
    pub months: u16,
    pub amount: String,
    pub currency: String,
    pub kopecks: u64,
}

/// Ответ витрины. `crypto.enabled=false` — канал выключен сервером, UI не
/// должен показывать его как доступный.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlansResponse {
    pub plans: Vec<ServerPlan>,
    #[serde(default)]
    pub crypto: CryptoCatalog,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CryptoCatalog {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub currency: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PaymentMethod {
    Card,
    Crypto,
}

/// Запрос чекаута: только id тарифа и способ. fp/аккаунт добавляет слой
/// приложения; цену и период сервер берёт из своего каталога.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckoutRequest {
    pub plan: String,
    pub months: u16,
    pub method: PaymentMethod,
}

impl CheckoutRequest {
    pub fn card(plan: impl Into<String>, months: u16) -> Self {
        Self { plan: plan.into(), months, method: PaymentMethod::Card }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckoutResponse {
    pub checkout_id: String,
    pub expires_in: u64,
    pub payment_url: String,
    pub provider: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogError {
    Empty,
    DuplicateMonths,
    NonPositivePrice,
}

/// Проверить витрину перед показом. Защита от «кривого» ответа сервера:
/// пустой каталог или нулевая цена не должны тихо превращаться в бесплатный
/// тариф в UI.
pub fn validate(response: &PlansResponse) -> Result<(), CatalogError> {
    if response.plans.is_empty() {
        return Err(CatalogError::Empty);
    }
    let mut seen = std::collections::BTreeSet::new();
    for p in &response.plans {
        if p.kopecks == 0 {
            return Err(CatalogError::NonPositivePrice);
        }
        if !seen.insert(p.months) {
            return Err(CatalogError::DuplicateMonths);
        }
    }
    Ok(())
}

/// Найти тариф по сроку. `None` — сервер такого не предлагает; UI не должен
/// подставлять свой период.
pub fn plan_for(response: &PlansResponse, months: u16) -> Option<&ServerPlan> {
    response.plans.iter().find(|p| p.months == months)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> PlansResponse {
        PlansResponse {
            plans: vec![
                ServerPlan { plan: "pro".into(), months: 1, amount: "149.00".into(), currency: "RUB".into(), kopecks: 14900 },
                ServerPlan { plan: "pro".into(), months: 12, amount: "1490.00".into(), currency: "RUB".into(), kopecks: 149000 },
            ],
            crypto: CryptoCatalog::default(),
        }
    }

    #[test]
    fn live_shaped_catalog_validates() {
        let c = catalog();
        assert!(validate(&c).is_ok());
        assert_eq!(plan_for(&c, 12).unwrap().kopecks, 149000);
        assert!(plan_for(&c, 6).is_none(), "UI не придумывает срок");
    }

    #[test]
    fn empty_catalog_is_rejected() {
        let mut c = catalog();
        c.plans.clear();
        assert_eq!(validate(&c).unwrap_err(), CatalogError::Empty);
    }

    #[test]
    fn zero_price_is_rejected() {
        let mut c = catalog();
        c.plans[0].kopecks = 0;
        assert_eq!(validate(&c).unwrap_err(), CatalogError::NonPositivePrice);
    }

    #[test]
    fn duplicate_months_are_rejected() {
        let mut c = catalog();
        c.plans[1].months = 1;
        assert_eq!(validate(&c).unwrap_err(), CatalogError::DuplicateMonths);
    }

    #[test]
    fn checkout_has_no_price() {
        let req = CheckoutRequest::card("pro", 12);
        let json = serde_json::to_string(&req).unwrap();
        assert!(!json.contains("149"));
        assert!(json.contains("\"months\":12"));
    }
}
