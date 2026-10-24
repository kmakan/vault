//! Тумблеры возможности: эффективное значение флага по его имени.
//!
//! ЗАЧЕМ В ЯДРЕ. «Включена ли возможность, если пользователь ничего не
//! выбирал» — продуктовое решение, а не свойство вёрстки. До переноса сюда у
//! него было две копии во фронте: стартовая строка в компонентах
//! (`expCalls: false`) и перечитывание kv при старте. Когда дефолт менялся
//! (звонки из «экспериментальных» — в «по умолчанию»), компилятор про
//! расхождение молчал: JS-фронт показывал кнопку, а перечитывание kv через
//! секунду гасило её — догадаться можно было только тапом по телефону.
//! Поэтому правило целиком здесь, а фронт и мост называют его по имени.
//!
//! ФОРМУЛИРОВКА ПРАВИЛА. Записанное значение — воля пользователя, она
//! всегда важнее дефолта. Отсутствие записи — «не выбирал», и тогда решает
//! таблица `default_enabled`: всё, чего в таблице нет, по умолчанию выключено
//! (fail-closed — новая experimental-фича не может включиться сама).

/// Звонки: по умолчанию ВКЛЮЧЕНЫ, тумблер остаётся (пользователь вправе
/// выключить — тогда в kv лежит «0» и правило его слушает).
pub const EXP_CALLS: &str = "exp-calls";

/// Видео в звонке: экспериментальная возможность, по умолчанию ВЫКЛЮЧЕНА.
pub const EXP_VIDEO: &str = "exp-video";

/// Что включено само, пока пользователь не выбрал. Всё остальное — выключено.
pub fn default_enabled(name: &str) -> bool {
    name == EXP_CALLS
}

/// Как воля пользователя лежит в kv. Чтение сравнивает с этим же значением:
/// пара «пишем одно, читаем другое» — тот же класс ошибки, что две копии
/// дефолта.
pub fn flag_stored(enabled: bool) -> &'static str {
    if enabled {
        "1"
    } else {
        "0"
    }
}

/// Эффективное значение тумблера. `stored` — строка из kv (`None` = записи
/// нет, пользователь не выбирал). Любая строка, кроме «1», значит «выключено»:
/// мусор в kv не может включить возможность.
pub fn flag_enabled(name: &str, stored: Option<&str>) -> bool {
    match stored {
        Some(value) => value == flag_stored(true),
        None => default_enabled(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_on_by_default_video_off_by_default() {
        assert!(flag_enabled(EXP_CALLS, None));
        assert!(!flag_enabled(EXP_VIDEO, None));
    }

    #[test]
    fn unknown_flag_is_off_by_default() {
        assert!(!flag_enabled("teleport", None));
        assert!(!default_enabled("teleport"));
    }

    #[test]
    fn stored_choice_wins_over_default_both_ways() {
        assert!(!flag_enabled(EXP_CALLS, Some("0")));
        assert!(flag_enabled(EXP_VIDEO, Some("1")));
    }

    #[test]
    fn junk_in_kv_does_not_turn_a_flag_on() {
        for value in ["", "true", "on", "01", "1 "] {
            assert!(!flag_enabled(EXP_VIDEO, Some(value)), "{value:?}");
        }
    }

    #[test]
    fn written_value_reads_back_as_the_same_choice() {
        for name in [EXP_CALLS, EXP_VIDEO, "teleport"] {
            for enabled in [true, false] {
                assert_eq!(
                    flag_enabled(name, Some(flag_stored(enabled))),
                    enabled,
                    "{name}={enabled}"
                );
            }
        }
    }

    #[test]
    fn stored_form_is_the_documented_wire_literals() {
        // Формат хранения — контракт между версиями (в kv уже лежат строки,
        // написанные старым кодом), поэтому он проверяется ЛИТЕРАЛОМ: круговая
        // проверка выше не видит, когда обе стороны меняются одновременно.
        assert_eq!(flag_stored(true), "1");
        assert_eq!(flag_stored(false), "0");
    }

    #[test]
    fn flag_names_are_the_kv_keys() {
        // Имя флага = ключ в kv, его пишет и читает фронт своими строками
        // (`features/settings-ui.js`). Опечатка здесь молча рассинхронизирует
        // запись с чтением, поэтому имя закреплено буквально.
        assert_eq!(EXP_CALLS, "exp-calls");
        assert_eq!(EXP_VIDEO, "exp-video");
    }
}
