//! Диалекты почтовых провайдеров: как понимать их ответы (ADR-005 §W4).
//!
//! ЗАЧЕМ В ЯДРЕ. Оба правила ниже определяют, РВЁМ ЛИ мы сессию, то есть
//! это протокольное решение, а не транспорт. Во мосте (`src-tauri/src/email.rs`)
//! они были непроверяемы мутационной программой (та меряет только
//! `vault-client`), и CLI-слушателю они недоступны — тот со временем пишет
//! свою версию (так и вышло с классификацией папок, см. `mailbox_names`).
//!
//! Набор мутаций: `rust-imap-dialect`. Каждая мутация — поломка, которая уже
//! случилась на живом ящике (см. doc у каждого правила).

/// Вердикт по ошибке обращения к IMAP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImapFailure {
    /// Папки/ящика нет на сервере. TCP, TLS и авторизация ЖИВЫ — это не
    /// сетевой сбой: сессию не рвём, лестницу backoff не крутим.
    MailboxAbsent,
    /// Настоящий сбой соединения/сессии — единственный случай, когда уместны
    /// переподключение и пауза по лестнице.
    Network,
}

/// Реакция на одну строку ответа/ошибки: `Some` — распознана, `None` — нет.
///
/// Формулировки «папки нет» у провайдеров РАЗНЫЕ, и это не мелочь:
/// нераспознанная формулировка считается сетевым сбоем, а сетевой сбой в
/// почтовом цикле означает backoff — и вся забор писем встаёт из-за ОДНОЙ
/// отсутствующей папки. Найдено 22.10.2026 на живом Zoho: «No Response:
/// [NONEXISTENT] Unknown Mailbox: RELAY …» — детектор знал только «no such
/// folder/mailbox», цикл ушёл в бесконечный backoff (streak=150, «reconnect
/// deferred» каждые 3 мс), письма не приходили вообще, включая сигнал звонка.
fn failure_of_text(text: &str) -> Option<ImapFailure> {
    let t = text.to_ascii_lowercase();
    if t.contains("no such folder")
        || t.contains("no such mailbox")
        // Gmail и Zoho: «Unknown Mailbox: <имя>».
        || t.contains("unknown mailbox")
        || t.contains("unknown folder")
        // Некоторые серверы: «Mailbox doesn't exist».
        || t.contains("doesn't exist")
        || t.contains("does not exist")
    {
        return Some(ImapFailure::MailboxAbsent);
    }
    None
}

/// Классифицировать ошибку по всей цепочке причин.
///
/// * `whole` — полное представление ошибки (верхний контекст + вложенные);
/// * `sources` — тексты звеньев цепочки по одному.
///
/// Смысл именно в цепочке: ошибка SELECT оборачивается в `anyhow::Context`
/// («select {folder} failed: …»), и ВЕРХНИЙ слой признака не содержит.
/// Распознано любое звено → `MailboxAbsent`.
pub fn failure_of(whole: &str, sources: &[String]) -> ImapFailure {
    if let Some(v) = failure_of_text(whole) {
        return v;
    }
    for text in sources {
        if let Some(v) = failure_of_text(text) {
            return v;
        }
    }
    ImapFailure::Network
}

/// Логин для IMAP-авторизации по адресу ящика.
///
/// Яндекс режет логин с доменом-алиасом (`koanmak@ya.com` → AUTHENTICATIONFAILED),
/// хотя тот же ящик принимается как `koanmak` (или `koanmak@yandex.ru`). Для
/// алиасных доменов отдаём bare-логин, остальные провайдеры — как раньше
/// (адрес целиком). Домен сравнивается без регистра: провайдеры пишут и
/// `@YA.COM`, а пользователь может вставить адрес из письма.
pub fn imap_login_for(email: &str) -> String {
    const ALIAS_DOMAINS: [&str; 1] = ["@ya.com"];
    let lower = email.to_ascii_lowercase();
    if ALIAS_DOMAINS.iter().any(|d| lower.ends_with(d)) {
        return email.split('@').next().unwrap_or(email).to_string();
    }
    email.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Как выглядит цепочка на живом anyhow-объекте: верхний слой — только
    /// контекст вызова («select Junk failed …»), признак провайдера лежит в
    /// источнике, и именно поэтому одних «верхних» строк недостаточно.
    fn chain(context: &str, causes: &[&str]) -> (String, Vec<String>) {
        (
            context.to_string(),
            causes.iter().map(|s| s.to_string()).collect(),
        )
    }

    #[test]
    fn provider_wordings_for_missing_mailbox_are_all_known() {
        for text in [
            "No such folder",
            "SELECT NO such mailbox",
            "No Response: [NONEXISTENT] Unknown Mailbox: RELAY (Failure)",
            "[CLIENTBUG] Unknown folder",
            "Mailbox doesn't exist",
            "The requested folder does not exist",
        ] {
            assert_eq!(
                failure_of(text, &[]),
                ImapFailure::MailboxAbsent,
                "формулировка не распознана: {text}"
            );
        }
    }

    #[test]
    fn marker_on_a_deeper_link_still_counts() {
        // Верхний слой — только контекст, признак вложен.
        let (whole, sources) = chain("select Junk failed", &["[CLIENTBUG] No such folder"]);
        assert_eq!(failure_of(&whole, &sources), ImapFailure::MailboxAbsent);
    }

    #[test]
    fn real_network_failures_are_not_swallowed() {
        for text in [
            "connection reset by peer",
            "read timed out",
            "TLS handshake failed",
            "IMAP login failed: AUTHENTICATIONFAILED",
            "",
        ] {
            assert_eq!(
                failure_of(text, &[]),
                ImapFailure::Network,
                "сетевой сбой классифицирован как «папки нет»: {text}"
            );
        }
    }

    #[test]
    fn every_link_of_the_chain_is_examined_not_just_the_first() {
        // Обход обязан идти ДО ГЛУБИНЫ: признака нет ни в контексте, ни в
        // первом источнике — он в третьем звене.
        let (whole, sources) = chain(
            "select &BCEEPwQwBDw- failed",
            &["imap error", "No Response: [NONEXISTENT] Unknown Mailbox: Junk (Failure)"],
        );
        assert_eq!(
            failure_of(&whole, &sources),
            ImapFailure::MailboxAbsent,
            "цепочка не просмотрена до конца"
        );
    }

    #[test]
    fn alias_domains_login_bare_and_others_keep_full_address() {
        assert_eq!(imap_login_for("koanmak@ya.com"), "koanmak");
        assert_eq!(imap_login_for("koanmak@YA.COM"), "koanmak");
        assert_eq!(imap_login_for("me@yandex.ru"), "me@yandex.ru");
        assert_eq!(imap_login_for("me@gmail.com"), "me@gmail.com");
        assert_eq!(imap_login_for(""), "");
    }
}
