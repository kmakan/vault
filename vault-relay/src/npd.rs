//! Автоматические чеки НПД: оплата в ЮKassa → чек в «Мой налог».
//!
//! ЗАЧЕМ. Чек самозанятого формируется не в ЮKassa (у НПД нет ККТ, и
//! `fiscalization_enabled` у магазина всегда `false`), а в «Мой налог».
//! Ручной шаг там — единственное место в оплате, где нужен человек, и именно
//! он теряется: чек без сформированного документа — штраф 20% суммы расчёта.
//! Поэтому сверка «оплата ↔ чек» живёт здесь и дооформляет недостающее сама.
//!
//! ЧТО ИСТИНА. Список чеков у ФНС (`GET /api/v1/incomes`), а не локальный
//! реестр: реестр лишь помнит, что мы уже отправили, чтобы недоступный на
//! секунду список не превратился в дубль чека.
//!
//! ПОЧЕМУ ТОКЕН, А НЕ ПАРОЛЬ. Вход в ЛКФЛ у владельца по SMS, пароля нет
//! вовсе. `refresh.token` из приложения обновляется через
//! `POST /api/v1/auth/token` — этим автоматика и живёт; ключ именно
//! `deviceInfo` (на `deviceSource`/`deviceId` сервер отвечает 422).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::accounting::parse_amount_kopecks;
use crate::payments::PaymentRow;

/// Боевой адрес ЛКФЛ. Отдельная константа, чтобы тесты не ходили в сеть.
pub const DEFAULT_API_BASE: &str = "https://lknpd.nalog.ru";
/// Смещение московского времени: налоговый день — мсковский, не UTC.
const MSK_OFFSET_MIN: i32 = 180;
/// Способ расчёта в чеке. Приложение «Мой налог» при ручном создании всегда
/// ставит `CASH`, и уже выданные чеки Vault такие же. Для налога (4% с
/// физлиц) способ расчёта не влияет — влияет только на строку в документе.
const PAYMENT_TYPE: &str = "CASH";

/// Пара токенов ЛКФЛ. `token` живёт около часа, `refresh_token` — долго.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct NpdToken {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: String,
}

/// Чек, уже зарегистрированный в «Мой налог».
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Income {
    pub uuid: String,
    pub operation_time: String,
    pub total_kopecks: u64,
    pub name: String,
}

/// Состояние автоматики: переживает перезапуск, лежит отдельным файлом.
///
/// `registered` — ключ «id платежа ЮKassa», значение — uuid чека. Нужен ровно
/// для одного: если список чеков ФНС в момент сверки не отвечает или отстаёт,
/// платёж не должен оформиться второй раз.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NpdState {
    #[serde(default)]
    pub token: NpdToken,
    #[serde(default)]
    pub registered: BTreeMap<String, String>,
}

impl NpdState {
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Атомарная запись: временный файл рядом + rename (иначе обрыв питания
    /// на середине записи оставит обрезанный JSON и потеряет реестр чеков).
    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("npd state dir: {e}"))?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|e| format!("npd state json: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| format!("npd state write: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("npd state rename: {e}"))
    }
}

/// Путь к файлу состояния из окружения.
pub fn state_path_from_env() -> PathBuf {
    match std::env::var("VAULT_NPD_STATE_PATH") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => PathBuf::from("npd-state.json"),
    }
}

/// Тело запроса на обновление сессии.
///
/// Форма закреплена здесь, а не в вызывающем коде: сервер принимает токен
/// только внутри `deviceInfo`, и проверено, что `deviceSource`, `deviceId` и
/// плоские поля дают `422 validation.failed`. Одна форма — одно место.
pub fn build_refresh_body(refresh_token: &str, device_id: &str) -> serde_json::Value {
    serde_json::json!({
        "refreshToken": refresh_token,
        "deviceInfo": {
            "sourceDeviceId": device_id,
            "appName": "vault-relay",
            "appVersion": "1.0.0",
            "sourceType": "WEB",
        }
    })
}

