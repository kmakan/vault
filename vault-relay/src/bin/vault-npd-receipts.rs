//! Автоматические чеки НПД: сверка «оплата в ЮKassa ↔ чек в Мой налог».
//!
//! ЗАПУСК (systemd-таймер, см. deploy/vault-npd-receipts.timer):
//!   VAULT_NPD_DEVICE_ID=… VAULT_NPD_REFRESH_TOKEN=… vault-npd-receipts
//!   vault-npd-receipts --check   # только показать, ничего не отправлять
//!
//! ВЫХОД: 0 — сверка прошла (в том числе «нечего оформлять»); 1 — ошибка
//! провайдера или ЛКФЛ; 2 — нет настроек. Ненулевой код нужен, чтобы systemd
//! пометил запуск упавшим, а не «тихо зелёным»: молчащий чек — это штраф.
//!
//! ЧТО НЕ ДЕЛАЕТ. Не отменяет и не правит уже выданные чеки: отмена — решение
//! человека (возврат денег), и автоматика, которая «исправляет» документы
//! сама, опаснее пропущенного чека.

use vault_relay::npd::{self, missing_receipts, service_name, state_path_from_env, NpdClient, NpdState};
use vault_relay::payments::{YkProvider, PaymentProvider};

#[tokio::main]
async fn main() {
    let check_only = std::env::args().any(|a| a == "--check");
    match run(check_only).await {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("vault-npd-receipts: {e}");
            std::process::exit(1);
        }
    }
}

async fn run(check_only: bool) -> Result<i32, String> {
    let state_path = state_path_from_env();
    let mut state = NpdState::load(&state_path);

    // refresh-токен: окружение главнее файла, чтобы ротация на сервере
    // работала без правки состояния.
    let refresh_token = match std::env::var("VAULT_NPD_REFRESH_TOKEN") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => state.token.refresh_token.clone(),
    };
    if refresh_token.trim().is_empty() {
        return Err("нет refresh-токена: VAULT_NPD_REFRESH_TOKEN пуст и в состоянии пусто (код 2)".to_string());
    }

    let client = NpdClient::from_env()?;
    let token = client.refresh(&refresh_token).await?;
    state.token = token.clone();

    let yk = YkProvider::from_env()?;
    let payments = yk.list_payments(100).await.map_err(|e| format!("платежи ЮKassa: {e:?}"))?;
    let incomes = client.list_incomes(&token.token).await?;

    let missing = missing_receipts(&payments, &incomes, &state.registered);
    println!(
        "сверка: платежей {}, чеков у ФНС {}, без чека {}",
        payments.len(),
        incomes.len(),
        missing.len()
    );

    if missing.is_empty() {
        state.save_atomic(&state_path)?;
        return Ok(0);
    }

    let mut failed = 0usize;
    for p in &missing {
        let operation_time = match npd::msk_iso(&p.created_at) {
            Some(t) => t,
            None => {
                eprintln!("  ! {} — время не разобрано ({}), пропуск", p.id, p.created_at);
                failed += 1;
                continue;
            }
        };
        let kopecks = match vault_relay::accounting::parse_amount_kopecks(&p.amount.value) {
            Some(k) => k,
            None => {
                eprintln!("  ! {} — сумма не разобрана ({}), пропуск", p.id, p.amount.value);
                failed += 1;
                continue;
            }
        };
        let name = service_name(&p.description);
        if check_only {
            println!(
                "  [check] {} — {} ₽ ({}) «{}»",
                p.id,
                npd::kopecks_text(kopecks),
                operation_time,
                name
            );
            continue;
        }
        match client.register_income(&token.token, kopecks, &name, &operation_time).await {
            Ok(uuid) => {
                println!("  + {} — чек {} на {} ₽", p.id, uuid, npd::kopecks_text(kopecks));
                state.registered.insert(p.id.clone(), uuid);
                // Сохраняем после каждого чека: обрыв на середине пачки не
                // должен привести к повторной отправке уже выданных.
                state.save_atomic(&state_path)?;
            }
            Err(e) => {
                eprintln!("  ! {} — чек не выдан: {e}", p.id);
                failed += 1;
            }
        }
    }

    state.save_atomic(&state_path)?;
    if failed > 0 {
        return Ok(1);
    }
    Ok(0)
}
