//! Разбор заголовков письма (ADR-005 §W4).
//!
//! ЗАЧЕМ В ЯДРЕ. Это формат: как из сырых заголовков достать значение поля.
//! Функция жила ДВУМЯ копиями — во мосте (`src-tauri/src/email.rs::extract_header`)
//! и в CLI (`api/email.rs::extract_header`), дословно одинаковыми. Пока копия
//! одна, её проверяют мутации (набор `rust-mail-headers`); пока их две, любое
//! изменение (например, сворачивание длинных `Subject:`) надо вносить дважды,
//! и desktop с CLI расходятся молча.
//!
//! ОГРАНИЧЕНИЕ, зафиксированное явно: значение берётся из ПЕРВОЙ строки поля.
//! Многострочные (folded, RFC 5322 §2.2.3, `Subject:` с переносом) заголовки
//! таким разборчиком обрезаются до первой строки — и desktop, и CLI вели себя
//! так всегда; менять поведение в этом переносе нельзя (приёмка 0.1.259
//! снималась именно на нём).

/// Значение заголовка `name:` из блока заголовков.
///
/// `name` — с двоеточием или без (`"From"` и `"From:"` дают одно и то же),
/// регистр не значим. Возвращает `None`, если поля нет или в нём нет `:`.
pub fn value(header: &str, name: &str) -> Option<String> {
    let key = name.trim().trim_end_matches(':').to_ascii_lowercase();
    let prefix = format!("{key}:");
    header
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with(&prefix))
        .and_then(|line| line.splitn(2, ':').nth(1))
        .map(|v| v.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADERS: &str = "From: alice@example.com\r\n\
         To: bob@example.com\r\n\
         Subject: Привет и ещё одна проверка\r\n\
         Date: Thu, 23 Oct 2026 09:00:00 +0300\r\n\
         Message-ID: <abc@example.com>\r\n";

    #[test]
    fn fields_are_read_by_name_case_insensitively() {
        assert_eq!(value(HEADERS, "From:").as_deref(), Some("alice@example.com"));
        assert_eq!(value(HEADERS, "from").as_deref(), Some("alice@example.com"));
        assert_eq!(
            value(HEADERS, "MESSAGE-ID:").as_deref(),
            Some("<abc@example.com>")
        );
        assert_eq!(value(HEADERS, "Subject:").as_deref(), Some("Привет и ещё одна проверка"));
    }

    #[test]
    fn missing_field_is_none_not_empty_string() {
        // Пустая строка здесь = «письмо без адресанта», а её пишут в БД как
        // валидного собеседника; различать «нет поля» и «пустое поле» должен
        // вызывающий, а не разборчик.
        assert_eq!(value(HEADERS, "X-Loop:").as_deref(), None);
        assert_eq!(value("", "From:").as_deref(), None);
        assert_eq!(value("From alice\r\n", "From:").as_deref(), None);
    }

    #[test]
    fn prefix_match_does_not_grab_a_longer_name() {
        // «From» не должен ловить «X-From» или «Received: from …» — сравнение
        // идёт с начала строки, а не по подстроке.
        let block = "X-From: spoofed@example.com\r\nFrom: real@example.com\r\n";
        assert_eq!(value(block, "From:").as_deref(), Some("real@example.com"));
    }

    #[test]
    fn value_keeps_colons_inside_the_field() {
        // Дата содержит «:» — значение берётся после ПЕРВОГО двоеточия строки.
        assert_eq!(
            value(HEADERS, "Date:").as_deref(),
            Some("Thu, 23 Oct 2026 09:00:00 +0300")
        );
    }
}
