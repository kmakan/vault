//! CLI выдачи токенов подписки (M2.4 — экран/QR позже).
//!
//! vault-relay-gen <server_key_hex> read|write <days> [count]
//!   → печатает токены построчно (их отдаём пользователям: read = клиент
//!     получателя, write = право publish, если анонимный publish выключен).
//!
//! ПЛАТНЫЕ ТОКЕНЫ (v2, с тарифом):
//! vault-relay-gen <server_key_hex> read --plan pro [--months 12] [--sub 1] [count]
//!   → v2-токен с тарифом и сроком оплаты. Нужен для ручной выдачи (тестеры,
//!     поддержка, компенсации) — обычный покупатель получает токен через
//!     /relay/purchase/verify, где оплату подтверждает платёжный провайдер.
//!   → адрес очереди (topic) печатается в STDERR, чтобы stdout оставался
//!     пригодным для конвейера (по токену на строку).
//!
//! ПОЧЕМУ ТАК. Токен — не строка, а правило: срок, тариф и подписка связаны
//! между собой, и выпустить «Pro с нулевым сроком» можно только осознанно.
//! Поэтому CLI требует явный --months и --sub, а не угадывает их.

use vault_relay::tokens::Plan;

/// Разобранные параметры CLI.
#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub key_hex: String,
    pub scope: vault_relay::Scope,
    /// Срок обычного (v1) токена в днях. None — платный (v2) токен.
    pub days: Option<u32>,
    /// Тариф v2-токена.
    pub plan: Option<Plan>,
    /// Срок оплаты в месяцах (для v2).
    pub months: u32,
    /// Идентификатор подписки (для v2): по нему считается лимит устройств.
    pub sub: u64,
    pub count: usize,
}

