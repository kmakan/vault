use anyhow::{Context, Result};
use imap::Session;
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::message::Message;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use native_tls::{TlsConnector, TlsStream};
use std::net::TcpStream;

use crate::vault::{mail_codec, mail_headers, mailbox_names};

/// Кастомные атрибуты LIST-записи — строками. Чистый транспорт: ядро
/// (`vault::mailbox_names`) не знает типа `imap::NameAttribute`, только текст.
fn custom_attrs(attrs: &[imap::types::NameAttribute]) -> Vec<String> {
    attrs
        .iter()
        .filter_map(|a| match a {
            imap::types::NameAttribute::Custom(s) => Some(s.to_ascii_lowercase()),
            _ => None,
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct EmailConfig {
    pub imap_server: String,
    pub imap_port: u16,
    pub smtp_server: String,
    pub smtp_port: u16,
    pub email: String,
    pub password: String,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            imap_server: "imap.gmail.com".to_string(),
            imap_port: 993,
            smtp_server: "smtp.gmail.com".to_string(),
            smtp_port: 587,
            email: String::new(),
            password: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EmailMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub date: String,
    pub is_read: bool,
}

pub struct EmailClient {
    config: EmailConfig,
    imap_session: Option<Session<TlsStream<TcpStream>>>,
}

impl EmailClient {
    pub fn new(config: EmailConfig) -> Self {
        Self {
            config,
            imap_session: None,
        }
    }

    pub async fn connect_imap(&mut self) -> Result<()> {
        let tls = TlsConnector::builder()
            .build()
            .context("Failed to create TLS connector")?;

        let client = imap::connect(
            (self.config.imap_server.as_str(), self.config.imap_port),
            &self.config.imap_server,
            &tls,
        )
        .context("Failed to connect to IMAP server")?;

        let session = client
            .login(&self.config.email, &self.config.password)
            .map_err(|e| anyhow::anyhow!("IMAP login failed: {}", e.0))?;

        self.imap_session = Some(session);
        Ok(())
    }

    pub async fn fetch_messages(&mut self) -> Result<Vec<EmailMessage>> {
        self.fetch_messages_from("INBOX").await
    }

    /// Locate the junk/spam folder by the IMAP \Junk flag (localization-proof:
    /// Russian Gmail names it "[Gmail]/&BCEEPwQwBDw-" instead of "[Gmail]/Spam").
    /// Falls back to "[Gmail]/Spam" if no flagged folder is found.
    pub async fn junk_folder(&mut self) -> String {
        let session = match self.imap_session.as_mut() {
            Some(s) => s,
            None => return "[Gmail]/Spam".to_string(),
        };
        if let Ok(names) = session.list(None, Some("*")) {
            let mut found = mailbox_names::MailboxMap::default();
            for name in names.iter() {
                if name.name().is_empty() {
                    continue;
                }
                found.absorb(&custom_attrs(name.attributes()), name.name());
            }
            if let Some(junk) = found.junk {
                return junk;
            }
        }
        "[Gmail]/Spam".to_string()
    }

    /// Найти входящие папки для --listen: INBOX + Junk + «Письма себе».
    /// mail.ru автосортирует From==To в INBOX/ToMyself, и хардкод "ToMyself"
    /// падает с NONEXISTENT — ищем реальные имена по тому же правилу, что и
    /// Desktop (`vault::mailbox_names`: атрибут, затем имя/локаль).
    ///
    /// РАНЬШЕ ЗДЕСЬ БЫЛА СВОЯ КОПИЯ правила — и она уже разошлась: в ней не
    /// было «letters to myself», то есть слушатель CLI не читал такую папку.
    pub async fn inbox_folders(&mut self) -> Vec<String> {
        let fallback = || {
            vec![
                "INBOX".to_string(),
                "Junk".to_string(),
                "ToMyself".to_string(),
            ]
        };
        let session = match self.imap_session.as_mut() {
            Some(s) => s,
            None => return fallback(),
        };
        let list = match session.list(None, Some("*")) {
            Ok(l) => l,
            Err(_) => return fallback(),
        };
        let mut found = mailbox_names::MailboxMap::default();
        for m in list.iter() {
            if m.name().is_empty() {
                continue;
            }
            found.absorb(&custom_attrs(m.attributes()), m.name());
        }
        let mut out = vec!["INBOX".to_string()];
        if let Some(j) = found.junk {
            out.push(j);
        }
        if let Some(m) = found.self_letters {
            out.push(m);
        }
        out
    }

    /// Fetch recent messages from an arbitrary IMAP folder (e.g. "INBOX",
    /// "[Gmail]/Spam" or the localized junk folder). Used by tests to find
    /// messages that Gmail's spam filter routed away from INBOX.
    pub async fn fetch_messages_from(&mut self, folder: &str) -> Result<Vec<EmailMessage>> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select(folder)?;

        let message_ids = session.uid_search("ALL")?;
        let mut messages = Vec::new();

        // Take the most RECENT 50 messages (uid_search returns an unordered set —
        // sort descending by UID to iterate newest first, then cap).
        let mut uids: Vec<u32> = message_ids.iter().copied().collect();
        uids.sort_by(|a, b| b.cmp(a));

        for uid in uids.iter().take(50) {
            if let Ok(data) = session.uid_fetch(uid.to_string(), "(UID FLAGS RFC822.HEADER)") {
                for fetch in data.iter() {
                    let uid = fetch.uid.unwrap_or_default().to_string();
                    let flags = fetch.flags();
                    let is_read = flags.iter().any(|f| matches!(f, imap::types::Flag::Seen));

                    if let Some(header) = fetch.header() {
                        let header_str = String::from_utf8_lossy(header);
                        let from = mail_headers::value(&header_str, "From:")
                            .unwrap_or_else(|| "Unknown".to_string());
                        let to = mail_headers::value(&header_str, "To:")
                            .unwrap_or_else(|| "Unknown".to_string());
                        let subject = mail_headers::value(&header_str, "Subject:")
                            .unwrap_or_else(|| "(no subject)".to_string());
                        let date = mail_headers::value(&header_str, "Date:")
                            .unwrap_or_else(|| "Unknown".to_string());

                        messages.push(EmailMessage {
                            id: uid,
                            from,
                            to,
                            subject,
                            body: String::new(),
                            date,
                            is_read,
                        });
                    }
                }
            }
        }

        messages.reverse();
        Ok(messages)
    }

    /// Заголовки + ПРЕФИКС тела (первые `prefix_bytes` байт BODY[TEXT]) для
    /// классификации писем без выкачки тяжёлых тел: stealth-письма несут
    /// пустую тему и маркеров в теле нет — «наше» письмо узнаётся по тому,
    /// что тело начинается с валидного base64 (AAD-конверт encrypt_vault).
    /// PEEK не ставит \\Seen. Длина — единственный признак в префиксе;
    /// полная расшифровка всё равно делается по требованию (/read).
    pub async fn fetch_messages_with_prefix(
        &mut self,
        folder: &str,
        prefix_bytes: usize,
    ) -> Result<Vec<EmailMessage>> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select(folder)?;

        let message_ids = session.uid_search("ALL")?;
        let mut uids: Vec<u32> = message_ids.iter().copied().collect();
        uids.sort_by(|a, b| b.cmp(a));

        let mut messages = Vec::new();
        for uid in uids.iter().take(50) {
            let query = format!("(UID FLAGS RFC822.HEADER BODY.PEEK[TEXT]<0.{prefix_bytes}>)");
            if let Ok(data) = session.uid_fetch(uid.to_string(), query) {
                for fetch in data.iter() {
                    let uid_str = fetch.uid.unwrap_or_default().to_string();
                    let flags = fetch.flags();
                    let is_read = flags.iter().any(|f| matches!(f, imap::types::Flag::Seen));

                    if let Some(header) = fetch.header() {
                        let header_str = String::from_utf8_lossy(header);
                        // imap-proto парсит BODY.PEEK[TEXT]<0.N> как
                        // SectionPath::Full(Text) — body() достаёт только
                        // section:None (BODY[]/RFC822), поэтому текст берём
                        // через text(). Если text() = None — is_encrypted()
                        // видит пустоту и молча выбрасывает письмо, поэтому
                        // отсутствие тела логируем.
                        let body_raw = fetch.text().unwrap_or_default();
                        if body_raw.is_empty() {
                            tracing::debug!("listen-fetch: uid={} has no TEXT section", uid_str);
                        }
                        let from = mail_headers::value(&header_str, "From:")
                            .unwrap_or_else(|| "Unknown".to_string());
                        let to = mail_headers::value(&header_str, "To:")
                            .unwrap_or_else(|| "Unknown".to_string());
                        let subject = mail_headers::value(&header_str, "Subject:")
                            .unwrap_or_else(|| "(no subject)".to_string());
                        let date = mail_headers::value(&header_str, "Date:")
                            .unwrap_or_else(|| "Unknown".to_string());

                        // BODY[TEXT] (в т.ч. BODY.PEEK[TEXT]<0.N>) imap-proto
                        // парсит как SectionPath::Full(Text) — accessor body()
                        // отдаёт только section:None (BODY[]/RFC822), поэтому
                        // текст берём через text().
                        let body = mail_codec::quoted_printable(&String::from_utf8_lossy(body_raw));

                        messages.push(EmailMessage {
                            id: uid_str,
                            from,
                            to,
                            subject,
                            body,
                            date,
                            is_read,
                        });
                    }
                }
            }
        }

        messages.reverse();
        Ok(messages)
    }

    /// Header-only fetch: sender email by UID. Used by /read to pick the
    /// right peer key BEFORE decryption — the body alone carries no sender.
    pub async fn fetch_sender(&mut self, uid: &str, folder: &str) -> Result<String> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select(folder)?;
        if let Ok(data) = session.uid_fetch(uid, "(BODY.PEEK[HEADER.FIELDS (FROM)])") {
            for fetch in data.iter() {
                if let Some(header) = fetch.header() {
                    let from = mail_headers::value(&String::from_utf8_lossy(header), "From:")
                        .unwrap_or_default();
                    // strip display name: "Name <a@b.c>" → a@b.c
                    let from = from
                        .split('<')
                        .next_back()
                        .and_then(|s| s.strip_suffix('>'))
                        .unwrap_or(&from)
                        .trim()
                        .to_string();
                    if !from.is_empty() {
                        return Ok(from);
                    }
                }
            }
        }
        Ok(String::new())
    }

    /// Полное тело письма по UID. SELECT обязательна: после чистого
    /// /connect ни одна папка не выбрана, и UID FETCH отвечал BAD,
    /// молча оставляя тело пустым.
    pub async fn fetch_message_body(&mut self, uid: &str, folder: &str) -> Result<String> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select(folder)?;
        if let Ok(data) = session.uid_fetch(uid, "(RFC822.TEXT)") {
            for fetch in data.iter() {
                if let Some(body) = fetch.text() {
                    return Ok(mail_codec::quoted_printable(&String::from_utf8_lossy(body)));
                }
            }
        }

        Ok(String::new())
    }

    pub async fn mark_as_read(&mut self, uid: &str) -> Result<()> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.uid_store(uid, "+FLAGS (\\Seen)")?;
        Ok(())
    }

    pub async fn send_email(&self, to: &str, subject: &str, body: &str) -> Result<()> {
        self.send_email_with_id(to, subject, body, None).await
    }

    /// SMTP-отправка с заданным Message-ID (data-письма DoD ссылаются на
    /// него — получатель найдёт тело по Message-ID при выкачке по клику).
    pub async fn send_email_with_id(
        &self,
        to: &str,
        subject: &str,
        body: &str,
        message_id: Option<&str>,
    ) -> Result<()> {
        let from_mailbox: Mailbox = self.config.email.parse().context("Invalid sender email")?;
        let to_mailbox: Mailbox = to.parse().context("Invalid recipient email")?;

        let mut builder = Message::builder()
            .from(from_mailbox)
            .to(to_mailbox)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN);
        if let Some(mid) = message_id {
            builder = builder.message_id(Some(mid.to_string()));
        }
        let email = builder
            .body(mail_codec::fold_lines(body))
            .context("Failed to build email")?;

        let creds = Credentials::new(self.config.email.clone(), self.config.password.clone());

        // Порт 465 = SMTPS (TLS сразу), 587 = STARTTLS. Отличие критично:
        // starttls на 465 рвёт соединение на первом же STARTTLS.
        let transport_builder = if self.config.smtp_port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&self.config.smtp_server)?
                .port(self.config.smtp_port)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.config.smtp_server)?
                .port(self.config.smtp_port)
        };
        let transport = transport_builder.credentials(creds).build();

        transport
            .send(email)
            .await
            .context("Failed to send email")?;
        Ok(())
    }

    pub fn disconnect(&mut self) {
        if let Some(mut session) = self.imap_session.take() {
            let _ = session.logout();
        }
    }
}
