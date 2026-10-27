//! Классификация отказа входа по IMAP: что именно сказал сервер (ADR-005 §W4).
//!
//! ЗАЧЕМ В ЯДРЕ. До 27.10 это решение жило в JS (`src/api.js`): «в тексте есть
//! `login failed` → пароль отвергнут → стереть сохранённые креды». Одна строка
//! ответа провайдера решала, терять ли учётную запись, и решение было
//! непроверяемо мутационной программой (та меряет `vault-client`). На живом
//! X50 это стоило недель: Яндекс на `LOGIN` отвечает ОДНОЙ фразой
//! «[AUTHENTICATIONFAILED] LOGIN invalid credentials or IMAP is disabled» и на
//! отозванный пароль, и на выключенный доступ по IMAP, и на всплеск попыток
//! после рестартов. Первая такая минута стирала сохранённый app-пароль, а
//! восстановление его у Яндекса — дни.
//!
//! Поэтому классификация здесь, а **удаление кредов из этого пути исключено
//! совсем**: вердикт ядро отдаёт фронту только как текст для человека.
//!
//! Порядок проверок — часть правила, а не деталь реализации: сначала
//! двусмысленные и «подожди» ответы, только потом явный отказ пароля. Если
//! проверить отказ первым, двусмысленный ответ Яндекса станет «пароль
//! не подходит», и фронт снова получит повод забыть учётную запись.
//!
//! Набор мутаций: `rust-login-failure`.

/// Вердикт по ошибке входа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginFailure {
    /// Сервер явно и недвусмысленно отверг пару логин/пароль.
    PasswordRejected,
    /// Ответ «или пароль неверный, ИЛИ доступ по IMAP выключен» — провайдер не
    /// различает, поэтому это НЕ приговор паролю: ящик часто открывается без
    /// смены учётных данных.
    AccessDisabled,
    /// Слишком много попыток подряд: то же самое сервер выдаёт и при
    /// валидном пароле, если логин гонять волной (рестарты, `install -r`).
    Throttled,
    /// TCP/TLS/DNS/таймаут — про пароль неизвестно ничего.
    Transport,
    /// Формулировку не узнали. Не приговор: общий текст, креды не трогаем.
    Unknown,
}

impl LoginFailure {
    /// Стабильный код для фронта (`api.lastRestoreError`) и для ключей локали.
    /// Переименование сюда = рассинхрон с JS, поэтому коды под тестом.
    pub fn code(self) -> &'static str {
        match self {
            LoginFailure::PasswordRejected => "auth",
            LoginFailure::AccessDisabled => "disabled",
            LoginFailure::Throttled => "throttled",
            LoginFailure::Transport => "network",
            LoginFailure::Unknown => "unknown",
        }
    }
}

