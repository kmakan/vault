//! Правило протокола: время жизни (TTL) сообщения.
//!
//! ADR-005 R1 (эпик W4, `t_821261f7`): «решение о протоколе и формате —
//! в Rust». Правило «когда сообщение исчезает» — это протокол, а не UI:
//! отправитель объявляет TTL в конверте, получатель отсчитывает его от
//! момента доставки (created_at письма). Если арифметика живёт в JS, то
//! фронт и ядро считают разное — и «исчезающие» сообщения живут дольше или
//! меньше, чем обещано.
//!
//! Здесь — единственное место, где это правило определено. JS получает
//! готовые значения через Tauri-мост (`vault_ephemeral_*`) и только исполняет
//! их (взводит таймер, удаляет сообщение).
//!
//! Формат полей: `expire_at` — абсолютный момент истечения в миллисекундах
//! Unix-времени; 0 означает «сообщение не исчезает».

/// Момент истечения сообщения.
///
/// `base_ms` — отправная точка отсчёта (для получателя: `created_at` письма;
/// для отправителя: момент постановки в очередь). `ttl_secs` — объявленный TTL
/// в секундах. `ttl_secs <= 0` → сообщение не исчезает (`0`).
///
/// Переполнение исключено: `saturating_*` (огромный TTL даёт `i64::MAX`,
/// а не перелив в отрицательное время).
pub fn expire_at(base_ms: i64, ttl_secs: i64) -> i64 {
    if ttl_secs <= 0 {
        return 0;
    }
    base_ms.saturating_add(ttl_secs.saturating_mul(1000))
}

/// Истекло ли сообщение к моменту `now_ms`.
///
/// `expires_at == 0` → не истекает никогда.
pub fn is_expired(expires_at: i64, now_ms: i64) -> bool {
    expires_at > 0 && now_ms >= expires_at
}

/// Осталось до истечения в миллисекундах (0 — уже истекло или не истекает).
pub fn remaining_ms(expires_at: i64, now_ms: i64) -> i64 {
    if expires_at <= 0 {
        return 0;
    }
    (expires_at - now_ms).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_zero_means_never() {
        assert_eq!(expire_at(1_000_000, 0), 0);
        assert_eq!(expire_at(1_000_000, -5), 0);
    }

    #[test]
    fn expiry_is_base_plus_ttl() {
        assert_eq!(expire_at(1_000_000, 300), 1_000_000 + 300_000);
        assert_eq!(expire_at(0, 1), 1000);
    }

    #[test]
    fn huge_ttl_saturates_instead_of_overflowing() {
        // i64::MAX base + огромный TTL не должен перелиться в отрицательное.
        //
        // ВАЖНО: TTL здесь именно i64::MAX, а не i64::MAX / 1000. Прежний
        // вариант НЕ переполнял промежуточное умножение (i64::MAX/1000 * 1000
        // помещается в i64), поэтому тест проходил и при обычном перемножении
        // без насыщения — то есть ПРОВЕРЯЛ, НО НЕ ТО, ЧТО ЗАЯВЛЯЛ. Мутационный
        // гейт Rust-ядра (scripts/rust-mutation-gate.mjs) выловил именно это:
        // снятие `saturating_mul` оставалось зелёным.
        let e = expire_at(i64::MAX, i64::MAX);
        assert!(e > 0);
        assert_eq!(e, i64::MAX);
    }

    #[test]
    fn huge_base_saturates_instead_of_overflowing() {
        // Огромная база + умеренный TTL: сумма переполняется — результат
        // обязан насытиться до i64::MAX, а не перелиться в минус.
        let e = expire_at(i64::MAX - 10, 1_000_000);
        assert_eq!(e, i64::MAX);
    }

    #[test]
    fn is_expired_compares_with_now() {
        assert!(is_expired(1000, 1000));
        assert!(is_expired(1000, 1001));
        assert!(!is_expired(1000, 999));
    }

    #[test]
    fn never_expiring_message_is_not_expired() {
        assert!(!is_expired(0, i64::MAX));
    }

    #[test]
    fn remaining_is_clamped_to_zero() {
        assert_eq!(remaining_ms(2000, 1000), 1000);
        assert_eq!(remaining_ms(2000, 3000), 0);
        assert_eq!(remaining_ms(0, 1000), 0);
    }
}
