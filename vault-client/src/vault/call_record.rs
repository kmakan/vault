//! Состояние ЗАПИСИ о звонке: журнал headless-монитора (ADR-005 §W4).
//!
//! ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. `vault::call_state` — машина состояний ЖИВОГО
//! звонка (idle / гудки / разговор) у одной стороны. Здесь другое: то, что
//! монитор пишет в kv по `call_id`, чтобы входящий сигнал не исполнился дважды.
//! Словарь состояний записи — `ringing / accepted / rejected / missed / ended`
//! — это протокол, и он жил в `src-tauri/src/service_monitor.rs`, то есть:
//!
//! * внутри `#[cfg(android)]`-модуля — его тесты на хосте вообще не
//!   компилируются, значит их не видит ни `cargo test` на дев-машине, ни CI;
//! * вне `rust-mutation-gate`, который меряет только крейт `vault-client`.
//!
//! Цена та же, что с почтовыми правилами (партия 1, `t_57d6a675`): правило
//! «поздняя ретрансляция не должна оживить пропущенный звонок» проверялось
//! только живой приёмкой на телефоне, а оно как раз из тех, чья поломка
//! незаметна в тесте и заметна в 3 часа ночи.
//!
//! Здесь — ТОЛЬКО вердикт. Обращения к БД, JNI-уведомления, пуши и часы
//! остаются во мосту: это и есть ввод-вывод.

/// Состояние записи о звонке в журнале монитора (kv).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordState {
    /// Звонок показан (или ретранслирован), решения нет.
    Ringing,
    /// Принят (активный разговор тоже считается принятым).
    Accepted,
    /// Отклонён.
    Rejected,
    /// Пропущен (позвонили и не дождались).
    Missed,
    /// Завершён (cancel / end / hangup).
    Ended,
}

impl RecordState {
    /// Имя состояния — ровно то, что лежит в kv и что пишет мост.
    pub fn as_str(self) -> &'static str {
        match self {
            RecordState::Ringing => "ringing",
            RecordState::Accepted => "accepted",
            RecordState::Rejected => "rejected",
            RecordState::Missed => "missed",
            RecordState::Ended => "ended",
        }
    }

    /// Разбор имени из хранилища. Незнакомая строка — `None`: запись
    /// повреждена или написана другой версией, решать по ней нельзя.
    pub fn parse(s: &str) -> Option<RecordState> {
        match s {
            "ringing" => Some(RecordState::Ringing),
            "accepted" => Some(RecordState::Accepted),
            "rejected" => Some(RecordState::Rejected),
            "missed" => Some(RecordState::Missed),
            "ended" => Some(RecordState::Ended),
            _ => None,
        }
    }
}

/// Вердикт монитора по сигналу звонка: что сделать, без I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// Терминальный сигнал (`call_cancel` / `call_end` / `call_reject`):
    /// запись переходит в `ended`, уведомления нет.
    Terminate,
    /// Ретрансляция `call_request`, когда гудок уже показан: ничего не делать.
    /// Ни перезапуска рингтона, ни обновления уведомления — иначе «звонок не
    /// заканчивается никогда», потому что звонящий ретранслирует запрос.
    Retransmission,
    /// Запись уже в решённом состоянии — молчать (надгробие гасит всё после).
    Settled(RecordState),
    /// Первый свежий `call_request`: записать `ringing` и показать входящий от
    /// `caller`.
    Ring { caller: String },
    /// Молчать: сигнал не опознан, устарел или пришёл без `ts`.
    Silent,
}

/// Это сигнал звонка (`call_request`, `call_end`, …)?
pub fn is_call_signal(typ: &str) -> bool {
    typ.starts_with("call_")
}