/// Классифицировать ошибку входа по её тексту.
///
/// Ожидает ровно ту строку, которую фронт получил от команды `email_connect`
/// (в Tauri на Android это сообщение без типа, поэтому разбор — по тексту).
pub fn classify(message: &str) -> LoginFailure {
    let t = message.to_ascii_lowercase();

    // 1. Двусмысленный ответ Яндекса/Zoho: «invalid credentials OR IMAP is
    // disabled». Проверляется ПЕРВЫМ — иначе он же содержит
    // AUTHENTICATIONFAILED и был бы прочитан как отказ пароля.
    if t.contains("imap is disabled") || t.contains("imap access is disabled") {
        return LoginFailure::AccessDisabled;
    }

    // 2. «Подожди» — троттлинг. Читать его как отказ пароля хуже нельзя:
    // пароль валиден, сервер просто устал от попыток.
    if t.contains("too many")
        || t.contains("rate limit")
        || t.contains("temporarily blocked")
        || t.contains("temporarily unavailable")
        || t.contains("try again later")
    {
        return LoginFailure::Throttled;
    }

    // 3. Транспорт: про пароль не известно ничего, и это единственная
    // категория, где ожидание заведомо безопасно.
    if t.contains("failed to connect")
        || t.contains("failed tls handshake")
        || t.contains("connection reset")
        || t.contains("timed out")
        || t.contains("timeout")
        || t.contains("name or service not known")
        || t.contains("network is unreachable")
    {
        return LoginFailure::Transport;
    }

    // 4. Явный отказ пары логин/пароль — и только здесь фронт имеет право
    // сказать человеку «введите пароль заново».
    if t.contains("authenticationfailed")
        || t.contains("authentication failed")
        || t.contains("invalid credentials")
        || t.contains("invalid username or password")
        || t.contains("username or password")
        || t.contains("cannot log in")
        || t.contains("login failed")
    {
        return LoginFailure::PasswordRejected;
    }

    LoginFailure::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ровно та строка, что снята с X50 27.10.2026 (проба CDP) и получена тем
    /// же ответом при прямом `IMAP4_SSL imap.yandex.ru:993 LOGIN`, то есть
    /// дело было в ящике, а не в сборке.
    const YANDEX_AMBIGUOUS: &str = "IMAP login failed: No Response: \
        [AUTHENTICATIONFAILED] LOGIN invalid credentials or IMAP is disabled";

    #[test]
    fn ambiguous_provider_answer_is_not_a_rejected_password() {
        for text in [
            YANDEX_AMBIGUOUS,
            "[AUTHENTICATIONFAILED] LOGIN invalid credentials or IMAP is disabled",
            "Invalid credentials or IMAP is disabled",
        ] {
            assert_eq!(
                classify(text),
                LoginFailure::AccessDisabled,
                "двусмысленный ответ прочитан как приговор паролю: {text}"
            );
        }
    }

    #[test]
    fn the_ambiguous_answer_wins_over_the_rejection_marker() {
        // Порядок проверок: в этой строке есть и AUTHENTICATIONFAILED, и
        // «imap is disabled». Если отказ пароля проверяется раньше, тест падает.
        assert_eq!(classify(YANDEX_AMBIGUOUS), LoginFailure::AccessDisabled);
        assert_ne!(classify(YANDEX_AMBIGUOUS), LoginFailure::PasswordRejected);
    }

    #[test]
    fn explicit_rejections_are_rejections() {
        for text in [
            "IMAP login failed: LOGIN failed",
            "[AUTHENTICATIONFAILED] Username or Password invalid",
            "Cannot log in with username/password",
            "AUTHENTICATIONFAILED Invalid credentials",
            "server said: authentication failed",
        ] {
            assert_eq!(
                classify(text),
                LoginFailure::PasswordRejected,
                "явный отказ пароля не распознан: {text}"
            );
        }
    }

    #[test]
    fn throttling_is_not_a_rejected_password() {
        for text in [
            "Too many login attempts, try again later",
            "[SERVER] Account temporarily blocked",
            "Server temporarily unavailable",
            "rate limit exceeded",
        ] {
            assert_eq!(
                classify(text),
                LoginFailure::Throttled,
                "троттлинг прочитан как отказ пароля: {text}"
            );
        }
    }

    #[test]
    fn transport_errors_say_nothing_about_the_password() {
        for text in [
            "Failed to connect to IMAP server (tried 2 address(es); last: Connection refused)",
            "Failed TLS handshake",
            "read timed out",
            "failed to lookup address information: Name or service not known",
            "Network is unreachable",
        ] {
            assert_eq!(
                classify(text),
                LoginFailure::Transport,
                "сетевая ошибка прочитана как отказ пароля: {text}"
            );
        }
    }

    #[test]
    fn unrecognized_wording_is_not_a_verdict() {
        for text in ["", "???", "some server text we have never seen"] {
            assert_eq!(
                classify(text),
                LoginFailure::Unknown,
                "незнакомый текст получил приговор вместо «не знаю»: {text}"
            );
        }
    }

    #[test]
    fn codes_match_the_frontend_vocabulary() {
        // `restore-failure.js` keyed этими строками; 'unknown' там — отсутствие
        // ключа, что даёт общий текст (и это намеренно).
        assert_eq!(LoginFailure::PasswordRejected.code(), "auth");
        assert_eq!(LoginFailure::AccessDisabled.code(), "disabled");
        assert_eq!(LoginFailure::Throttled.code(), "throttled");
        assert_eq!(LoginFailure::Transport.code(), "network");
        assert_eq!(LoginFailure::Unknown.code(), "unknown");
    }

    #[test]
    fn no_wording_of_rejection_is_classified_as_unknown() {
        // Потеря формулировки = молча «не знаю» = общий текст вместо
        // «введите пароль». Каждый отказ из живой таблицы обязан остаться
        // отказом.
        for text in [YANDEX_AMBIGUOUS] {
            assert_ne!(classify(text), LoginFailure::Unknown);
        }
        for text in [
            "IMAP login failed: LOGIN failed",
            "Too many login attempts, try again later",
            "read timed out",
        ] {
            assert_ne!(
                classify(text),
                LoginFailure::Unknown,
                "распознанная формулировка стала нераспознанной: {text}"
            );
        }
    }
}
