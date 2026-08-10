// Email transport (IMAP/SMTP) for the serverless Vault desktop client.
//
// Desktop talks to the mailbox directly over IMAP/SMTP instead of going through
// the backend API (localhost:9443). Mirrors the verified vault-client email.rs
// (which passed e2e tests against real Gmail), carrying over the two critical
// fixes:
//   1. fold_lines() — fold long lines to ≤76 columns before sending, otherwise
//      Gmail's spam filter flags the message.
//   2. decode_quoted_printable() — SMTP relays (Gmail included) may re-encode
//      the Vault encrypted base64 block as quoted-printable; decode it on read
//      so the base64 block doesn't break on provider line wraps.
//
// Only transport lives here — crypto (X25519/XChaCha20) is handled by the
// already-registered Tauri crypto commands.

use anyhow::{Context, Result};
use imap::Session;
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::message::Message;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::net::TcpStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailConfig {
    pub email: String,
    pub password: String,
    pub imap_server: String,
    pub imap_port: u16,
    pub smtp_server: String,
    pub smtp_port: u16,
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

/// A message summary. Body is intentionally NOT included in the list — it is
/// heavy. Fetch it on demand via `fetch_message_body(uid)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub subject: String,
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

    /// Establish a TLS IMAP connection and log in. The session is kept alive in
    /// state so subsequent commands reuse it.
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

    /// Fetch the most recent 50 messages from INBOX. UIDs are sorted descending
    /// (newest first) so we take the latest messages, not the oldest.
    pub async fn fetch_messages(&mut self) -> Result<Vec<EmailMessage>> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select("INBOX")?;

        let message_ids = session.uid_search("ALL")?;
        let mut messages = Vec::new();

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

    /// Fetch the body of a single message by UID, decoding quoted-printable so
    /// the Vault encrypted base64 block survives provider line wrapping.
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

    pub async fn send_email(&mut self, to: &str, subject: &str, body: &str) -> Result<()> {
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
/// SMTP relays and spam filters treat unbroken >100-char base64 lines as
/// suspicious, and some relays refuse long lines outright. The Vault encrypted
/// block and raw-base64 bodies are rebuilt by receivers via whitespace-stripping,
/// so folding is lossless for both codecs.
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