/// Вердикт по пришедшему сигналу звонка.
///
/// Аргументы — уже извлечённые из конверта значения; часы передаёт вызывающий,
/// ядро не знает `SystemTime`.
///
/// * `env_ts` — `ts` конверта в миллисекундах (0, если поля нет);
/// * `now` — текущее время в тех же миллисекундах;
/// * `fresh_window_ms` — за его пределами сигнал запоздавший (реплей-защита:
///   перехваченное и повторно доставленное письмо не должно поднять экран
///   звонка);
/// * `existing` — состояние записи по этому `call_id`, либо `None`, если записи нет;
/// * `name` / `email` — отображаемое имя звонящего и его адрес: пустое имя не
///   показывается, берётся адрес.
///
/// Порядок правил и есть поведение. Терминальные сигналы проверяются ДО
/// фильтра свежести: просроченный `call_end` обязан погасить зависший ringing,
/// иначе на устройстве остаётся «вечный рингтон».
pub fn decide_incoming(
    typ: &str,
    env_ts: i64,
    now: i64,
    fresh_window_ms: i64,
    existing: Option<&str>,
    name: &str,
    email: &str,
) -> Incoming {
    if !is_call_signal(typ) {
        return Incoming::Silent;
    }
    if matches!(typ, "call_cancel" | "call_end" | "call_reject") {
        return Incoming::Terminate;
    }
    // Из сигналов показывать умеет только call_request: прочее (в том числе
    // неведомый подтип новой версии) — молчать, а не звонить.
    if typ != "call_request" {
        return Incoming::Silent;
    }
    if env_ts <= 0 || now - env_ts >= fresh_window_ms {
        return Incoming::Silent;
    }
    match existing {
        None => Incoming::Ring {
            caller: if name.is_empty() {
                email.to_string()
            } else {
                name.to_string()
            },
        },
        Some(raw) => match RecordState::parse(raw) {
            Some(RecordState::Ringing) => Incoming::Retransmission,
            Some(state) => Incoming::Settled(state),
            None => Incoming::Silent,
        },
    }
}

/// Строка, которую присылает JS о решении по звонку, → состояние записи.
///
/// JS сообщает ГЛАГОЛ действия (`accept` / `reject` / `end`), журнал хранит
/// СОСТОЯНИЕ, а активный разговор при этом равен `accepted`. Без отображения
/// монитор ставил `missed` поверх уже принятого звонка — телефон звонил, пока
/// абонеры говорили. Незнакомое значение возвращается как есть: выдумывать
/// состояние ядро не вправе, решает вызывающий.
pub fn report_state(state: &str) -> &str {
    match state {
        "accept" | "accepted" | "active" => RecordState::Accepted.as_str(),
        "reject" | "rejected" => RecordState::Rejected.as_str(),
        "end" | "ended" | "cancel" | "hangup" => RecordState::Ended.as_str(),
        other => other,
    }
}

