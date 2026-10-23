//! Окна, пороги и часы фоновой доставки (ADR-005 §W4, партия 3).
//!
//! ЗАЧЕМ В ЯДРЕ. Числа «когда сигнал считается протухшим» и «когда повтор
//! считается атакой» — это решения протокола, а не настройки транспорта: они
//! определяют, проснётся ли телефон от перехваченного письма месячной давности
//! и увидит ли пользователь свежее. До переноса они жили в
//! `vault-desktop/src-tauri/src/monitor_invariants.rs`, то есть в мосту,
//! который `rust-mutation-gate` не меряет (гейт считает наборы по крейту
//! `vault-client`), и в том же крейте, который CLI-слушатель не использует.
//! Следствие уже было пройдено в партии 1: копия числа со временем начинает
//! означать другое.
//!
//! ДУБЛИ, КОТОРЫЕ МЕРЯЮТСЯ ЗДЕСЬ (23.10, поиск по фронту):
//!  * `features/incoming.js` — `FRESH_WINDOW_MS = 15*60*1000` (копия
//!    `FRESH_SECS`);
//!  * `features/profiles.js`, `features/history.js` — по копии `10*60*1000`;
//!  * `features/call-resend.js` — лестница, где `45000` совпадает с
//!    `RING_TIMEOUT_MS`: порядок «рингтон гаснет раньше, чем сигнал станет
//!    stale» держал только тест во мосту.
//! Числа остаются едиными, предикаты — чистыми: ни JNI, ни БД, ни сети.
//!
//! Зрелые предикаты принимают `now` параметром, поэтому прогон детерминирован:
//! мутация порога ловится тестом, а не везением с часами машины. Часы —
//! `now_ms`/`now_secs`, их вызывает мост.

/// Не уведомлять о письмах старше 15 минут.
pub const FRESH_SECS: i64 = 15 * 60;
/// `call_request` старше 10 мин — считается stale.
pub const CALL_STALE_MS: i64 = 10 * 60 * 1000;
/// `ringing` дольше 45 с → missed + пуш + dismiss уведомления.
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

/// Секунды с эпохи — единица, в которой живёт `ts` заголовков и конвертов.
pub fn now_secs() -> i64 {
    now_ms() / 1000
}

/// Свежесть по заголовку `Date` (RFC 2822) относительно `now_ms`.
///
/// Не распарсился — считаем свежим: окончательно решит `ts` конверта после
/// расшифровки (`CALL_STALE_MS`/`FRESH_SECS`). Осознанное решение
/// «неизвестное = свежее»: `Date` приходит от чужого MTA и может быть мусорным;
/// отбрасывать нераспарсенное означало бы глухой монитор на сломанном или
/// локальном MTA (и на письмах без `Date`). Цена — лишнее уведомление от
/// подделанного письма, от которого спасает второй рубеж.
pub fn date_fresh_at(date_header: &str, now_ms: i64) -> bool {
    match chrono::DateTime::parse_from_rfc2822(date_header.trim()) {
        Ok(dt) => now_ms / 1000 - dt.timestamp() < FRESH_SECS,
        Err(_) => true,
    }
}

/// [`date_fresh_at`] по текущим часам.
pub fn date_fresh(date_header: &str) -> bool {
    date_fresh_at(date_header, now_ms())
}

