//! Учёт оплат и налога НПД для владельца релея.
//!
//! ЗАЧЕМ. ЮKassa перечисляет деньги сводной выплатой: в банковской выписке
//! нет отдельного «149 ₽ за Vault», поэтому чек в «Мой налог» без своего
//! учёта легко пропустить (штраф — 20% суммы расчёта, минимум 1000 ₽).
//! Здесь список платежей провайдера сводится с локальным реестром чеков и
//! помесячным реестром уплаченного налога.
//!
//! ЧТО ИСТИНА. Деньги — только у провайдера (`GET /payments`); реестр
//! отвечает лишь на «чек сформирован?» и «налог уплачен?», потому что этих
//! действий ЮKassa не знает. Налог ФНС считает сам: здесь ОЦЕНКА по ставке
//! и вычету, а не замена расчёту налоговой.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::payments::PaymentRow;

/// Вычет НПД: 10 000 ₽ уменьшают налог на 1% дохода от физлиц, пока не
/// исчерпаны (ставка 4% фактически становится 3%). Применяется ФНС сама.
pub const DEDUCTION_KOPECKS: u64 = 10_000 * 100;
/// Ставка НПД с доходов от физлиц.
const RATE_PERCENT: u64 = 4;
/// МСК = UTC+3: налоговый период и сроки считаются по московскому времени.
const MSK_OFFSET_SECS: u64 = 3 * 3600;
/// Чек при безналичном расчёте — до 9-го числа следующего месяца (422-ФЗ).
pub const RECEIPT_DAY: u32 = 9;
/// Налог за месяц — до 28-го числа следующего месяца.
pub const TAX_DAY: u32 = 28;

const MONTHS_RU: [&str; 12] = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/// Локальный реестр: что уже отмечено руками.
///
/// Ключ чеков — id платежа ЮKassa (он неизменен), ключ налога — месяц
/// «YYYY-MM». Хранится отдельным файлом от state.json: учёт — не состояние
/// протокола, и его порча не должна ронять релей.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ledger {
    #[serde(default)]
    pub receipts: BTreeMap<String, u64>,
    #[serde(default)]
    pub tax_paid: BTreeMap<String, u64>,
}

impl Ledger {
    pub fn load(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "accounting: unreadable, starting empty");
                return Self::default();
            }
        };
        match serde_json::from_str::<Self>(&text) {
            Ok(mut l) => {
                l.sanitize();
                l
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "accounting: broken json, starting empty");
                Self::default()
            }
        }
    }

    /// Атомарная запись (tmp + fsync + rename), права 0600: в файле нет
    /// секретов, но это бухгалтерия — чужим глазам она не нужна.
    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all: {e}"))?;
            }
        }
        let json = serde_json::to_string(self).map_err(|e| format!("serialize: {e}"))?;
        let tmp = {
            let mut p = path.as_os_str().to_os_string();
            p.push(".tmp");
            PathBuf::from(p)
        };
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(|e| format!("create tmp: {e}"))?;
            f.write_all(json.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
            f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
        }
        std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))
    }

    fn sanitize(&mut self) {
        self.receipts.retain(|k, _| {
            !k.is_empty()
                && k.len() <= 64
                && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
        self.tax_paid.retain(|k, _| valid_month(k));
    }
}

/// Месяц налогового периода «YYYY-MM».
pub fn valid_month(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 7 || b[4] != b'-' {
        return false;
    }
    let year: u32 = s[0..4].parse().unwrap_or(0);
    let month: u32 = s[5..7].parse().unwrap_or(0);
    (2000..=2100).contains(&year) && (1..=12).contains(&month)
}

/// Календарная дата в МСК (без времени).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

/// Дата по unix-секундам в московском времени.
pub fn msk_date(now_unix: u64) -> Date {
    civil_from_days(((now_unix + MSK_OFFSET_SECS) / 86_400) as i64)
}

pub fn date_text(d: Date) -> String {
    format!("{:02}.{:02}.{}", d.d, d.m, d.y)
}

/// Дни с 1970-01-01 → дата (алгоритм Говарда Хиннанта, без внешних крейтов).
fn civil_from_days(z: i64) -> Date {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    Date { y: (if m <= 2 { y + 1 } else { y }) as i32, m, d }
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
            if leap { 29 } else { 28 }
        }
        _ => 0,
    }
}

