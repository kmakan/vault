//! План доставки: каким транспортом уходит сообщение или сигналы звонка.
//!
//! ГАРАНТИЯ (главное свойство, а не деталь). Релей — УСКОРИТЕЛЬ, почта —
//! ГАРАНТ. Ни один план не оставляет доставку без почтового пути: если
//! релей выбран, но недоступен (выключен, заблокирован, лимит исчерпан),
//! план автоматически становится «почта». План, где `relay: true`, всегда
//! имеет `mail: true` или `mail_fallback: true`.
//!
//! ДО ПЕРЕНОСА СЮДА. Выбор был размазан по двум вызывающим местам во фронте
//! (`features/send.js` гонял оба транспорта параллельно, `features/calls.js`
//! слал релей fire-and-forget и всегда почту), поэтому пользовательский
//! выбор было некуда добавить: любая ветка в JS — вторая копия правила, а
//! расхождение «сообщение уходит иначе, чем звонок» никто бы не заметил,
//! пока оно не стало бы недошедшим звонком.

use serde::Serialize;

/// Авто: оба транспорта параллельно, первый успех решает.
pub const PREFERENCE_AUTO: &str = "auto";
/// Только почта (релей не трогаем совсем).
pub const PREFERENCE_MAIL: &str = "mail";
/// Только релей, но с почтовым догоняющим каналом, если релей не доставил.
pub const PREFERENCE_RELAY: &str = "relay";

/// Что разрешено сделать с одним отправляемым.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Отправлять письмом СРАЗУ (параллельно с релеем или вместо него).
    pub mail: bool,
    /// Публиковать в релей.
    pub relay: bool,
    /// Если релей отказал — послать письмом (почта как догоняющий канал).
    pub mail_fallback: bool,
}

/// Внутренняя форма выбора: `match` по `&str` не исчерпывающий, а молча
/// недосмотренная ветка здесь = недоставленное сообщение.
#[derive(Clone, Copy)]
enum Pref {
    Auto,
    Mail,
    Relay,
}

impl Pref {
    fn of(stored: &str) -> Self {
        match stored {
            PREFERENCE_MAIL => Pref::Mail,
            PREFERENCE_RELAY => Pref::Relay,
            _ => Pref::Auto,
        }
    }
}

/// Имя настройки в том виде, как оно пишется в kv. Неизвестное значение
/// («что-то постороннее в kv») разбирается в `auto`: доставка не должна
/// зависеть от испорченной настройки.
pub fn parse_preference(stored: Option<&str>) -> &'static str {
    parse(stored.unwrap_or(PREFERENCE_AUTO))
}

/// То же правило для уже прочитанного значения.
pub fn parse(stored: &str) -> &'static str {
    match Pref::of(stored) {
        Pref::Mail => PREFERENCE_MAIL,
        Pref::Relay => PREFERENCE_RELAY,
        Pref::Auto => PREFERENCE_AUTO,
    }
}

/// Порядок переключения выбора: авто → релей → почта → авто. Держится у ядра
/// потому, что имена транспорта — тоже его: список строк во фронте был бы
/// второй копией тех же литералов и разошёлся бы при первой переименовании.
pub const CYCLE: [&str; 3] = [PREFERENCE_AUTO, PREFERENCE_RELAY, PREFERENCE_MAIL];

/// Следующий выбор после текущего. Неизвестное значение приводится к `auto`
/// и только потом сдвигается: сломанная настройка не может «застрять» в чипе.
pub fn next(preference: &str) -> &'static str {
    let here = parse(preference);
    let i = CYCLE.iter().position(|name| *name == here).unwrap_or(0);
    CYCLE[(i + 1) % CYCLE.len()]
}

fn mail_only() -> Plan {
    Plan {
        mail: true,
        relay: false,
        mail_fallback: false,
    }
}