/// С какого элемента резать дедуп-список длиной `len`, чтобы осталось не больше
/// `cap` последних (значение — аргумент `Vec::split_off`).
///
/// `saturating_sub` — контракт: список короче лимита не режется вовсе, а не
/// паникует и не уходит в бесконечный индекс.
pub fn dedup_cut(len: usize, cap: usize) -> usize {
    len.saturating_sub(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 2822 `Date`, сдвинутый на `secs` секунд ОТ «сейчас» (минус = старее).
    fn date_offset(secs: i64) -> String {
        let dt = chrono::DateTime::from_timestamp(now_secs() + secs, 0).expect("valid timestamp");
        format!("{}", dt.naive_utc().format("%a, %d %b %Y %H:%M:%S +0000"))
    }

    // ── Реплей-защита (date_fresh) ──

    #[test]
    fn date_fresh_accepts_just_now() {
        assert!(
            date_fresh(&date_offset(0)),
            "письмо текущего момента — свежее"
        );
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
    fn date_fresh_rejects_month_old_replay() {
        // Реплей атаки: перехваченное письмо месячной давности не поднимает
        // уведомление и не будит экран звонка.
        assert!(!date_fresh(&date_offset(-30 * 24 * 3600)));
    }

    #[test]
    fn date_fresh_allows_future_skew() {
        // Часы отправителя уехали вперёд: `now - ts` уходит в минус → проходит.
        // Мягко к часам — фиксируем как контракт, а не как случайность.
        assert!(date_fresh(&date_offset(3600)));
    }

    #[test]
    fn date_fresh_tolerates_unparsable_header() {
        // «Неизвестно = свежее»: заголовок приходит от чужого MTA. Второй
        // рубеж — `CALL_STALE_MS` по `ts` расшифрованного конверта.
        assert!(date_fresh(""));
        assert!(date_fresh("garbage"));
        assert!(date_fresh("Mon, 99 Xxx 2099 99:99:99 +0000"));
    }

    #[test]
    fn date_fresh_trims_surrounding_whitespace() {
        let stamp = date_offset(0);
        assert!(
            date_fresh(&format!("  {stamp}  ")),
            "лишние пробелы в заголовке не должны ломать разбор"
        );
        // Отдельно и важно: пробелы НЕ должны превращать заголовок в
        // «нераспарсился = свежее». Иначе тест выше проходил бы и при сломанном
        // разборе, а просроченное письмо будило бы телефон.
        let parsed = chrono::DateTime::parse_from_rfc2822(&stamp)
            .expect("stamp parses")
            .timestamp();
        assert!(
            !date_fresh_at(&format!("  {stamp}  "), (parsed + FRESH_SECS + 1) * 1000),
            "старое письмо с пробелами обязано отсеяться по возрасту, а не «простить»"
        );
    }

    #[test]
    fn date_fresh_handles_named_timezones() {
        // Реальные MTA пишут +0300/-0500 — разбор обязан это понимать.
        let now = now_secs();
        for offset_hours in [3, -5] {
            let tz = chrono::FixedOffset::east_opt(offset_hours * 3600).expect("fixed offset");
            let dt = chrono::DateTime::from_timestamp(now, 0)
                .expect("valid timestamp")
                .with_timezone(&tz);
            let stamp = format!("{}", dt.format("%a, %d %b %Y %H:%M:%S %z"));
            assert!(
                date_fresh(&stamp),
                "смещение зоны {offset_hours} не должно ломать свежесть"
            );
        }
    }

    #[test]
    fn date_fresh_at_is_driven_by_the_passed_clock() {
        // Предикат с явным `now` — тот, что меряют мутации: без него порог
        // зависел бы от часов машины и тесты плыли бы.
        let stamp = date_offset(0);
        let parsed = chrono::DateTime::parse_from_rfc2822(&stamp)
            .expect("stamp parses")
            .timestamp();
        assert!(date_fresh_at(&stamp, parsed * 1000));
        assert!(
            !date_fresh_at(&stamp, (parsed + FRESH_SECS) * 1000),
            "на пороге окно уже закрыто"
        );
    }

    // ── Дедуп-список ──

    #[test]
    fn dedup_keeps_the_newest_cap_and_never_panics_when_short() {
        assert_eq!(dedup_cut(0, SEEN_CAP), 0);
        assert_eq!(dedup_cut(199, SEEN_CAP), 0, "короче лимита — не режем");
        assert_eq!(dedup_cut(200, SEEN_CAP), 0);
        assert_eq!(dedup_cut(201, SEEN_CAP), 1, "остался ровно лимит");
        let mut list: Vec<usize> = (0..205).collect();
        let kept = list.split_off(dedup_cut(list.len(), SEEN_CAP));
        assert_eq!(kept.len(), SEEN_CAP);
        assert_eq!(kept.first(), Some(&5), "вылетают самые старые");
    }

    // ── Порядок таймаутов (регрессии = «вечный рингтон» / «воскресший звонок») ──

    #[test]
    fn thresholds_are_the_numbers_their_names_claim() {
        // Числа протокола, зашитые в переписку и привычку пользователя: их
        // нельзя править «по ходу дела» — сдвиг на единицу либо не замечен
        // вовсе (тесты меряют окна ОТ носителя), либо ломает согласованность
        // ниже. Поэтому пинимся literal'ами, а не только соотношениями.
        assert_eq!(FRESH_SECS, 15 * 60, "окно свежести письма — 15 минут");
        assert_eq!(
            CALL_STALE_MS,
            10 * 60 * 1000,
            "call_request протухает за 10 мин"
        );
        assert_eq!(RING_TIMEOUT_MS, 45 * 1000, "гудок без решения — 45 с");
        assert_eq!(
            CALL_TOMBSTONE_MS,
            10 * 60 * 1000,
            "надгробие missed — 10 мин"
        );
        assert_eq!(SEEN_CAP, 200, "дедуп держит 200 Message-ID");
    }

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
        assert_eq!(now_secs(), a / 1000, "секунды — те же часы, что и мс");
    }
}
