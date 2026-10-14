// Инварианты headless-монитора (эксо-режим Android).
//
// Вынесены из `service_monitor.rs` намеренно: тот модуль — `#[cfg(android)]`,
// поэтому его тесты нельзя прогнать на хосте (`cargo test` их просто не видит).
// А инварианты ниже — чистые предикаты без JNI/БД/сети, и именно они задают
// безопасность фоновой доставки:
//
//  * FRESH_SECS / CALL_STALE_MS — реплей-защита: старое письмо (перехваченное
//    в чужом ящике, подсунутое повторно, доставленное с задержкой) не должно
//    поднять уведомление или экран звонка;
//  * RING_TIMEOUT_MS / CALL_TOMBSTONE_MS — «звонок не должен звонить вечно» и
//    «пропущенный не должен ожить на поздней ретрансляции»;
//  * SEEN_CAP — дедуп-список обязан быть ограничен, иначе kv растёт без предела
//    и монитор деградирует на долгоживущем устройстве.
//
// Модуль компилируется на всех платформах → тесты идут в обычном `cargo test`.

/// Не уведомлять о письмах старше 15 минут.
pub const FRESH_SECS: i64 = 15 * 60;
/// call_request старше 10 мин — считается stale.
pub const CALL_STALE_MS: i64 = 10 * 60 * 1000;
/// ringing дольше 45 с → missed + пуш + dismiss уведомления.
pub const RING_TIMEOUT_MS: i64 = 45 * 1000;
/// Надгробие missed — 10 мин (переживает поздние ретрансляции).
pub const CALL_TOMBSTONE_MS: i64 = 10 * 60 * 1000;
/// Дедуп-список: последние 200 Message-ID.
pub const SEEN_CAP: usize = 200;

/// Миллисекунды с эпохи. 0, если системное время «до эпохи» (никогда в норме).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Свежесть по заголовку Date (RFC 2822). Не распарсился — считаем свежим:
/// окончательно решит ts конверта после расшифровки (CALL_STALE_MS/FRESH_SECS).
///
/// Осознанное решение «неизвестное = свежое»: заголовок Date приходит от
/// чужого MTA и может быть мусорным. Если бы мы отбрасывали нераспарсенное,
/// монитор глух был бы на сломанном/локальном MTA (и на письмах без Date).
/// Цена решения — лишнее уведомление от подделанного письма; от неё спасает
/// второй рубеж, `CALL_STALE_MS` по ts расшифрованного конверта.
pub fn date_fresh(date_header: &str) -> bool {
    match chrono::DateTime::parse_from_rfc2822(date_header.trim()) {
        Ok(dt) => now_ms() / 1000 - dt.timestamp() < FRESH_SECS,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 2822 Date, сдвинутый на `secs` секунд ОТ «сейчас» (минус = старее).
    fn date_offset(secs: i64) -> String {
        let dt = chrono::DateTime::from_timestamp(now_ms() / 1000 + secs, 0)
            .expect("valid timestamp")
            .naive_utc();
        format!("{}", dt.format("%a, %d %b %Y %H:%M:%S +0000"))
    }

    // ── Реплей-защита (date_fresh) ──

    #[test]
    fn date_fresh_accepts_just_now() {
        assert!(date_fresh(&date_offset(0)), "письмо текущего момента — свежее");
    }

    #[test]
    fn date_fresh_accepts_just_under_limit() {
        assert!(
            date_fresh(&date_offset(-(FRESH_SECS - 1))),
            "за секунду до порога письмо ещё считается свежим"
        );
    }

    #[test]
    fn date_fresh_rejects_just_over_limit() {
        assert!(
            !date_fresh(&date_offset(-(FRESH_SECS + 1))),
            "через порог письмо обязано отсеяться"
        );
    }

    #[test]
    fn date_fresh_rejects_old_letter() {
        assert!(
            !date_fresh(&date_offset(-(FRESH_SECS + 60))),
            "письмо старше 15 минут НЕ должно будить уведомлением"
        );
    }

    #[test]
    fn date_fresh_rejects_month_old_replay() {
        // Реплей атаки: перехваченное письмо месячной давности не поднимает звонок.
        assert!(!date_fresh(&date_offset(-30 * 24 * 3600)));
    }

    #[test]
    fn date_fresh_allows_future_skew() {
        // Часы отправителя уехали вперёд: now - ts уходит в минус → проходит.
        // Это осознанно (мягко к часам), фиксируем поведение как контракт.
        assert!(date_fresh(&date_offset(3600)));
    }

    #[test]
    fn date_fresh_tolerates_unparsable_header() {
        // «Неизвестно = свежое»: заголовок приходит от чужого MTA. Отбрасывать
        // нераспарсенное нельзя — иначе глухой монитор на сломанном MTA.
        // Второй рубеж — CALL_STALE_MS по ts расшифрованного конверта.
        assert!(date_fresh(""));
        assert!(date_fresh("garbage"));
        assert!(date_fresh("Mon, 99 Xxx 2099 99:99:99 +0000"));
    }

    #[test]
    fn date_fresh_trims_surrounding_whitespace() {
        assert!(
            date_fresh(&format!("  {}  ", date_offset(0))),
            "лишние пробелы в заголовке не должны ломать разбор"
        );
    }

    #[test]
    fn date_fresh_handles_named_timezones() {
        // Реальные MTA пишут +0300/-0500 — разбор обязан это понимать.
        let now = now_ms() / 1000;
        for offset_hours in [3, -5] {
            let tz = chrono::FixedOffset::east_opt(offset_hours * 3600).expect("fixed offset");
            let dt = chrono::DateTime::from_timestamp(now, 0)
                .expect("valid timestamp")
                .with_timezone(&tz);
            let stamp = format!("{}", dt.format("%a, %d %b %Y %H:%M:%S %z"));
            assert!(date_fresh(&stamp), "смещение зоны {offset_hours} не должно ломать свежесть");
        }
    }

    // ── Порядок таймаутов (регрессии = «вечный рингтон» / «воскресший звонок») ──

    #[test]
    fn ring_timeout_fits_call_window() {
        assert!(RING_TIMEOUT_MS > 0);
        assert!(
            RING_TIMEOUT_MS < CALL_STALE_MS,
            "ring-timeout обязан сработать раньше stale-фильтра"
        );
        assert!(
            RING_TIMEOUT_MS / 1000 < FRESH_SECS,
            "звонок не должен пережить окно свежести писем"
        );
    }

    #[test]
    fn tombstone_outlives_ring_timeout() {
        assert!(
            CALL_TOMBSTONE_MS > RING_TIMEOUT_MS,
            "надгробие missed обязано жить дольше ring-timeout, иначе поздняя \
             ретрансляция снова «оживит» звонок"
        );
    }

    #[test]
    fn seen_cap_is_bounded() {
        assert!(SEEN_CAP > 0, "нулевой лимит = дедуп выключен");
        assert!(
            SEEN_CAP <= 1000,
            "лимит дедупа раздулся — kv на устройстве будет расти без предела"
        );
    }

    #[test]
    fn now_ms_is_positive_and_monotonic() {
        let a = now_ms();
        let b = now_ms();
        assert!(a > 0, "нулевое время обнулит все таймауты разом");
        assert!(b >= a, "now_ms не должен идти назад");
    }
}
