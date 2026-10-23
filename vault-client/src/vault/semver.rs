//! Сравнение версий релиза (ADR-005 §W4, партия 3).
//!
//! ЗАЧЕМ В ЯДРЕ. «Новее ли удалённая версия текущей» — решение протокола
//! доставки: от него зависит, предложит ли клиент установку. Оно жило внутри
//! `check_app_update` во мосте (`lib.rs`), то есть в функции, которая заодно
//! крутит TLS, HTTP и разбор `latest.json` — и потому не покрывалась ничем,
//! кроме ручной проверки: тест требует сети, а `rust-mutation-gate` мост не
//! меряет. Здесь — чистая арифметика, сеть остаётся вызывающему.
//!
//! Ключевое, из-за чего это отдельный модуль, а не строка: сравнение обязано
//! быть ЧИСЛОВЫМ по компонентам. Лексикографическое (`"0.1.9" > "0.1.255"`)
//! выглядит правдоподобно, проходит глаза и оставляет клиента на старой
//! версии навсегда — обновление перестаёт предлагаться ровно на том пороге,
//! где минор перешагивает девятку.

/// Числовые компоненты версии: `v`-префикс и любые не-цифры — разделители
/// (`0.1.255`, `v0.1.255`, `0.1.255-android` → [0,1,255]).
fn components(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Строго: `a` новее `b`. Короткая версия дополняется нулями, поэтому
/// `1.2` < `1.2.1`, а `1.2` == `1.2.0` (и `false`, и `true` были бы ошибками:
/// первая предлагала бы установку самого себя, вторая — молчала о реальной).
pub fn version_gt(a: &str, b: &str) -> bool {
    let (av, bv) = (components(a), components(b));
    for i in 0..av.len().max(bv.len()) {
        let (x, y) = (
            av.get(i).copied().unwrap_or(0),
            bv.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numerically_not_lexicographically() {
        // Тот самый порог: лексикографически «9» больше «255».
        assert!(version_gt("0.1.255", "0.1.9"));
        assert!(!version_gt("0.1.9", "0.1.255"));
        assert!(version_gt("1.0.0", "0.99.99"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!version_gt("0.1.255", "0.1.255"));
        assert!(
            !version_gt("1.2", "1.2.0"),
            "дополнение нулями: 1.2 и 1.2.0 — одна версия, а не обновление"
        );
    }

    #[test]
    fn shorter_version_is_padded_with_zeros() {
        assert!(version_gt("1.2.1", "1.2"));
        assert!(!version_gt("1.2", "1.2.1"));
        assert!(version_gt("1.2.0.1", "1.2.0"));
    }

    #[test]
    fn prefix_and_suffix_are_separators_not_digits() {
        assert!(version_gt("v0.1.256", "0.1.255"));
        assert!(version_gt("0.1.256", "v0.1.255"));
        assert!(
            version_gt("0.1.256-android", "0.1.255"),
            "суффикс канала не должен сбрасывать сравнение в ноль"
        );
    }

    #[test]
    fn garbage_input_never_offers_an_update_it_cannot_read() {
        // Пусто/мусор → пустой список компонентов → «не новее». Решаем
        // однозначно: лучше молчать, чем предлагать установку вслепую.
        assert!(!version_gt("", "0.1.255"));
        assert!(!version_gt("latest", "0.1.255"));
        assert!(!version_gt("", ""));
    }

    #[test]
    fn first_differing_component_decides() {
        assert!(version_gt("2.0.0", "1.99.99"));
        assert!(!version_gt("1.0.99", "1.1.0"));
    }
}
