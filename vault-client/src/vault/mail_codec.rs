//! Кодировки письма: quoted-printable и перенос длинных строк (ADR-005 §W4).
//!
//! ЗАЧЕМ В ЯДРЕ. Оба правила — формат транспорта, и оба жили ДВУМЯ копиями:
//! во мосте (`src-tauri/src/email.rs`) и в CLI (`api/email.rs::decode_quoted_printable`).
//! Копии РАЗОШЛИСЬ, и это не теория: desktop 09.10.2026 починил съеденный
//! пэйдинг base64 (кадр 49Б → `…==` + CRLF перед «=\r\n», QP-перенос съедал
//! один `=` → 67 символов → `isEncrypted=false` → hav/meta-письмо молча
//! отбрасывалось), а слушатель CLI остался со СТАРЫМ декодером и теряет
//! пэйдинг до сих пор. Одно правило = один исправленный клиент.
//!
//! Набор мутаций: `rust-mail-codec`.

/// Развернуть quoted-printable: `=XX` и мягкие переносы (`=\r\n`, `=\n`).
///
/// Нужен, потому что SMTP-релеи (Gmail в том числе) перекодируют блок
/// Vault-шифротекста (base64) в quoted-printable при доставке.
pub fn quoted_printable(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'=' => {
                // Мягкий перенос «=\r\n» или «=\n» → пропускаем, НО только если
                // после перевода есть содержимое. «=\r\n» в КОНЦЕ тела — это
                // пэйдинг base64 (`==`) + финальный CRLF служебного 7bit-тела,
                // а не QP-перенос: ветка, которая срезала один '=', ломала
                // длину строки (68→67) и письмо переставало выглядеть
                // зашифрованным (живой баг X50, 09.10.2026).
                if i + 1 < bytes.len() && (bytes[i + 1] == b'\r' || bytes[i + 1] == b'\n') {
                    let eol = if i + 2 < bytes.len() && bytes[i + 1] == b'\r' && bytes[i + 2] == b'\n'
                    {
                        2
                    } else {
                        1
                    };
                    let after = i + 1 + eol;
                    if after < bytes.len() {
                        i = after; // настоящий QP-перенос: продолжение есть
                        continue;
                    }
                    // Конец тела: '=' — литерал (пэйдинг), CRLF ниже отдаётся
                    // как есть; потребители режут пробелы.
                }
                // Hex escape: =XX
                if i + 2 < bytes.len() {
                    let hi = (bytes[i + 1] as char).to_digit(16);
                    let lo = (bytes[i + 2] as char).to_digit(16);
                    if let (Some(h), Some(l)) = (hi, lo) {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                        continue;
                    }
                }
                // Одиночный «=» без валидного escape — оставляем литералом.
                out.push(b'=');
                i += 1;
            }
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                out.push(b'\n');
                i += 2;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Свернуть длинные строки до ≤76 колонок (RFC 5322 soft wrap) перед отправкой.
///
/// Релеи и спам-фильтры подозрительно относятся к непрерывным строкам
/// длиннее ~100 символов, а некоторые отказываются принимать их вовсе.
/// Получатель собирает шифротекст обратно стрипом пробелов, поэтому
/// сворачивание обратимо для обоих кодеков.
///
/// РУБКА ПО БАЙТАМ: `chunks(76)` режет байты, а не символы, и многобайтовый
/// символ на границе превращается в U+FFFD. Так ведёт себя и desktop, и CLI с
/// самого начала; символы вне ASCII в тело Vault-конверта не попадают
/// (base64), поэтому правило сохранено дословно — менять его здесь нельзя.
pub fn fold_lines(body: &str) -> String {
    const MAX: usize = 76;
    body.lines()
        .flat_map(|line| {
            if line.len() <= MAX {
                vec![line.to_string()]
            } else {
                line.as_bytes()
                    .chunks(MAX)
                    .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
                    .collect::<Vec<_>>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soft_breaks_and_hex_escapes() {
        assert_eq!(quoted_printable("abc=\r\ndef"), "abcdef");
        assert_eq!(quoted_printable("abc=\ndef"), "abcdef");
        assert_eq!(quoted_printable("a=3Db"), "a=b");
        assert_eq!(quoted_printable("keep=tail"), "keep=tail");
        assert_eq!(quoted_printable("x=0Dy"), "x\u{d}y");
    }

    #[test]
    fn final_crlf_does_not_eat_base64_padding() {
        // Регрессия X50 09.10.2026: RFC822.TEXT кончается CRLF, последние
        // символы тела — пэйдинг «==». Старый код принимал это за QP-перенос
        // и терял '=' → 67 символов → письмо не выглядело зашифрованным.
        let strip = |s: &str| -> String { s.chars().filter(|c| !c.is_whitespace()).collect() };
        let raw = "gbgdGPmguO+L19LJeVo537gZSu3xWjA2FvPb1Jk3HhuGFHnEgR/f/FELEZK/AVIG0A==\r\n";
        let out = strip(&quoted_printable(raw));
        assert_eq!(out, strip(raw));
        assert_eq!(out.len() % 4, 0, "пэйдинг потерян: {} символов", out.len());

        let single = "YWJjZA=\r\n"; // одинарный пэйдинг + CRLF
        assert_eq!(strip(&quoted_printable(single)), strip(single));
    }

    #[test]
    fn crlf_is_normalized_to_lf() {
        assert_eq!(quoted_printable("a\r\nb"), "a\nb");
        assert_eq!(quoted_printable("a\r"), "a\r");
    }

    #[test]
    fn long_lines_are_folded_at_76_and_short_are_untouched() {
        let long = "A".repeat(160);
        let folded = fold_lines(&long);
        let parts: Vec<&str> = folded.lines().collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 76);
        assert_eq!(parts[1].len(), 76);
        assert_eq!(parts[2].len(), 8);
        // Обратимо: стрип пробелов восстанавливает исходный блок.
        assert_eq!(folded.chars().filter(|c| !c.is_whitespace()).count(), 160);
        assert_eq!(fold_lines("короткая\nстрока"), "короткая\nстрока");
    }
}
