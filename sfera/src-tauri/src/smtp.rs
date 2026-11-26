//! SMTP-адаптер Sfera: явные креды, отдельные от мессенджера.
//!
//! Синхронный `social_ffi::DeliveryPort` вызывается из `social_sync_outbox`.
//! Блокирующий SMTP здесь выполняется в своём tokio-runtime; никаких секретов
//! в логах и никакого «успеха» до ответа SMTP-сервера.

use social_ffi::DeliveryPort;
use vault_client::api::email::{EmailClient, EmailConfig};

/// Настройки только для Sfera. `SFERA_SMTP_PASSWORD` читается из процесса,
/// не из key store/backup мессенджера.
pub struct SmtpConfig {
    pub email: String,
    pub password: String,
    pub server: String,
    pub port: u16,
    /// Только для явного локального теста; продакшен не может включить её
    /// случайно через порт или hostname.
    pub allow_insecure: bool,
}

impl SmtpConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(email) = std::env::var("SFERA_SMTP_EMAIL") else { return Ok(None) };
        let password = std::env::var("SFERA_SMTP_PASSWORD")
            .map_err(|_| "SFERA_SMTP_PASSWORD is required when SFERA_SMTP_EMAIL is set".to_string())?;
        let server = std::env::var("SFERA_SMTP_SERVER")
            .map_err(|_| "SFERA_SMTP_SERVER is required when SFERA_SMTP_EMAIL is set".to_string())?;
        let port = std::env::var("SFERA_SMTP_PORT")
            .unwrap_or_else(|_| "465".into())
            .parse::<u16>()
            .map_err(|_| "SFERA_SMTP_PORT must be a valid TCP port".to_string())?;
        let allow_insecure = std::env::var("SFERA_SMTP_ALLOW_INSECURE").as_deref() == Ok("1");
        if allow_insecure && !matches!(server.as_str(), "127.0.0.1" | "localhost" | "::1") {
            return Err("plaintext SMTP is allowed only for a local test server".into());
        }
        if email.is_empty() || password.is_empty() || server.is_empty() {
            return Err("SFERA_SMTP_EMAIL/PASSWORD/SERVER must not be empty".into());
        }
        Ok(Some(Self { email, password, server, port, allow_insecure }))
    }

    fn client(&self) -> EmailClient {
        EmailClient::new(EmailConfig {
            email: self.email.clone(),
            password: self.password.clone(),
            smtp_server: self.server.clone(),
            smtp_port: self.port,
            ..EmailConfig::default()
        })
    }

    async fn send(&self, to: &str, subject: &str, payload: &str) -> Result<(), String> {
        if !self.allow_insecure {
            return self.client().send_email(to, subject, payload).await
                .map_err(|e| format!("SMTP send failed: {e}"));
        }
        // Явный тестовый plaintext: production path выше не затрагивается.
        use lettre::message::{header::ContentType, Mailbox, Message};
        use lettre::transport::smtp::authentication::Credentials;
        use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
        let from: Mailbox = self.email.parse().map_err(|e| format!("sender: {e}"))?;
        let to: Mailbox = to.parse().map_err(|e| format!("recipient: {e}"))?;
        let message = Message::builder()
            .from(from).to(to).subject(subject).header(ContentType::TEXT_PLAIN)
            .body(payload.to_string()).map_err(|e| format!("message: {e}"))?;
        let transport = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.server)
            .port(self.port)
            .credentials(Credentials::new(self.email.clone(), self.password.clone()))
            .build();
        transport.send(message).await.map(|_| ())
            .map_err(|e| format!("SMTP send failed: {e}"))
    }
}