/// Разбор ответа `POST /api/v1/auth/token`.
///
/// Пустой `token` — ошибка, а не «пока нет»: без него сверка чеков слепая, и
/// молча продолжать нельзя (иначе оплата пройдёт без чека и без сигнала).
pub fn parse_refresh(v: &serde_json::Value) -> Result<NpdToken, String> {
    let token = v.get("token").and_then(|x| x.as_str()).unwrap_or("");
    if token.trim().is_empty() {
        return Err("npd refresh: пустой token в ответе".to_string());
    }
    let refresh = v.get("refreshToken").and_then(|x| x.as_str()).unwrap_or("");
    let expires = v.get("tokenExpireIn").and_then(|x| x.as_str()).unwrap_or("");
    Ok(NpdToken {
        token: token.to_string(),
        refresh_token: refresh.to_string(),
        expires_at: expires.to_string(),
    })
}

/// Тело запроса на регистрацию чека.
///
/// `totalAmount` — строка с двумя знаками («149.00»), как его отдаёт сам
/// ЛКФЛ в списке чеков; `services[].amount` — то же число. Сумма приходит
/// в копейках, чтобы не потерять копейку на дробном делении.
pub fn build_income_body(kopecks: u64, name: &str, operation_time: &str, client_phone: Option<&str>) -> serde_json::Value {
    let amount = kopecks_text(kopecks);
    serde_json::json!({
        "operationTime": operation_time,
        "requestTime": operation_time,
        "paymentType": PAYMENT_TYPE,
        "ignoreMaxTotalIncomeRestriction": false,
        "client": {
            "contactPhone": client_phone,
            "displayName": null,
            "inn": null,
            "type": "FROM_INDIVIDUAL",
        },
        "totalAmount": amount,
        "services": [{
            "name": name,
            "amount": amount.parse::<f64>().unwrap_or(0.0),
            "quantity": 1,
        }],
        "receiptEmail": null,
    })
}

/// Копейки → «149.00». Без float: сумма в чеке не должна зависеть от
/// двоичного округления.
pub fn kopecks_text(kopecks: u64) -> String {
    format!("{}.{:02}", kopecks / 100, kopecks % 100)
}

/// Разбор списка чеков `GET /api/v1/incomes`.
///
/// Отсутствие `content` — ошибка провайдера, а не «чеков нет»: пустой список
/// при живом ЛКФЛ означал бы «все оплаты без чеков» и пачку дублей.
pub fn parse_incomes(v: &serde_json::Value) -> Result<Vec<Income>, String> {
    let items = v
        .get("content")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "npd incomes: нет content в ответе".to_string())?;
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let uuid = it.get("approvedReceiptUuid").and_then(|x| x.as_str()).unwrap_or("");
        if uuid.is_empty() {
            continue; // черновик/отменённый без номера — не чек
        }
        let total = it.get("totalAmount").and_then(|x| x.as_f64()).unwrap_or(-1.0);
        if total < 0.0 {
            continue;
        }
        let kopecks = (total * 100.0).round() as u64;
        out.push(Income {
            uuid: uuid.to_string(),
            operation_time: it.get("operationTime").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            total_kopecks: kopecks,
            name: it.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        });
    }
    Ok(out)
}

/// День по московскому времени из ISO-строки с любым смещением.
///
/// ЮKassa отдаёт UTC (`…Z`), ЛКФЛ — уже московское время (`+03:00`).
/// Считать их одним правилом нельзя: прибавка трёх часов к `+03:00` сдвинула
/// бы чек за 23:30 на следующий день, и сверка перестала бы находить пару.
pub fn msk_day_key(iso: &str) -> Option<String> {
    if iso.len() < 16 {
        return None;
    }
    let y: i32 = iso.get(0..4)?.parse().ok()?;
    let m: i32 = iso.get(5..7)?.parse().ok()?;
    let d: i32 = iso.get(8..10)?.parse().ok()?;
    let h: i32 = iso.get(11..13)?.parse().ok()?;
    let min: i32 = iso.get(14..16)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(0..=23).contains(&h) || !(0..=59).contains(&min) {
        return None;
    }
    let offset = offset_minutes(iso).unwrap_or(0);
    let absolute = days_from_civil(y, m, d) * 1440 + h * 60 + min;
    let msk = absolute + MSK_OFFSET_MIN - offset;
    let (yy, mm, dd) = civil_from_days(msk.div_euclid(1440));
    Some(format!("{:04}-{:02}-{:02}", yy, mm, dd))
}

