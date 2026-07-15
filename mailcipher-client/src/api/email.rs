use anyhow::{Context, Result};
use imap::Session;
use lettre::message::{header::ContentType, Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use native_tls::{TlsConnector, TlsStream};
use std::net::TcpStream;

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
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select("INBOX")?;

        let message_ids = session.uid_search("ALL")?;
        let mut messages = Vec::new();

        for uid in message_ids.iter().take(50) {
            if let Ok(data) = session.uid_fetch(uid.to_string(), "(UID FLAGS RFC822.HEADER)") {
                for fetch in data.iter() {
                    let uid = fetch.uid.unwrap_or_default().to_string();
                    let flags = fetch.flags();
                    let is_read = flags.iter().any(|f| matches!(f, imap::types::Flag::Seen));

                    if let Some(header) = fetch.header() {
                        let header_str = String::from_utf8_lossy(header);
                        let from = extract_header(&header_str, "From:")
                            .unwrap_or_else(|| "Unknown".to_string());
                        let to = extract_header(&header_str, "To:")
                            .unwrap_or_else(|| "Unknown".to_string());
                        let subject = extract_header(&header_str, "Subject:")
                            .unwrap_or_else(|| "(no subject)".to_string());
                        let date = extract_header(&header_str, "Date:")
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

    pub async fn fetch_message_body(&mut self, uid: &str) -> Result<String> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        if let Ok(data) = session.uid_fetch(uid, "(RFC822.TEXT)") {
            for fetch in data.iter() {
                if let Some(body) = fetch.text() {
                    return Ok(String::from_utf8_lossy(body).to_string());
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
        let from_mailbox: Mailbox = self
            .config
            .email
            .parse()
            .context("Invalid sender email")?;
        let to_mailbox: Mailbox = to.parse().context("Invalid recipient email")?;

        let email = Message::builder()
            .from(from_mailbox)
            .to(to_mailbox)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN)
            .body(body.to_string())
            .context("Failed to build email")?;

        let creds = Credentials::new(
            self.config.email.clone(),
            self.config.password.clone(),
        );

        let transport = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(
            &self.config.smtp_server,
        )?
        .credentials(creds)
        .port(self.config.smtp_port)
        .build();

        transport.send(email).await.context("Failed to send email")?;
        Ok(())
    }

    pub fn disconnect(&mut self) {
        if let Some(mut session) = self.imap_session.take() {
            let _ = session.logout();
        }
    }
}

fn extract_header(header: &str, name: &str) -> Option<String> {
    header
        .lines()
        .find(|line| line.to_lowercase().starts_with(&name.to_lowercase()))
        .and_then(|line| line.splitn(2, ':').nth(1))
        .map(|value| value.trim().to_string())
}