/// Доставить один готовый конверт. Тема пустая — как в stealth-письмах
/// мессенджера. Ни название приложения, ни тип события, ни outbox id не
/// выносим в открытые заголовки; тело — уже зашифрованный JSON.
pub fn send_envelope(config: &SmtpConfig, item: &social_app::OutboxItem) -> Result<bool, String> {
    let Some(to) = item.to.as_deref() else { return Ok(false) };
    let Some(payload) = item.envelope.as_deref() else { return Ok(false) };
    if to.is_empty() || payload.is_empty() {
        return Ok(false);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("SMTP runtime: {e}"))?;
    let subject = "";
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(config.send(to, &subject, payload))
    }));
    match result {
        Ok(inner) => inner.map(|_| true).map_err(|e| format!("SMTP send failed: {e}")),
        Err(_) => Err("SMTP client panicked".into()),
    }
}

/// Обёртка для `SferaState`: ошибка SMTP — `false` и штатный ретрай outbox.
pub struct SmtpDelivery {
    config: SmtpConfig,
}

impl SmtpDelivery {
    pub fn new(config: SmtpConfig) -> Self { Self { config } }
}

impl DeliveryPort for SmtpDelivery {
    fn send(&self, item: &social_app::OutboxItem) -> bool {
        send_envelope(&self.config, item).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use social_app::OutboxItem;
    use social_sync::OutboxState;

    fn item() -> OutboxItem {
        OutboxItem {
            id: "publication-1".into(),
            payload_len: 10,
            attempts: 0,
            next_attempt_at: 0,
            state: OutboxState::Pending,
            to: Some("peer@example.org".into()),
            envelope: Some("{\"v\":1}".into()),
            relay_mirror: false,
        }
    }

    #[test]
    fn incomplete_outbox_item_is_not_sent() {
        let config = SmtpConfig {
            email: "sfera@example.org".into(),
            password: "test-only".into(),
            server: "127.0.0.1".into(),
            port: 1,
            allow_insecure: false,
        };
        let mut old = item();
        old.to = None;
        assert!(!send_envelope(&config, &old).unwrap());
        old = item();
        old.envelope = None;
        assert!(!send_envelope(&config, &old).unwrap());
    }

    #[test]
    fn smtp_error_is_failure_not_fake_success() {
        let config = SmtpConfig {
            email: "sfera@example.org".into(),
            password: "test-only".into(),
            server: "127.0.0.1".into(),
            port: 1,
            allow_insecure: false,
        };
        assert!(!SmtpDelivery::new(config).send(&item()));
    }

    #[test]
    fn plain_smtp_server_receives_envelope() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut transcript = String::new();
            // Greeting обязателен: клиент ждёт его до EHLO, иначе обе стороны
            // ждут друг друга до бесконечности.
            socket.write_all(b"220 localhost ESMTP test\r\n").unwrap();
            let mut data = false;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 { break; }
                transcript.push_str(&line);
                if data && line == ".\r\n" {
                    socket.write_all(b"250 OK\r\n").unwrap();
                    break;
                }
                if line == "DATA\r\n" {
                    data = true;
                    socket.write_all(b"354 End data\r\n").unwrap();
                } else if line.starts_with("EHLO") {
                    socket.write_all(b"250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250-AUTH=PLAIN LOGIN\r\n250 8BITMIME\r\n").unwrap();
                } else if line.starts_with("AUTH PLAIN") {
                    socket.write_all(b"235 Accepted\r\n").unwrap();
                } else {
                    socket.write_all(b"250 OK\r\n").unwrap();
                }
            }
            transcript
        });
        let config = SmtpConfig {
            email: "sfera@example.org".into(),
            password: "test-only".into(),
            server: "127.0.0.1".into(),
            port,
            allow_insecure: true,
        };
        assert!(send_envelope(&config, &item()).unwrap());
        let transcript = server.join().unwrap();
        assert!(transcript.contains("RCPT TO:<peer@example.org>"), "{transcript}");
        assert!(transcript.contains("\r\nSubject: \r\n"), "{transcript}");
        assert!(!transcript.contains("sfera-profile:"), "{transcript}");
        assert!(!transcript.contains("publication-1"), "{transcript}");
        assert!(transcript.contains("{\"v\":1}"), "{transcript}");
        assert!(transcript.contains("AUTH"), "{transcript}");
    }
}