/// То же время, но в виде ISO с московским смещением: «…T11:56:00+03:00».
///
/// ЛКФЛ принимает время с любым смещением, но чек — документ для человека:
/// в нём должно стоять местное время, то же, что видно в приложении.
pub fn msk_iso(iso: &str) -> Option<String> {
    if iso.len() < 16 {
        return None;
    }
    let y: i32 = iso.get(0..4)?.parse().ok()?;
    let m: i32 = iso.get(5..7)?.parse().ok()?;
    let d: i32 = iso.get(8..10)?.parse().ok()?;
    let h: i32 = iso.get(11..13)?.parse().ok()?;
    let min: i32 = iso.get(14..16)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(0..=23).contains(&h) || !(0..=59).contains(&min) {
        return None;
    }
    let offset = offset_minutes(iso)?;
    let absolute = days_from_civil(y, m, d) * 1440 + h * 60 + min + MSK_OFFSET_MIN - offset;
    let (yy, mm, dd) = civil_from_days(absolute.div_euclid(1440));
    let minutes = absolute.rem_euclid(1440);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:00+03:00",
        yy,
        mm,
        dd,
        minutes / 60,
        minutes % 60
    ))
}

/// Смещение из хвоста ISO-строки в минутах: `+03:00` → 180, `Z`/без хвоста → 0.
fn offset_minutes(iso: &str) -> Option<i32> {
    let tail = iso.get(16..)?; // «:52+03:00» либо «:52.123Z»
    for (i, c) in tail.char_indices() {
        match c {
            '+' | '-' => {
                let rest = &tail[i + 1..];
                let hh: i32 = rest.get(0..2)?.parse().ok()?;
                // «+03:00» и «+0300» — оба встречаются в жизни.
                let mm_text = rest.get(3..5).or_else(|| rest.get(2..4))?;
                let mm: i32 = mm_text.parse().ok()?;
                let sign = if c == '+' { 1 } else { -1 };
                return Some(sign * (hh * 60 + mm));
            }
            'Z' | 'z' => return Some(0),
            _ => {}
        }
    }
    // Без суффикса считаем UTC: это самый распространённый формат у ЮKassa.
    Some(0)
}

/// Дни с 1970-01-01 для гражданской даты (Howard Hinnant, days_from_civil).
fn days_from_civil(y: i32, m: i32, d: i32) -> i32 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Обратное к `days_from_civil`.
fn civil_from_days(z: i32) -> (i32, i32, i32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Имя услуги для чека: из описания платежа, иначе общее.
///
/// Описание в ЮKassa — «Vault pro: 1 мес», и оно уже человеческое; выдумывать
/// своё имя там, где провайдер дал точное, значит разойтись с тем, что
/// покупатель видел на странице оплаты.
pub fn service_name(description: &str) -> String {
    let d = description.trim();
    if d.is_empty() {
        "Доступ к тарифу Pro (Vault)".to_string()
    } else {
        format!("Vault: {}", d.trim_start_matches("Vault ").trim_start_matches("vault "))
    }
}

/// Платежи, у которых нет чека.
///
/// Правило пары: равная сумма И один московский день. Один чек закрывает
/// ровно один платёж (частая сумма 149 ₽ в один день иначе сошлась бы с одним
/// чеком дважды). Уже отправленные нами платежи (`done`) не повторяются даже
/// если списка чеков в ответе ещё нет.
pub fn missing_receipts(payments: &[PaymentRow], incomes: &[Income], done: &BTreeMap<String, String>) -> Vec<PaymentRow> {
    let mut pool: Vec<(String, u64)> = incomes
        .iter()
        .filter_map(|i| msk_day_key(&i.operation_time).map(|d| (d, i.total_kopecks)))
        .collect();

    let mut paid: Vec<&PaymentRow> = payments
        .iter()
        .filter(|p| p.paid && p.status == "succeeded" && !p.test)
        .collect();
    paid.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let mut missing = Vec::new();
    for p in paid {
        if done.contains_key(&p.id) {
            continue;
        }
        let kopecks = parse_amount_kopecks(&p.amount.value);
        let day = msk_day_key(&p.created_at);
        match (kopecks, day) {
            (Some(k), Some(d)) => {
                if let Some(pos) = pool.iter().position(|(pd, pk)| *pd == d && *pk == k) {
                    pool.remove(pos);
                } else {
                    missing.push(p.clone());
                }
            }
            // Сумму или дату не разобрали — платёж не угадываем и в чеки не
            // отправляем: неверная сумма в чеке хуже отсутствия автоматики.
            _ => {}
        }
    }
    missing
}

/// Транспорт ЛКФЛ: запрос с Bearer → (код, тело).
///
/// Отдельный трейт, а не общий с ЮKassa: там базовая авторизация, здесь
/// Bearer, и один fake на два протокола начал бы врать про авторизацию.
pub trait NpdHttp: Send + Sync {
    fn send<'a>(
        &'a self,
        method: &'a str,
        url: &'a str,
        bearer: Option<&'a str>,
        body: Option<serde_json::Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(u16, serde_json::Value), String>> + Send + 'a>>;
}

/// Живой транспорт на reqwest (rustls-tls, без system-SSL).
pub struct ReqwestNpdHttp {
    client: reqwest::Client,
}

impl ReqwestNpdHttp {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }
}