/// «2026-10-31T06:45:44.123Z» → дата и время в МСК. Суффикс/доли секунды не
/// разбираем: ЮKassa всегда отдаёт UTC, а нам нужны только день и минута.
pub fn msk_from_iso(s: &str) -> Option<(Date, u32, u32)> {
    let b = s.as_bytes();
    if b.len() < 16 {
        return None;
    }
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    let h: u32 = s.get(11..13)?.parse().ok()?;
    let min: u32 = s.get(14..16)?.parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) || h > 23 || min > 59 {
        return None;
    }
    let mut date = Date { y, m, d };
    let mut hour = h + (MSK_OFFSET_SECS / 3600) as u32;
    if hour >= 24 {
        hour -= 24;
        date = next_day(date);
    }
    Some((date, hour, min))
}

fn next_day(d: Date) -> Date {
    if d.d < days_in_month(d.y, d.m) {
        Date { y: d.y, m: d.m, d: d.d + 1 }
    } else if d.m < 12 {
        Date { y: d.y, m: d.m + 1, d: 1 }
    } else {
        Date { y: d.y + 1, m: 1, d: 1 }
    }
}

fn next_month(y: i32, m: u32) -> (i32, u32) {
    if m < 12 { (y, m + 1) } else { (y + 1, 1) }
}

fn month_key(y: i32, m: u32) -> String {
    format!("{:04}-{:02}", y, m)
}

fn month_label(y: i32, m: u32) -> String {
    let name = MONTHS_RU.get((m as usize).saturating_sub(1)).copied().unwrap_or("");
    format!("{} {}", name, y)
}

/// «149.00» → 14900 копеек. Строку, которую нельзя разобрать, не угадываем.
pub fn parse_amount_kopecks(v: &str) -> Option<u64> {
    let v = v.trim();
    let (rub, frac) = match v.split_once('.') {
        Some((a, b)) => (a, b),
        None => (v, ""),
    };
    if rub.is_empty() || !rub.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if frac.len() > 2 || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let rub: u64 = rub.parse().ok()?;
    let frac = match frac.len() {
        0 => 0,
        1 => frac.parse::<u64>().ok()? * 10,
        _ => frac.parse::<u64>().ok()?,
    };
    rub.checked_mul(100)?.checked_add(frac)
}

pub fn money_text(kopecks: u64) -> String {
    let rub = group3(kopecks / 100);
    format!("{},{} ₽", rub, format!("{:02}", kopecks % 100))
}

fn group3(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(' ');
        }
        out.push(ch);
    }
    out
}

/// Один платёж в отчёте.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: String,
    pub created_msk: String,
    pub amount_kopecks: u64,
    pub amount_text: String,
    pub description: String,
    pub receipt_at: Option<u64>,
    pub month: String,
    pub receipt_deadline: String,
    pub receipt_overdue: bool,
    pub test: bool,
    /// Для сортировки «свежие первыми» (ISO-строка), наружу не отдаём.
    #[serde(skip)]
    order: String,
}

