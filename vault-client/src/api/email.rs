use anyhow::{Context, Result};
use imap::Session;
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::message::Message;
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
            for name in names.iter() {
                let has_junk = name.attributes().iter().any(|a| {
                    matches!(
                        a,
                        imap::types::NameAttribute::Custom(s)
                            if s == "\\Junk" || s == "\\Spam"
                    )
                });
                if has_junk {
                    return name.name().to_string();
                }
            }
        }
        "[Gmail]/Spam".to_string()
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
                    return Ok(decode_quoted_printable(&String::from_utf8_lossy(body)));
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
        let from_mailbox: Mailbox = self.config.email.parse().context("Invalid sender email")?;
        let to_mailbox: Mailbox = to.parse().context("Invalid recipient email")?;

        let email = Message::builder()
            .from(from_mailbox)
            .to(to_mailbox)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN)
            .body(fold_lines(body))
            .context("Failed to build email")?;

        let creds = Credentials::new(self.config.email.clone(), self.config.password.clone());

        let transport =
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.config.smtp_server)?
                .credentials(creds)
                .port(self.config.smtp_port)
                .build();

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

/// Decode quoted-printable MIME body — transport-encoded `=XX` and soft line
/// breaks (`=\r\n`). Needed because SMTP relays (Gmail included) may re-encode
/// the Vault encrypted block (base64) as quoted-printable on delivery.
fn decode_quoted_printable(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'=' => {
                // Soft line break: "=\r\n" or "=\n" → skip entirely
                if i + 1 < bytes.len() && (bytes[i + 1] == b'\r' || bytes[i + 1] == b'\n') {
                    i += if i + 2 < bytes.len() && bytes[i + 1] == b'\r' && bytes[i + 2] == b'\n' {
                        3
                    } else {
                        2
                    };
                    continue;
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
                // Literal '=' (shouldn't happen, but keep)
                out.push(b'=');
                i += 1;
            }
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                // Normalize CRLF → LF
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

/// Fold long lines to ≤76 columns (RFC 5322 soft wrap) before sending.
/// SMTP relays and spam filters treat unbroken >100-char base64 lines as suspicious,
/// and some relays refuse long lines outright. The Vault encrypted block and
/// raw-base64 bodies are rebuilt by receivers via whitespace-stripping, so folding
/// is lossless for both codecs.
fn fold_lines(body: &str) -> String {
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

fn extract_header(header: &str, name: &str) -> Option<String> {
    header
        .lines()
        .find(|line| line.to_lowercase().starts_with(&name.to_lowercase()))
        .and_then(|line| line.splitn(2, ':').nth(1))
        .map(|value| value.trim().to_string())
}