impl Default for ReqwestNpdHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl NpdHttp for ReqwestNpdHttp {
    fn send<'a>(
        &'a self,
        method: &'a str,
        url: &'a str,
        bearer: Option<&'a str>,
        body: Option<serde_json::Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(u16, serde_json::Value), String>> + Send + 'a>> {
        Box::pin(async move {
            let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("npd method: {e}"))?;
            let mut req = self.client.request(m, url).header("Accept", "application/json");
            if let Some(t) = bearer {
                req = req.bearer_auth(t);
            }
            if let Some(b) = body {
                req = req.json(&b);
            }
            let resp = req.send().await.map_err(|e| format!("npd http: {e}"))?;
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
            Ok((status, value))
        })
    }
}

/// Клиент ЛКФЛ: обновление сессии, список чеков, регистрация чека.
pub struct NpdClient {
    api_base: String,
    device_id: String,
    http: Arc<dyn NpdHttp + Send + Sync>,
}

impl NpdClient {
    pub fn new(api_base: &str, device_id: &str, http: Arc<dyn NpdHttp + Send + Sync>) -> Self {
        Self {
            api_base: api_base.trim_end_matches('/').to_string(),
            device_id: device_id.to_string(),
            http,
        }
    }

    /// Клиент из окружения. Без `refresh.token`/`device_id` — Err: половина
    /// настроенной автоматики опаснее выключенной (владелец думает, что чеки
    /// идут, а они молчат).
    pub fn from_env() -> Result<Self, String> {
        let device = std::env::var("VAULT_NPD_DEVICE_ID").unwrap_or_default();
        if device.trim().is_empty() {
            return Err("VAULT_NPD_DEVICE_ID not set".to_string());
        }
        let base = std::env::var("VAULT_NPD_API_BASE").unwrap_or_else(|_| DEFAULT_API_BASE.to_string());
        Ok(Self::new(&base, device.trim(), Arc::new(ReqwestNpdHttp::new())))
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Обновить сессию по refresh-токену.
    pub async fn refresh(&self, refresh_token: &str) -> Result<NpdToken, String> {
        let url = format!("{}/api/v1/auth/token", self.api_base);
        let body = build_refresh_body(refresh_token, &self.device_id);
        let (status, resp) = self.http.send("POST", &url, None, Some(body)).await?;
        match status {
            200 => parse_refresh(&resp),
            401 | 403 => Err("npd refresh: сессия отозвана, нужен новый refresh.token".to_string()),
            other => Err(format!("npd refresh: HTTP {other}")),
        }
    }

    /// Список последних чеков.
    pub async fn list_incomes(&self, token: &str) -> Result<Vec<Income>, String> {
        let url = format!("{}/api/v1/incomes?limit=200&offset=0", self.api_base);
        let (status, resp) = self.http.send("GET", &url, Some(token), None).await?;
        match status {
            200 => parse_incomes(&resp),
            401 | 403 => Err("npd incomes: токен не принят".to_string()),
            other => Err(format!("npd incomes: HTTP {other}")),
        }
    }

    /// Зарегистрировать чек. Возвращает uuid выданного документа.
    pub async fn register_income(&self, token: &str, kopecks: u64, name: &str, operation_time: &str) -> Result<String, String> {
        let url = format!("{}/api/v1/income", self.api_base);
        let body = build_income_body(kopecks, name, operation_time, None);
        let (status, resp) = self.http.send("POST", &url, Some(token), Some(body)).await?;
        match status {
            200 => {
                let uuid = resp.get("approvedReceiptUuid").and_then(|x| x.as_str()).unwrap_or("");
                if uuid.is_empty() {
                    return Err("npd income: нет approvedReceiptUuid в ответе".to_string());
                }
                Ok(uuid.to_string())
            }
            401 | 403 => Err("npd income: токен не принят".to_string()),
            422 => Err(format!(
                "npd income: 422 {}",
                resp.get("message").and_then(|x| x.as_str()).unwrap_or("валидация")
            )),
            other => Err(format!("npd income: HTTP {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payments::PaymentAmount;

    fn pay(id: &str, status: &str, at: &str, value: &str) -> PaymentRow {
        PaymentRow {
            id: id.to_string(),
            status: status.to_string(),
            paid: status == "succeeded",
            created_at: at.to_string(),
            amount: PaymentAmount { value: value.to_string(), currency: "RUB".to_string() },
            description: "Vault pro: 1 мес".to_string(),
            test: false,
        }
    }

    fn income(uuid: &str, at: &str, kopecks: u64) -> Income {
        Income { uuid: uuid.to_string(), operation_time: at.to_string(), total_kopecks: kopecks, name: "x".to_string() }
    }

    #[test]
    fn день_считается_по_москве_для_обоих_форматов() {
        // ЮKassa: 08:45 UTC = 11:45 МСК того же дня.
        assert_eq!(msk_day_key("2026-10-31T08:45:44.123Z").as_deref(), Some("2026-10-31"));
        // ЛКФЛ: уже +03:00 — прибавлять нельзя.
        assert_eq!(msk_day_key("2026-10-31T11:56:52+03:00").as_deref(), Some("2026-10-31"));
        // Переход через полночь: 23:30 UTC = 02:30 МСК следующего дня.
        assert_eq!(msk_day_key("2026-10-31T23:30:00Z").as_deref(), Some("2026-11-01"));
        // 00:30 МСК остаётся тем же днём, а не уезжает назад.
        assert_eq!(msk_day_key("2026-11-01T00:30:00+03:00").as_deref(), Some("2026-11-01"));
        assert_eq!(msk_day_key("мусор"), None);
    }

    #[test]
    fn время_чека_приводится_к_московскому() {
        assert_eq!(msk_iso("2026-10-31T08:45:44.123Z").as_deref(), Some("2026-10-31T11:45:00+03:00"));
        assert_eq!(msk_iso("2026-10-31T11:56:52+03:00").as_deref(), Some("2026-10-31T11:56:00+03:00"));
        // 23:30 UTC — уже следующий день в Москве.
        assert_eq!(msk_iso("2026-10-31T23:30:00Z").as_deref(), Some("2026-11-01T02:30:00+03:00"));
        assert_eq!(msk_iso("не дата"), None);
    }

    #[test]
    fn тело_чека_несёт_сумму_строкой_и_копейки_без_потерь() {
        let b = build_income_body(14900, "Vault: pro: 1 мес", "2026-10-31T11:56:52+03:00", None);
        assert_eq!(b["totalAmount"], serde_json::json!("149.00"));
        assert_eq!(b["services"][0]["amount"], serde_json::json!(149.0));
        assert_eq!(b["services"][0]["quantity"], serde_json::json!(1));
        assert_eq!(b["paymentType"], serde_json::json!("CASH"));
        assert_eq!(b["client"]["type"], serde_json::json!("FROM_INDIVIDUAL"));
        assert_eq!(kopecks_text(14950), "149.50");
        assert_eq!(kopecks_text(5), "0.05");
    }

    #[test]
    fn refresh_требует_токен_в_deviceinfo() {
        let b = build_refresh_body("ref", "dev-1");
        assert_eq!(b["refreshToken"], serde_json::json!("ref"));
        assert_eq!(b["deviceInfo"]["sourceDeviceId"], serde_json::json!("dev-1"));
        let ok = parse_refresh(&serde_json::json!({"token": "t", "refreshToken": "r", "tokenExpireIn": "z"})).unwrap();
        assert_eq!(ok.token, "t");
        assert_eq!(ok.refresh_token, "r");
        assert!(parse_refresh(&serde_json::json!({"token": ""})).is_err());
        assert!(parse_refresh(&serde_json::json!({})).is_err());
    }

    #[test]
    fn разбор_списка_чеков_и_пустой_content_это_ошибка() {
        let v = serde_json::json!({"content": [
            {"approvedReceiptUuid": "a1", "operationTime": "2026-10-31T11:56:52+03:00", "totalAmount": 149, "name": "n"},
            {"approvedReceiptUuid": "", "operationTime": "2026-10-31T11:56:52+03:00", "totalAmount": 149, "name": "черновик"}
        ]});
        let got = parse_incomes(&v).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].uuid, "a1");
        assert_eq!(got[0].total_kopecks, 14900);
        assert!(parse_incomes(&serde_json::json!({})).is_err());
    }

    #[test]
    fn оплаченный_платёж_без_чека_попадает_в_пропуски() {
        let payments = vec![pay("p1", "succeeded", "2026-10-31T08:45:00Z", "149.00")];
        let missing = missing_receipts(&payments, &[], &BTreeMap::new());
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, "p1");
    }

    #[test]
    fn чек_того_же_дня_и_суммы_закрывает_платёж() {
        let payments = vec![pay("p1", "succeeded", "2026-10-31T08:45:00Z", "149.00")];
        let incomes = vec![income("a1", "2026-10-31T11:56:52+03:00", 14900)];
        assert!(missing_receipts(&payments, &incomes, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn чек_другого_дня_или_суммы_не_закрывает() {
        let payments = vec![pay("p1", "succeeded", "2026-10-31T08:45:00Z", "149.00")];
        let другой_день = vec![income("a1", "2026-11-01T11:56:52+03:00", 14900)];
        assert_eq!(missing_receipts(&payments, &другой_день, &BTreeMap::new()).len(), 1);
        let другая_сумма = vec![income("a1", "2026-10-31T11:56:52+03:00", 149000)];
        assert_eq!(missing_receipts(&payments, &другая_сумма, &BTreeMap::new()).len(), 1);
    }

    #[test]
    fn один_чек_не_закрывает_две_одинаковые_оплаты() {
        let payments = vec![
            pay("p1", "succeeded", "2026-10-31T08:00:00Z", "149.00"),
            pay("p2", "succeeded", "2026-10-31T09:00:00Z", "149.00"),
        ];
        let incomes = vec![income("a1", "2026-10-31T11:56:52+03:00", 14900)];
        let missing = missing_receipts(&payments, &incomes, &BTreeMap::new());
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, "p2"); // закрывается более ранняя оплата
    }

    #[test]
    fn неоплаченные_тестовые_и_уже_отправленные_пропускаются() {
        let mut p2 = pay("p2", "pending", "2026-10-31T08:00:00Z", "149.00");
        p2.paid = false;
        let mut p3 = pay("p3", "succeeded", "2026-10-31T08:00:00Z", "149.00");
        p3.test = true;
        let p4 = pay("p4", "succeeded", "2026-10-31T08:00:00Z", "149.00");
        let mut done = BTreeMap::new();
        done.insert("p4".to_string(), "uuid".to_string());
        let payments = vec![p2, p3, p4];
        assert!(missing_receipts(&payments, &[], &done).is_empty());
    }

    #[test]
    fn кривая_сумма_или_дата_в_чеки_не_уходят() {
        let payments = vec![
            pay("p1", "succeeded", "2026-10-31T08:00:00Z", "не сумма"),
            pay("p2", "succeeded", "вчера", "149.00"),
        ];
        assert!(missing_receipts(&payments, &[], &BTreeMap::new()).is_empty());
    }

    #[test]
    fn имя_услуги_берётся_из_описания_платежа() {
        assert_eq!(service_name("Vault pro: 1 мес"), "Vault: pro: 1 мес");
        assert_eq!(service_name("Vault pro: 12 мес"), "Vault: pro: 12 мес");
        assert_eq!(service_name("  "), "Доступ к тарифу Pro (Vault)");
    }
}