/// Разобрать аргументы. Err — текст для печати в stderr и выход с кодом 2.
pub fn parse_args(args: &[String]) -> Result<Options, String> {
    if args.len() < 3 {
        return Err("usage: vault-relay-gen <server_key_hex(64)> read|write <days> [count]\n       vault-relay-gen <server_key_hex(64)> read|write --plan pro [--months 12] [--sub 1] [count]".into());
    }
    let key_hex = args[1].clone();
    let scope = match args[2].as_str() {
        "read" => vault_relay::Scope::Read,
        "write" => vault_relay::Scope::Write,
        other => return Err(format!("scope must be read|write (got {other})")),
    };

    let mut days: Option<u32> = None;
    let mut plan: Option<Plan> = None;
    let mut months: u32 = 12;
    let mut sub: u64 = 1;
    let mut count: usize = 1;

    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                let p = args.get(i).map(|s| s.as_str()).unwrap_or("");
                plan = Some(match p {
                    "free" => Plan::Free,
                    "trial" => Plan::Trial,
                    "pro" => Plan::Pro,
                    "business" => Plan::Business,
                    other => return Err(format!("plan must be free|trial|pro|business (got {other})")),
                });
            }
            "--months" => {
                i += 1;
                months = args
                    .get(i)
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| "bad --months".to_string())?;
            }
            "--sub" => {
                i += 1;
                sub = args
                    .get(i)
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| "bad --sub".to_string())?;
            }
            other if other.starts_with("--") => {
                return Err(format!("unknown flag {other}"));
            }
            other => {
                // Позиционные: сначала срок в днях, затем количество.
                if days.is_none() && plan.is_none() {
                    days = Some(
                        other
                            .parse()
                            .map_err(|_| format!("bad days: {other}"))?,
                    );
                } else {
                    count = other
                        .parse()
                        .map_err(|_| format!("bad count: {other}"))?;
                }
            }
        }
        i += 1;
    }

    if plan.is_none() && days.is_none() {
        return Err("нужен срок в днях (или --plan для платного токена)".into());
    }
    if plan.is_some() && days.is_some() {
        return Err("срок в днях и --plan вместе не имеют смысла: у платного токена срок оплаты".into());
    }
    Ok(Options {
        key_hex,
        scope,
        days,
        plan,
        months,
        sub,
        count,
    })
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn now_unix() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as u32
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let opts = match parse_args(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let key = match hex_decode(&opts.key_hex) {
        Some(k) if k.len() == 32 => k,
        _ => {
            eprintln!("bad key (need 64 hex chars)");
            std::process::exit(2);
        }
    };
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    let keys = vault_relay::ServerKeys::new(arr);
    let now = now_unix();

    match opts.plan {
        Some(plan) => {
            // Платный токен: срок оплаты в месяцах, привязка к подписке.
            let paid_until = now.saturating_add(opts.months.saturating_mul(30 * 86400));
            for _ in 0..opts.count {
                let token = vault_relay::tokens::issue_v2(
                    &keys,
                    opts.scope,
                    plan,
                    opts.sub,
                    paid_until,
                );
                println!("{token}");
                // Адрес очереди — в stderr: stdout остаётся «токен на строку».
                if let Some(t) = vault_relay::parse(&keys, &token) {
                    eprintln!("topic: {} (plan {:?}, sub {}, до {})", t.hash, plan, opts.sub, paid_until);
                }
            }
        }
        None => {
            let days = opts.days.unwrap_or(30);
            let expiry = now.saturating_add(days.saturating_mul(86400));
            for _ in 0..opts.count {
                println!("{}", vault_relay::issue(&keys, opts.scope, expiry));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_parse_plain_token() {
        let o = parse_args(&args(&["gen", "aa", "read", "30"])).expect("разбор");
        assert_eq!(o.scope, vault_relay::Scope::Read);
        assert_eq!(o.days, Some(30));
        assert_eq!(o.plan, None);
        assert_eq!(o.count, 1);
    }

    #[test]
    fn test_parse_plain_token_with_count() {
        let o = parse_args(&args(&["gen", "aa", "write", "7", "5"])).expect("разбор");
        assert_eq!(o.scope, vault_relay::Scope::Write);
        assert_eq!(o.days, Some(7));
        assert_eq!(o.count, 5);
    }

    #[test]
    fn test_parse_paid_token() {
        let o = parse_args(&args(&["gen", "aa", "read", "--plan", "pro"])).expect("разбор");
        assert_eq!(o.plan, Some(Plan::Pro));
        assert_eq!(o.months, 12);
        assert_eq!(o.sub, 1);
        assert_eq!(o.days, None, "у платного токена срок в днях не задаётся");
    }

    #[test]
    fn test_parse_paid_token_with_months_and_sub() {
        let o = parse_args(&args(&[
            "gen", "aa", "read", "--plan", "business", "--months", "3", "--sub", "42", "2",
        ]))
        .expect("разбор");
        assert_eq!(o.plan, Some(Plan::Business));
        assert_eq!(o.months, 3);
        assert_eq!(o.sub, 42);
        assert_eq!(o.count, 2);
    }

    #[test]
    fn test_rejects_unknown_plan() {
        let e = parse_args(&args(&["gen", "aa", "read", "--plan", "premium"])).err().expect("ошибка");
        assert!(e.contains("plan must be"), "{e}");
    }

    #[test]
    fn test_rejects_days_together_with_plan() {
        // Срок в днях и тариф — два разных срока; вместе они бессмысленны.
        let e = parse_args(&args(&["gen", "aa", "read", "30", "--plan", "pro"])).err().expect("ошибка");
        assert!(e.contains("не имеют смысла"), "{e}");
    }

    #[test]
    fn test_rejects_missing_days() {
        let e = parse_args(&args(&["gen", "aa", "read"])).err().expect("ошибка");
        assert!(e.contains("нужен срок"), "{e}");
    }

    #[test]
    fn test_rejects_unknown_flag() {
        let e = parse_args(&args(&["gen", "aa", "read", "--plan", "pro", "--wat", "1"])).err().expect("ошибка");
        assert!(e.contains("unknown flag"), "{e}");
    }
}