/// Снимает ли сообщённое состояние уведомление о входящем звонке.
///
/// Это решение о протоколе (по каким записям гудок больше не звучит), а не
/// деталь JNI: если сверять строку из JS магическими строками во мосту,
/// опечатка в имени состояния превращается в «уведомление висит вечно».
/// `ended` сюда не входит: отбой из разговора приходит уже после `accepted`,
/// который уведомление и снял.
pub fn dismisses_ring(state: &str) -> bool {
    matches!(
        RecordState::parse(state),
        Some(RecordState::Accepted) | Some(RecordState::Rejected)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: i64 = 10 * 60 * 1000;
    const NOW: i64 = 1_700_000_000_000;

    fn decide(existing: Option<&str>) -> Incoming {
        decide_incoming(
            "call_request",
            NOW - 1000,
            NOW,
            WINDOW,
            existing,
            "Анна",
            "a@b.c",
        )
    }

    #[test]
    fn first_fresh_request_rings_with_caller_name() {
        assert_eq!(
            decide(None),
            Incoming::Ring {
                caller: "Анна".to_string()
            }
        );
        // Пустое имя показывать нечем — берём адрес звонящего.
        assert_eq!(
            decide_incoming("call_request", NOW - 1000, NOW, WINDOW, None, "", "a@b.c"),
            Incoming::Ring {
                caller: "a@b.c".to_string()
            }
        );
    }

    #[test]
    fn retransmission_while_ringing_does_not_restart_the_ring() {
        assert_eq!(decide(Some("ringing")), Incoming::Retransmission);
    }

    #[test]
    fn settled_records_never_revive_a_call() {
        for (raw, state) in [
            ("accepted", RecordState::Accepted),
            ("rejected", RecordState::Rejected),
            ("missed", RecordState::Missed),
            ("ended", RecordState::Ended),
        ] {
            assert_eq!(decide(Some(raw)), Incoming::Settled(state), "{raw}");
        }
    }

    #[test]
    fn terminal_signals_are_checked_before_the_freshness_filter() {
        // Просроченный call_end обязан погасить зависший ringing: иначе
        // «вечный рингтон» на устройстве.
        for typ in ["call_cancel", "call_end", "call_reject"] {
            assert_eq!(
                decide_incoming(typ, 0, NOW, WINDOW, Some("ringing"), "", ""),
                Incoming::Terminate,
                "{typ} без ts всё равно терминальный"
            );
        }
    }

    #[test]
    fn stale_or_timestampless_request_is_silent() {
        // Реплей: перехваченное письмо вчерашней давности не будит телефон.
        assert_eq!(
            decide_incoming(
                "call_request",
                NOW - WINDOW - 1,
                NOW,
                WINDOW,
                None,
                "Анна",
                "a@b.c"
            ),
            Incoming::Silent
        );
        assert_eq!(
            decide_incoming("call_request", 0, NOW, WINDOW, None, "Анна", "a@b.c"),
            Incoming::Silent
        );
    }

    #[test]
    fn request_without_ts_never_rings_even_before_the_clock_is_set() {
        // Телефон сразу после перезагрузки без сети: часы ещё не синхронизированы,
        // `now` крошечный, и «now - 0» не выходит за окно свежести. Тогда единственная
        // защита запроса без `ts` — прямая проверка `env_ts`.
        assert_eq!(
            decide_incoming("call_request", 0, 500, WINDOW, None, "Анна", "a@b.c"),
            Incoming::Silent,
            "конверт без ts не должен поднимать звонок ни при каких часах"
        );
    }

    #[test]
    fn window_boundary_is_exclusive_and_future_skew_passes() {
        // Ровно на пороге — уже не свежий (мост сравнивал `<`).
        assert_eq!(
            decide_incoming("call_request", NOW - WINDOW, NOW, WINDOW, None, "x", "y"),
            Incoming::Silent,
            "на границе окно уже закрыто"
        );
        // Часы звонящего уехали вперёд: пропускать — контракт моста, фиксируем.
        assert_eq!(
            decide_incoming("call_request", NOW + 60_000, NOW, WINDOW, None, "x", "y"),
            Incoming::Ring {
                caller: "x".to_string()
            }
        );
    }

    #[test]
    fn unknown_types_and_unknown_records_stay_silent() {
        assert_eq!(decide(Some("зависшая_запись")), Incoming::Silent);
        for typ in ["", "sos", "message", "call", "call_request_x"] {
            assert_eq!(
                decide_incoming(typ, NOW - 1000, NOW, WINDOW, None, "x", "y"),
                Incoming::Silent,
                "{typ}"
            );
        }
        assert!(is_call_signal("call_request"));
        assert!(!is_call_signal("request"));
    }

    #[test]
    fn record_state_names_roundtrip_and_are_case_sensitive() {
        for state in [
            RecordState::Ringing,
            RecordState::Accepted,
            RecordState::Rejected,
            RecordState::Missed,
            RecordState::Ended,
        ] {
            assert_eq!(RecordState::parse(state.as_str()), Some(state));
        }
        assert_eq!(RecordState::parse(""), None);
        assert_eq!(
            RecordState::parse("RINGING"),
            None,
            "регистр значим: kv пишет мост, а не человек"
        );
    }

    #[test]
    fn js_vocabulary_maps_to_record_states() {
        for reported in ["accept", "accepted", "active"] {
            assert_eq!(report_state(reported), "accepted", "{reported}");
        }
        for reported in ["reject", "rejected"] {
            assert_eq!(report_state(reported), "rejected", "{reported}");
        }
        for reported in ["end", "ended", "cancel", "hangup"] {
            assert_eq!(report_state(reported), "ended", "{reported}");
        }
        // Незнакомое значение НЕ выдумывается: возвращается как есть.
        assert_eq!(report_state("ringing"), "ringing");
        assert_eq!(report_state(""), "");
    }

    #[test]
    fn accepted_report_prevents_missed_over_a_live_call() {
        // Без отображения JS-«accept» запись осталась бы «ringing», и
        // ring-timeout поставил бы missed поверх идущего разговора.
        assert_eq!(report_state("accept"), RecordState::Accepted.as_str());
        assert_eq!(
            decide(Some(report_state("accept"))),
            Incoming::Settled(RecordState::Accepted)
        );
    }

    #[test]
    fn only_decision_states_dismiss_the_ring_notification() {
        assert!(dismisses_ring(report_state("accept")));
        assert!(dismisses_ring(report_state("reject")));
        // Гудок не снимаем по нему же: уведомление показывает этот же звонок.
        assert!(!dismisses_ring(RecordState::Ringing.as_str()));
        assert!(!dismisses_ring(RecordState::Missed.as_str()));
        assert!(!dismisses_ring(RecordState::Ended.as_str()));
        assert!(
            !dismisses_ring(""),
            "неизвестная строка не должна трогать чужое уведомление"
        );
    }
}