/// Месяц налогового периода: доход, оценка налога, сроки.
#[derive(Debug, Clone, Serialize)]
pub struct Month {
    pub key: String,
    pub label: String,
    pub income_kopecks: u64,
    pub income_text: String,
    pub tax_kopecks: u64,
    pub tax_text: String,
    pub unaccounted: u32,
    pub tax_paid: bool,
    pub receipt_deadline: String,
    pub tax_deadline: String,
    pub receipt_overdue: bool,
    pub tax_overdue: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Report {
    pub as_of: String,
    pub entries: Vec<Entry>,
    pub months: Vec<Month>,
    pub unaccounted: u32,
    pub income_kopecks: u64,
    pub income_text: String,
    pub tax_kopecks: u64,
    pub tax_text: String,
    pub deduction_left_kopecks: u64,
    pub pending: u32,
    pub canceled: u32,
    pub unparsed: u32,
}

#[derive(Default)]
struct MonthAcc {
    y: i32,
    m: u32,
    income_kopecks: u64,
    unaccounted: u32,
}

/// Свести платежи провайдера с реестром чеков и налога.
///
/// Налог считается по месяцам в порядке календаря: вычет расходуется на 1%
/// дохода каждого месяца, пока не кончится. Это соответствует правилу НПД
/// (вычет уменьшает налог, а не доход).
pub fn build_report(rows: &[PaymentRow], ledger: &Ledger, now_unix: u64) -> Report {
    let today = msk_date(now_unix);
    let mut entries: Vec<Entry> = Vec::new();
    let mut by_month: BTreeMap<String, MonthAcc> = BTreeMap::new();
    let mut pending = 0u32;
    let mut canceled = 0u32;
    let mut unparsed = 0u32;
    for r in rows {
        match r.status.as_str() {
            "pending" | "waiting_for_capture" => {
                pending += 1;
                continue;
            }
            "canceled" => {
                canceled += 1;
                continue;
            }
            "succeeded" => {}
            _ => continue,
        }
        if !r.amount.currency.eq_ignore_ascii_case("RUB") {
            unparsed += 1;
            continue;
        }
        let (Some(kopecks), Some((date, hour, min))) = (
            parse_amount_kopecks(&r.amount.value),
            msk_from_iso(&r.created_at),
        ) else {
            unparsed += 1;
            continue;
        };
        let key = month_key(date.y, date.m);
        let receipt_at = ledger.receipts.get(&r.id).copied();
        let (ny, nm) = next_month(date.y, date.m);
        let deadline = Date { y: ny, m: nm, d: RECEIPT_DAY };
        entries.push(Entry {
            id: r.id.clone(),
            created_msk: format!("{} {:02}:{:02}", date_text(date), hour, min),
            amount_kopecks: kopecks,
            amount_text: money_text(kopecks),
            description: r.description.clone(),
            receipt_at,
            month: key.clone(),
            receipt_deadline: date_text(deadline),
            receipt_overdue: receipt_at.is_none() && today > deadline,
            test: r.test,
            order: r.created_at.clone(),
        });
        let acc = by_month.entry(key).or_default();
        acc.y = date.y;
        acc.m = date.m;
        acc.income_kopecks = acc.income_kopecks.saturating_add(kopecks);
        if receipt_at.is_none() {
            acc.unaccounted += 1;
        }
    }
    entries.sort_by(|a, b| b.order.cmp(&a.order));

    let mut months = Vec::with_capacity(by_month.len());
    let mut deduction_left = DEDUCTION_KOPECKS;
    let mut income_total = 0u64;
    let mut tax_total = 0u64;
    let mut unaccounted = 0u32;
    for (key, acc) in &by_month {
        let gross = acc.income_kopecks.saturating_mul(RATE_PERCENT) / 100;
        let one_percent = acc.income_kopecks / 100;
        let deduction = one_percent.min(deduction_left);
        deduction_left = deduction_left.saturating_sub(deduction);
        let tax = gross.saturating_sub(deduction);
        let (ny, nm) = next_month(acc.y, acc.m);
        let receipt_deadline = Date { y: ny, m: nm, d: RECEIPT_DAY };
        let tax_deadline = Date { y: ny, m: nm, d: TAX_DAY };
        let paid = ledger.tax_paid.contains_key(key);
        months.push(Month {
            key: key.clone(),
            label: month_label(acc.y, acc.m),
            income_kopecks: acc.income_kopecks,
            income_text: money_text(acc.income_kopecks),
            tax_kopecks: tax,
            tax_text: money_text(tax),
            unaccounted: acc.unaccounted,
            tax_paid: paid,
            receipt_deadline: date_text(receipt_deadline),
            tax_deadline: date_text(tax_deadline),
            receipt_overdue: acc.unaccounted > 0 && today > receipt_deadline,
            tax_overdue: !paid && today > tax_deadline,
        });
        income_total = income_total.saturating_add(acc.income_kopecks);
        tax_total = tax_total.saturating_add(tax);
        unaccounted += acc.unaccounted;
    }

    let now_date = msk_date(now_unix);
    let as_of = format!(
        "{} {:02}:{:02} MSK",
        date_text(now_date),
        ((now_unix + MSK_OFFSET_SECS) % 86_400) / 3600,
        ((now_unix + MSK_OFFSET_SECS) % 3_600) / 60,
    );
    Report {
        as_of,
        entries,
        months,
        unaccounted,
        income_kopecks: income_total,
        income_text: money_text(income_total),
        tax_kopecks: tax_total,
        tax_text: money_text(tax_total),
        deduction_left_kopecks: deduction_left,
        pending,
        canceled,
        unparsed,
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// HTML страницы учёта. Только серверный рендер: без внешних скриптов и
/// шрифтов, действия — обычные формы (CSP: default-src 'none').
pub fn page_html(r: &Report, csrf: &str, error: Option<&str>) -> String {
    let mut h = String::with_capacity(8_192);
    h.push_str("<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">");
    h.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
    h.push_str("<title>Vault — учёт оплат</title><style>");
    h.push_str(
        "body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1b1f24;background:#f6f7f9}\
         h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}\
         .sub{color:#5b6570;margin:0 0 16px}\
         .cards{display:flex;gap:12px;flex-wrap:wrap}\
         .card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:12px 16px;min-width:170px}\
         .card b{display:block;font-size:20px;margin-top:4px}\
         .bad{color:#b3261e}.ok{color:#1e7b34}\
         table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #dfe3e8;border-radius:10px;overflow:hidden}\
         th,td{padding:8px 10px;border-bottom:1px solid #edf0f3;text-align:left;vertical-align:top}\
         th{background:#eef1f4;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#4a5560}\
         tr:last-child td{border-bottom:0}code{font-size:12px;color:#4a5560}\
         button{font:inherit;padding:5px 10px;border-radius:7px;border:1px solid #b9c2cc;background:#fff;cursor:pointer}\
         button:hover{background:#eef1f4}\
         .note{color:#5b6570;font-size:13px;max-width:900px}.note li{margin:4px 0}\
         .err{background:#fdecea;border:1px solid #f3b6b0;color:#8d1d14;padding:10px 12px;border-radius:8px;margin:0 0 16px}\
         .warn{background:#fff4e5;border:1px solid #f0c98a;padding:10px 12px;border-radius:8px;margin:0 0 16px}\
         @media (prefers-color-scheme:dark){body{background:#14171a;color:#e6e9ec}.card,table{background:#1c2126;border-color:#2c333a}\
         th{background:#242b31;color:#b7c0c8}td{border-color:#2c333a}.sub,.note,code{color:#9aa5af}button{background:#242b31;color:#e6e9ec;border-color:#3a434c}}\
         </style></head><body><h1>Учёт оплат Vault</h1>",
    );
    h.push_str(&format!(
        "<p class=\"sub\">На {}. Источник платежей — ЮKassa; чеки и налог — реестр релея.</p>",
        escape_html(&r.as_of)
    ));
    if let Some(e) = error {
        h.push_str(&format!("<div class=\"err\">ЮKassa: {}</div>", escape_html(e)));
    }
    if r.unaccounted > 0 {
        h.push_str(&format!(
            "<div class=\"warn\"><b>Без чека: {}</b> — сформируйте чек в «Мой налог» и отметьте здесь. Штраф за пропуск — 20% суммы расчёта, минимум 1000 ₽.</div>",
            r.unaccounted
        ));
    }
    h.push_str(&format!(
        "<div class=\"cards\">\
         <div class=\"card\">Доход<b>{}</b></div>\
         <div class=\"card\">Оценка налога НПД<b>{}</b></div>\
         <div class=\"card\">Вычет остался<b>{}</b></div>\
         <div class=\"card\">Без чека<b class=\"{}\">{}</b></div>\
         </div>",
        escape_html(&r.income_text),
        escape_html(&r.tax_text),
        escape_html(&money_text(r.deduction_left_kopecks)),
        if r.unaccounted > 0 { "bad" } else { "ok" },
        r.unaccounted,
    ));

    if !r.entries.is_empty() {
        h.push_str("<h2>Без чека</h2>");
        if r.unaccounted == 0 {
            h.push_str("<p class=\"note ok\">Все успешные оплаты учтены.</p>");
        } else {
            h.push_str(
                "<table><tr><th>Дата (МСК)</th><th>Сумма</th><th>Описание</th><th>Чек до</th><th></th></tr>",
            );
            for e in r.entries.iter().filter(|e| e.receipt_at.is_none()) {
                h.push_str(&format!(
                    "<tr><td>{}{}</td><td>{}</td><td>{}</td><td class=\"{}\">{}</td>\
                     <td><form method=\"post\" action=\"/admin/receipt\">\
                     <input type=\"hidden\" name=\"csrf\" value=\"{}\">\
                     <input type=\"hidden\" name=\"payment_id\" value=\"{}\">\
                     <button type=\"submit\">Чек сформирован</button></form></td></tr>",
                    escape_html(&e.created_msk),
                    if e.test { " <span class=\"bad\">(тест)</span>" } else { "" },
                    escape_html(&e.amount_text),
                    escape_html(&e.description),
                    if e.receipt_overdue { "bad" } else { "" },
                    escape_html(&e.receipt_deadline),
                    escape_html(csrf),
                    escape_html(&e.id),
                ));
            }
            h.push_str("</table>");
        }

        h.push_str("<h2>Все успешные оплаты</h2><table>");
        h.push_str("<tr><th>Дата (МСК)</th><th>Сумма</th><th>Описание</th><th>Чек</th><th>Платёж</th></tr>");
        for e in &r.entries {
            let mark = match e.receipt_at {
                Some(at) => format!("<span class=\"ok\">✓ {}</span>", date_text(msk_date(at))),
                None => "<span class=\"bad\">нет</span>".to_string(),
            };
            h.push_str(&format!(
                "<tr><td>{}{}</td><td>{}</td><td>{}</td><td>{}</td><td><code>{}</code></td></tr>",
                escape_html(&e.created_msk),
                if e.test { " <span class=\"bad\">(тест)</span>" } else { "" },
                escape_html(&e.amount_text),
                escape_html(&e.description),
                mark,
                escape_html(&e.id),
            ));
        }
        h.push_str("</table>");
    }

    if !r.months.is_empty() {
        h.push_str("<h2>Месяцы и налог</h2><table>");
        h.push_str("<tr><th>Месяц</th><th>Доход</th><th>Налог (оценка)</th><th>Без чека</th><th>Чек до</th><th>Налог до</th><th>Статус</th></tr>");
        for m in &r.months {
            let status = if m.tax_paid {
                "<span class=\"ok\">налог отмечен уплаченным</span>".to_string()
            } else if m.tax_overdue {
                "<span class=\"bad\">срок уплаты прошёл</span>".to_string()
            } else {
                format!(
                    "<form method=\"post\" action=\"/admin/tax-paid\">\
                     <input type=\"hidden\" name=\"csrf\" value=\"{}\">\
                     <input type=\"hidden\" name=\"month\" value=\"{}\">\
                     <button type=\"submit\">Налог уплачен</button></form>",
                    escape_html(csrf),
                    escape_html(&m.key),
                )
            };
            h.push_str(&format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td class=\"{}\">{}</td><td class=\"{}\">{}</td><td class=\"{}\">{}</td><td>{}</td></tr>",
                escape_html(&m.label),
                escape_html(&m.income_text),
                escape_html(&m.tax_text),
                if m.unaccounted > 0 { "bad" } else { "" },
                m.unaccounted,
                if m.receipt_overdue { "bad" } else { "" },
                escape_html(&m.receipt_deadline),
                if m.tax_overdue { "bad" } else { "" },
                escape_html(&m.tax_deadline),
                status,
            ));
        }
        h.push_str("</table>");
    } else {
        h.push_str("<p class=\"note\">Успешных оплат пока нет.</p>");
    }

    h.push_str(&format!(
        "<p class=\"note\">Неоплаченных (pending): {}, отменённых: {}.</p>",
        r.pending, r.canceled
    ));
    if r.unparsed > 0 {
        h.push_str(&format!(
            "<div class=\"warn\">Не удалось разобрать {} успешных платежей (сумма/дата/валюта) — проверьте кабинет ЮKassa.</div>",
            r.unparsed
        ));
    }
    h.push_str(
        "<h2>Правила</h2><ul class=\"note\">\
         <li>НПД: 4% с доходов от физлиц; вычет 10 000 ₽ ФНС применяет автоматически — пока он не исчерпан, ставка фактически 3%.</li>\
         <li>Чек при безналичном расчёте — не позднее 9-го числа следующего месяца (422-ФЗ); штраф за непредставление — 20% суммы расчёта, минимум 1000 ₽.</li>\
         <li>Налог ФНС начисляет сама: сумма появляется в «Мой налог» до 12-го числа, платить — до 28-го. Здесь только оценка.</li>\
         <li>ЮKassa перечисляет деньги сводной выплатой; каждый платёж виден в кабинете «Платежи» и на этой странице.</li>\
         <li>Страница доступна только с localhost (SSH-туннель), действия подтверждаются CSRF-токеном.</li>\
         </ul></body></html>",
    );
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, status: &str, at: &str, value: &str) -> PaymentRow {
        PaymentRow {
            id: id.into(),
            status: status.into(),
            paid: status == "succeeded",
            created_at: at.into(),
            amount: crate::payments::PaymentAmount {
                value: value.into(),
                currency: "RUB".into(),
            },
            description: "Vault pro: 1 мес".into(),
            test: false,
        }
    }

    #[test]
    fn amount_parses_rubles_and_kopecks() {
        assert_eq!(parse_amount_kopecks("149.00"), Some(14_900));
        assert_eq!(parse_amount_kopecks("149"), Some(14_900));
        assert_eq!(parse_amount_kopecks("0.5"), Some(50));
        assert_eq!(parse_amount_kopecks(" 1490.10 "), Some(149_010));
        assert_eq!(parse_amount_kopecks("149.999"), None);
        assert_eq!(parse_amount_kopecks("149,00"), None);
        assert_eq!(parse_amount_kopecks("-1.00"), None);
        assert_eq!(parse_amount_kopecks(""), None);
    }

    #[test]
    fn msk_shifts_utc_and_rolls_month() {
        assert_eq!(msk_date(0), Date { y: 1970, m: 1, d: 1 });
        let (d, h, _) = msk_from_iso("2026-10-31T06:45:44.123Z").unwrap();
        assert_eq!((d, h), (Date { y: 2026, m: 10, d: 31 }, 9));
        let (d, h, _) = msk_from_iso("2026-10-31T21:30:00Z").unwrap();
        assert_eq!((d, h), (Date { y: 2026, m: 11, d: 1 }, 0));
        let (d, _, _) = msk_from_iso("2026-12-31T22:00:00Z").unwrap();
        assert_eq!(d, Date { y: 2027, m: 1, d: 1 });
        assert!(msk_from_iso("2026-13-01T00:00:00Z").is_none());
        assert!(msk_from_iso("2026-02-30T00:00:00Z").is_none());
    }

    #[test]
    fn money_text_has_kopecks_and_grouping() {
        assert_eq!(money_text(14_900), "149,00 ₽");
        assert_eq!(money_text(447), "4,47 ₽");
        assert_eq!(money_text(123_456_789), "1 234 567,89 ₽");
    }

    fn report_for(rows: &[PaymentRow], receipts: &[(&str, u64)], tax_paid: &[&str], now: u64) -> Report {
        let mut ledger = Ledger::default();
        for (id, at) in receipts {
            ledger.receipts.insert((*id).into(), *at);
        }
        for m in tax_paid {
            ledger.tax_paid.insert((*m).into(), now);
        }
        build_report(rows, &ledger, now)
    }

    // 31.10.2026 09:45 MSK (06:45 UTC).
    const NOW: u64 = 1_793_429_100;

    #[test]
    fn report_marks_unaccounted_and_counts_tax_with_deduction() {
        let rows = vec![
            row("pay_a", "succeeded", "2026-10-31T06:45:44Z", "149.00"),
            row("pay_b", "succeeded", "2026-10-31T06:47:53Z", "149.00"),
            row("pay_c", "pending", "2026-10-31T06:50:00Z", "149.00"),
            row("pay_d", "canceled", "2026-10-30T14:05:07Z", "149.00"),
        ];
        let r = report_for(&rows, &[("pay_a", NOW - 60)], &[], NOW);
        assert_eq!(r.entries.len(), 2, "pending/canceled — не доход");
        assert_eq!(r.unaccounted, 1);
        assert_eq!(r.pending, 1);
        assert_eq!(r.canceled, 1);
        assert_eq!(r.income_kopecks, 29_800);
        // 4% = 1192 коп; вычет 1% = 298 коп → налог 894 коп (по 447 на платёж).
        assert_eq!(r.tax_kopecks, 894);
        assert_eq!(r.deduction_left_kopecks, DEDUCTION_KOPECKS - 298);
        // Чек за оплату сдают до 9-го СЛЕДУЮЩЕГО месяца, а не в месяц оплаты.
        assert_eq!(r.entries[0].receipt_deadline, "09.11.2026");
        let m = &r.months[0];
        assert_eq!(m.key, "2026-10");
        assert_eq!(m.receipt_deadline, "09.11.2026");
        assert_eq!(m.tax_deadline, "28.11.2026");
        assert!(!m.receipt_overdue, "срок чека ещё не прошёл");
        assert!(!m.tax_overdue);
        assert!(!m.tax_paid);
    }

    #[test]
    fn deduction_exhausts_then_full_rate() {
        let rows = vec![
            row("pay_big", "succeeded", "2026-09-10T10:00:00Z", "2000000.00"),
            row("pay_small", "succeeded", "2026-10-10T10:00:00Z", "149.00"),
        ];
        let r = report_for(&rows, &[], &[], NOW);
        // Сентябрь: 4% = 8 000 000 коп; вычет 1% = 2 000 000, но бюджета
        // 1 000 000 → налог 7 000 000, вычет исчерпан.
        assert_eq!(r.months[0].tax_kopecks, 7_000_000);
        assert_eq!(r.months[0].key, "2026-09");
        // Октябрь: вычет 0 → полные 4%.
        assert_eq!(r.months[1].tax_kopecks, 596);
        assert_eq!(r.deduction_left_kopecks, 0);
    }

    #[test]
    fn overdue_receipt_and_tax_are_flagged() {
        // 10.12.2026 09:00 MSK: октябрьский чек (до 09.11) и налог (до 28.11)
        // просрочены.
        let now = 1_796_882_400;
        let rows = vec![row("pay_a", "succeeded", "2026-10-31T06:45:44Z", "149.00")];
        let r = report_for(&rows, &[], &[], now);
        assert!(r.entries[0].receipt_overdue);
        assert!(r.months[0].receipt_overdue);
        assert!(r.months[0].tax_overdue);
        let paid = report_for(&rows, &[("pay_a", now)], &["2026-10"], now);
        assert!(!paid.entries[0].receipt_overdue);
        assert!(paid.months[0].tax_paid);
        assert!(!paid.months[0].tax_overdue);
    }

    #[test]
    fn unknown_amounts_are_reported_not_silently_dropped() {
        let rows = vec![
            row("pay_ok", "succeeded", "2026-10-31T06:45:44Z", "149.00"),
            row("pay_bad", "succeeded", "not-a-date", "149.00"),
            row("pay_eur", "succeeded", "2026-10-31T06:45:44Z", "149.00"),
        ];
        let mut rows = rows;
        rows[2].amount.currency = "EUR".into();
        let r = report_for(&rows, &[], &[], NOW);
        assert_eq!(r.income_kopecks, 14_900, "непонятное не раздувает доход");
        assert_eq!(r.unparsed, 2, "но и не исчезает из отчёта");
    }

    #[test]
    fn html_escapes_provider_text_and_carries_csrf() {
        let mut rows = vec![row("pay_a", "succeeded", "2026-10-31T06:45:44Z", "149.00")];
        rows[0].description = "Vault <script>alert(1)</script>".into();
        let r = report_for(&rows, &[], &[], NOW);
        let html = page_html(&r, "csrf-токен", None);
        assert!(html.contains("&lt;script&gt;"), "описание провайдера экранировано");
        assert!(!html.contains("<script>"));
        // CSRF стоит в КАЖДОЙ форме (чек и налог): одна форма без токена —
        // действие, которое чужой сайт отправит от имени владельца.
        assert_eq!(
            html.matches("name=\"csrf\" value=\"csrf-токен\"").count(),
            2,
            "csrf в обеих формах"
        );
        assert!(html.contains("action=\"/admin/receipt\""));
        assert!(html.contains("pay_a"));
        assert!(html.contains("Без чека"));
    }

    #[test]
    fn ledger_drops_junk_keys() {
        let mut l = Ledger::default();
        l.receipts.insert("pay_1".into(), 1);
        l.receipts.insert("bad key".into(), 1);
        l.receipts.insert("".into(), 1);
        l.tax_paid.insert("2026-10".into(), 1);
        l.tax_paid.insert("2026-13".into(), 1);
        l.tax_paid.insert("окт".into(), 1);
        l.sanitize();
        assert_eq!(l.receipts.len(), 1);
        assert_eq!(l.tax_paid.len(), 1);
        assert!(l.tax_paid.contains_key("2026-10"));
    }

    #[test]
    fn month_validation_accepts_calendar_months_only() {
        assert!(valid_month("2026-10"));
        assert!(valid_month("2000-01"));
        assert!(!valid_month("2026-00"));
        assert!(!valid_month("2026-13"));
        assert!(!valid_month("26-10"));
        assert!(!valid_month("2026-1"));
        assert!(!valid_month("2026_10"));
    }

    #[test]
    fn ledger_survives_save_and_load() {
        let dir = std::env::temp_dir().join(format!(
            "vault-accounting-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("accounting.json");
        let mut l = Ledger::default();
        l.receipts.insert("pay_1".into(), 1_793_429_100);
        l.tax_paid.insert("2026-10".into(), 1_796_882_400);
        l.save_atomic(&path).expect("save");
        let mode = std::fs::metadata(&path).expect("meta").permissions();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            mode.mode() & 0o777,
            0o600,
            "реестр — бухгалтерия, читает только владелец"
        );
        let back = Ledger::load(&path);
        assert_eq!(back.receipts.get("pay_1"), Some(&1_793_429_100));
        assert_eq!(back.tax_paid.get("2026-10"), Some(&1_796_882_400));
        // Порча файла — пустой реестр и живой релей, а не паника.
        std::fs::write(&path, "not json").expect("corrupt");
        assert!(Ledger::load(&path).receipts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
