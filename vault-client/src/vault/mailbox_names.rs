//! Классификация папок по записи `LIST` (ADR-005 §W4).
//!
//! ЗАЧЕМ В ЯДРЕ. Правило «эта папка — спам / «письма себе» / служебная» жило
//! во мосте (`src-tauri/src/email.rs::classify_folder`) И копией рядом в CLI
//! (`api/email.rs::inbox_folders`) — и уже разошлось: десктоп считал
//! «письмами себе» ещё и `letters to myself`, слушатель CLI — нет, то есть
//! входящие в такой папке CLI не видел вообще. Единое правило проверяется
//! мутациями (набор `rust-mailbox-names`): каждая мутация — реальная потеря
//! папки или ложный выбор `Sent` вместо `INBOX`.
//!
//! ПРОТОКОЛЬНЫЙ ФАКТ, а не настройка: имена локализуются (Gmail «Вся почта»,
//! mail.ru «Письма себе»), поэтому сначала атрибут (`\Junk`/`\Sent`/`\All`),
//! только потом имя. Приоритет один на запись: `All` → `Sent` → `Junk` →
//! `SelfLetters` → `Other` (исторически junk проверяется раньше «письм себе»).

/// Категория одной LIST-записи.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mailbox {
    /// `[Gmail]/All Mail` и аналоги: всё сразу, читать нельзя — дубликаты.
    All,
    /// Отправленное: Desktop свои копии НЕ читает (Gmail кладёт их в INBOX/Junk).
    Sent,
    /// Спам-папка провайдера (любое имя/локаль).
    Junk,
    /// «Письма себе» — автосортировка провайдера для From == To.
    SelfLetters,
    /// Всё остальное.
    Other,
}

/// Классифицировать LIST-запись.
///
/// `attrs` — строки кастомных атрибутов ровно как их отдаёт `imap`
/// (`\All`, `\Junk`, …); регистр не значим. `name` — имя папки с разделителем
/// `/` (Gmail: `[Gmail]/Spam`, mail.ru: `INBOX/ToMyself`).
pub fn classify(attrs: &[String], name: &str) -> Mailbox {
    let attr = |wanted: &str| {
        let wanted = wanted.to_lowercase();
        attrs.iter().any(|a| a.to_lowercase() == wanted)
    };
    // РЕГИСТР — UNICODE, НЕ ASCII. `to_ascii_lowercase()` кириллицу не трогает,
    // и с ним проверка `name_l == "спам"` / `"письма себе"` не срабатывала НИКОГДА:
    // и десктопный `classify_folder`, и копия в CLI (`inbox_folders`) сравнивали
    // русское имя с нерусским регистром и теряли папки русскоязычных ящиков
    // (Mail.ru/Yandex в локали «Спам», «Письма себе»). Найдено 23.10.2026, когда
    // правило переезжало в ядро и на него писались мутации.
    let name_l = name.to_lowercase();

    if attr("\\all") {
        return Mailbox::All;
    }
    if attr("\\sent")
        || name_l == "sent"
        || name_l == "sent items"
        || name_l == "sent messages"
        || name_l.ends_with("/sent")
    {
        return Mailbox::Sent;
    }
    if attr("\\junk")
        || attr("\\spam")
        || name_l == "spam"
        || name_l == "junk"
        || name_l == "спам"
        || name_l.ends_with("/spam")
        || name_l.ends_with("/junk")
    {
        return Mailbox::Junk;
    }
    if name_l.ends_with("/tomyself")
        || name_l == "tomyself"
        || name_l == "myself"
        || name_l.ends_with("/myself")
        || name_l == "письма себе"
        || name_l.ends_with("/письма себе")
        || name_l.ends_with("/letters to myself")
        || name_l == "letters to myself"
    {
        return Mailbox::SelfLetters;
    }
    Mailbox::Other
}

/// Итог разбора списка папок: первые найденные имена по каждой категории.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MailboxMap {
    /// `[Gmail]/All Mail` и аналоги («Вся почта») — есть у Gmail, нет у
    /// Zoho/Mail.ru/Yandex. Читать её нельзя: каждая письмо там дублируется.
    pub all: Option<String>,
    /// Отправленные (`\Sent`) — нужны провайдерам БЕЗ `\All` (Zoho и др.):
    /// только там лежат копии наших исходящих, и отправитель иначе не видит
    /// свои сообщения в чате.
    pub sent: Option<String>,
    /// Спам (`\Junk`/`\Spam` или папка с именем Spam/Junk/Спам).
    pub junk: Option<String>,
    /// «Письма себе» (mail.ru: `INBOX/ToMyself`). Провайдеры с автосортировкой
    /// кладут письма From == To в подпапку, и в INBOX их нет — без этой папки
    /// эскроу-письмо Key Recovery не находится, и восстановление аккаунта
    /// молча не работает.
    pub self_letters: Option<String>,
}

