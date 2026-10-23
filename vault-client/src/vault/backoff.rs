//! Лестница переподключения (backoff) для почтовой сессии (ADR-005 §W4).
//!
//! ЗАЧЕМ В ЯДРЕ. Это состояние соединения, а не транспорт: решение «расти
//! паузу, не передвигать дедлайн и не начинать серию заново» определяет,
//! дойдёт ли клиент до живого соединения или замрёт. Оба livelock'а, которые
//! здесь случились (телефон X50, 04.10.2026, 0.1.210), были именно поломками
//! этой арифметики, и проверить их мутациями можно только в `vault-client`
//! (набор `rust-backoff`). Мост остаётся с часами: `Instant` знает только он.
//!
//! Пауза считается в `Duration`; момент времени к нему прикладывает вызывающий.

use std::time::Duration;

/// Ступени паузы, секунды. Первая неудача — 2с, дальше 5/15/30, плато 60с.
pub const STEPS_SEC: [u64; 5] = [2, 5, 15, 30, 60];

/// Пауза для серии из `fail_streak` неудач (streak=0 → первая ступень).
pub fn delay_for_streak(fail_streak: u32) -> Duration {
    let idx = (fail_streak.saturating_sub(1) as usize).min(STEPS_SEC.len() - 1);
    Duration::from_secs(STEPS_SEC[idx])
}

/// Сколько ждать до следующей CONNECT-попытки.
///
/// * `fail_streak` — счётчик неудач серии (уже с учётом текущей);
/// * `remaining_active` — остаток ТЕКУЩЕЙ паузы, `None` если активной паузы нет
///   (первая неудача серии или предыдущая истекла).
///
/// Ключевое свойство — **дедлайн не продлевается**: если пауза ещё не
/// истекла, возвращается её же остаток, сколько бы новых неудач ни пришло.
/// Иначе серия неудач (фаст-путь «сессии нет → ошибка → note_failure»
/// повторяется каждые ~3 мс) бесконечно сдвигала бы дедлайн вперёд, пауза не
/// истекала бы НИКОГДА и сессия не строилась бы никогда — второй livelock
/// 04.10.2026: 32 «reconnect deferred» за 40с при streak=492 и ноль успешных
/// подключений.
pub fn plan_pause(fail_streak: u32, remaining_active: Option<Duration>) -> Duration {
    match remaining_active {
        Some(remaining) => remaining,
        None => delay_for_streak(fail_streak),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ladder_grows_and_plateaus() {
        assert_eq!(delay_for_streak(0), Duration::from_secs(2));
        assert_eq!(delay_for_streak(1), Duration::from_secs(2));
        assert_eq!(delay_for_streak(2), Duration::from_secs(5));
        assert_eq!(delay_for_streak(3), Duration::from_secs(15));
        assert_eq!(delay_for_streak(4), Duration::from_secs(30));
        assert_eq!(delay_for_streak(5), Duration::from_secs(60));
        // Плато: длинная серия не уходит в бесконечность и не переполняется.
        assert_eq!(delay_for_streak(6), Duration::from_secs(60));
        assert_eq!(delay_for_streak(u32::MAX), Duration::from_secs(60));
    }

    #[test]
    fn active_pause_is_not_extended_by_new_failures() {
        let active = Duration::from_secs(17);
        // Любой streak внутри активной паузы возвращает её остаток.
        for streak in [1u32, 2, 5, 492, u32::MAX] {
            assert_eq!(
                plan_pause(streak, Some(active)),
                active,
                "серия сдвинула дедлайн (streak={streak}) — пауза не истечёт никогда"
            );
        }
    }

    #[test]
    fn expired_pause_restarts_the_ladder_from_the_current_streak() {
        assert_eq!(plan_pause(1, None), Duration::from_secs(2));
        assert_eq!(plan_pause(3, None), Duration::from_secs(15));
        // Успех сбрасывает streak → следующая неудача снова 2с, а не 60с.
        assert_eq!(plan_pause(0, None), Duration::from_secs(2));
    }
}