/// План доставки. `relay_available` — живой ли релей СЕЙЧАС (выключен
/// пользователем, не отвечает, лимит исчерпан — решает вызывающий код, у
/// него факт состояния; здесь правило, что с этим фактом делать).
pub fn plan(preference: &str, relay_available: bool) -> Plan {
    match (Pref::of(preference), relay_available) {
        // Только почта: релей не трогаем совсем (в том числе не расходуем
        // суточный лимит издателя).
        (Pref::Mail, _) => mail_only(),
        // Релей выбран и жив: письмо не нужно, пока он доставил, но обязательно
        // нужно, если не доставил.
        (Pref::Relay, true) => Plan {
            mail: false,
            relay: true,
            mail_fallback: true,
        },
        // Релей выбран, но его нет: остаётся гарантия — почта.
        (Pref::Relay, false) => mail_only(),
        // Авто: параллельно, второй транспорт и так стартует — фолбэк не нужен.
        (Pref::Auto, true) => Plan {
            mail: true,
            relay: true,
            mail_fallback: false,
        },
        (Pref::Auto, false) => mail_only(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_preference_never_touches_relay() {
        for available in [true, false] {
            let p = plan(PREFERENCE_MAIL, available);
            assert_eq!(
                p,
                Plan {
                    mail: true,
                    relay: false,
                    mail_fallback: false
                },
                "available={available}"
            );
        }
    }

    #[test]
    fn relay_preference_is_relay_first_with_mail_fallback() {
        let p = plan(PREFERENCE_RELAY, true);
        assert_eq!(
            p,
            Plan {
                mail: false,
                relay: true,
                mail_fallback: true
            }
        );
    }

    #[test]
    fn auto_runs_both_transports_in_parallel() {
        assert_eq!(
            plan(PREFERENCE_AUTO, true),
            Plan {
                mail: true,
                relay: true,
                mail_fallback: false
            }
        );
    }

    #[test]
    fn without_relay_every_preference_degrades_to_mail_only() {
        // Это и есть требование «если релей не работает — сообщение и вызов
        // всё равно доходят через почту»: ни одна ветка не остаётся без почты.
        for pref in [
            PREFERENCE_AUTO,
            PREFERENCE_MAIL,
            PREFERENCE_RELAY,
            "chip",
            "",
        ] {
            let p = plan(pref, false);
            assert!(p.mail, "{pref}");
            assert!(!p.relay, "{pref}");
        }
    }

    #[test]
    fn every_plan_keeps_a_mail_path() {
        for pref in [PREFERENCE_AUTO, PREFERENCE_MAIL, PREFERENCE_RELAY, "чушь"] {
            for available in [true, false] {
                let p = plan(pref, available);
                assert!(p.mail || p.mail_fallback || !p.relay, "{pref}/{available}");
                assert!(
                    !(p.relay && !p.mail && !p.mail_fallback),
                    "{pref}/{available}"
                );
            }
        }
    }

    #[test]
    fn broken_or_unknown_preference_is_auto_not_nothing() {
        assert_eq!(parse_preference(None), PREFERENCE_AUTO);
        assert_eq!(parse_preference(Some("")), PREFERENCE_AUTO);
        assert_eq!(parse_preference(Some("MAIL")), PREFERENCE_AUTO);
        assert_eq!(parse_preference(Some("relay ")), PREFERENCE_AUTO);
        assert_eq!(parse_preference(Some(PREFERENCE_RELAY)), PREFERENCE_RELAY);
        assert_eq!(parse_preference(Some(PREFERENCE_MAIL)), PREFERENCE_MAIL);
    }

    #[test]
    fn cycle_visits_all_three_and_closes_on_itself() {
        let mut seen = Vec::new();
        let mut cur = PREFERENCE_AUTO;
        for _ in 0..CYCLE.len() {
            cur = next(cur);
            seen.push(cur);
        }
        assert_eq!(
            seen,
            vec![PREFERENCE_RELAY, PREFERENCE_MAIL, PREFERENCE_AUTO]
        );
        assert_eq!(next(PREFERENCE_AUTO), PREFERENCE_RELAY);
    }

    #[test]
    fn cycle_order_is_the_documented_one() {
        // Порядок — часть поведения чипа: переставленный, он меняет, что
        // пользователь получит одним нажатием, а тест выше этого не увидит.
        assert_eq!(CYCLE.to_vec(), vec!["auto", "relay", "mail"]);
    }

    #[test]
    fn broken_preference_cycles_from_auto() {
        assert_eq!(next(""), PREFERENCE_RELAY);
        assert_eq!(next("Relay"), PREFERENCE_RELAY);
    }

    #[test]
    fn preference_names_are_the_wire_values() {
        // Строки пишутся в kv фронтендом и читаются мостом: опечатка здесь —
        // это «настройка есть, но она никогда не прочитана».
        assert_eq!(PREFERENCE_AUTO, "auto");
        assert_eq!(PREFERENCE_MAIL, "mail");
        assert_eq!(PREFERENCE_RELAY, "relay");
    }
}