impl MailboxMap {
    /// Вывести одну LIST-запись в карту. «Победила первая»: категория
    /// заполняется только если ещё пуста — порядок обхода задаёт вызывающий,
    /// как это делали `find_special_folders` и `list_special_folders_strict`.
    pub fn absorb(&mut self, attrs: &[String], name: &str) {
        let folder = name.to_string();
        match classify(attrs, name) {
            Mailbox::All => {
                if self.all.is_none() {
                    self.all = Some(folder);
                }
            }
            Mailbox::Sent => {
                if self.sent.is_none() {
                    self.sent = Some(folder);
                }
            }
            Mailbox::Junk => {
                if self.junk.is_none() {
                    self.junk = Some(folder);
                }
            }
            Mailbox::SelfLetters => {
                if self.self_letters.is_none() {
                    self.self_letters = Some(folder);
                }
            }
            Mailbox::Other => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn junk_is_found_by_attribute_before_name() {
        // Локализованный Gmail не обязан называться «Spam» — спасает атрибут.
        assert_eq!(
            classify(&attrs(&["\\Junk"]), "&BCEEPwQwBDw-"),
            Mailbox::Junk
        );
        assert_eq!(classify(&attrs(&["\\Spam"]), "Корина"), Mailbox::Junk);
        assert_eq!(classify(&attrs(&[]), "reg@"), Mailbox::Other);
    }

    #[test]
    fn junk_and_self_letters_recognize_provider_names() {
        for name in ["Spam", "JUNK", "спам", "Спам", "СПАМ", "[Gmail]/Spam", "INBOX/Junk"] {
            assert_eq!(classify(&attrs(&[]), name), Mailbox::Junk, "{name}");
        }
        for name in [
            "ToMyself",
            "INBOX/ToMyself",
            "myself",
            "INBOX/Myself",
            "Письма себе",
            "ПИСЬМА СЕБЕ",
            "INBOX/Письма себе",
            "Letters to myself",
            "INBOX/Letters to myself",
        ] {
            assert_eq!(
                classify(&attrs(&[]), name),
                Mailbox::SelfLetters,
                "{name}"
            );
        }
    }

    #[test]
    fn service_folders_are_not_mistaken_for_inbox_sources() {
        assert_eq!(classify(&attrs(&["\\All"]), "[Gmail]/Все письма"), Mailbox::All);
        assert_eq!(classify(&attrs(&[]), "Sent"), Mailbox::Sent);
        assert_eq!(classify(&attrs(&[]), "INBOX/Sent"), Mailbox::Sent);
        assert_eq!(classify(&attrs(&[]), "Sent Items"), Mailbox::Sent);
        assert_eq!(classify(&attrs(&[]), "[Gmail]/Sent Mail"), Mailbox::Other);
        assert_eq!(classify(&attrs(&["\\Sent"]), "Отправленные"), Mailbox::Sent);
    }

    #[test]
    fn junk_outranks_self_letters_on_one_entry() {
        // Порядок «победила первая» сохранён: спам-атрибут решает раньше имени.
        assert_eq!(classify(&attrs(&["\\Junk"]), "ToMyself"), Mailbox::Junk);
    }

    #[test]
    fn map_keeps_the_first_folder_of_each_category() {
        let mut map = MailboxMap::default();
        map.absorb(&attrs(&["\\Junk"]), "Spam");
        map.absorb(&attrs(&[]), "junk");
        map.absorb(&attrs(&[]), "INBOX/ToMyself");
        map.absorb(&attrs(&["\\All"]), "AllMail");
        map.absorb(&attrs(&[]), "Drafts");
        assert_eq!(map.junk.as_deref(), Some("Spam"));
        assert_eq!(map.self_letters.as_deref(), Some("INBOX/ToMyself"));
        assert_eq!(map.all.as_deref(), Some("AllMail"));
        assert_eq!(map.sent, None);
    }
}
