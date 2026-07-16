use async_imap::{Client, Session};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncReadCompatExt;
use futures::TryStreamExt;
use std::fmt;

use crate::error::AppError;

type CompatStream = tokio_util::compat::Compat<tokio_native_tls::TlsStream<TcpStream>>;
type ImapSession = Session<CompatStream>;

pub struct ImapClient {
    session: Option<ImapSession>,
    server: String,
    port: u16,
    username: String,
    password: String,
    use_tls: bool,
}

#[derive(Debug)]
pub struct EmailMessage {
    pub uid: u32,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub is_read: bool,
}

impl fmt::Display for EmailMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Email {{ uid: {}, subject: {:?}, from: {:?}, date: {:?}, is_read: {} }}",
            self.uid, self.subject, self.from, self.date, self.is_read
        )
    }
}

impl ImapClient {
    pub fn new(
        server: &str,
        port: u16,
        username: &str,
        password: &str,
        use_tls: bool,
    ) -> Self {
        ImapClient {
            session: None,
            server: server.to_string(),
            port,
            username: username.to_string(),
            password: password.to_string(),
            use_tls,
        }
    }

    pub async fn connect(&mut self) -> Result<(), AppError> {
        let addr = format!("{}:{}", self.server, self.port);

        let tcp = TcpStream::connect(&addr)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to connect: {}", e)))?;

        let connector = tokio_native_tls::native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| AppError::Internal(format!("TLS config failed: {}", e)))?;
        let tls = tokio_native_tls::TlsConnector::from(connector);

        let tls_stream = if self.use_tls {
            tls.connect(&self.server, tcp)
                .await
                .map_err(|e| AppError::Internal(format!("TLS handshake failed: {}", e)))?
        } else {
            let compat_tcp = tcp.compat();
            let mut client = Client::new(compat_tcp);

            let _greeting = client
                .read_response()
                .await
                .ok_or_else(|| AppError::Internal("Unexpected end of stream".to_string()))?
                .map_err(|e| AppError::Internal(format!("Failed to read greeting: {}", e)))?;

            let _ = client
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(|e| AppError::Internal(format!("STARTTLS failed: {}", e)))?;

            let raw_tcp = client.into_inner().into_inner();

            tls.connect(&self.server, raw_tcp)
                .await
                .map_err(|e| AppError::Internal(format!("TLS handshake failed: {}", e)))?
        };

        let compat_stream = tls_stream.compat();
        let mut client = Client::new(compat_stream);

        let _greeting = client
            .read_response()
            .await
            .ok_or_else(|| AppError::Internal("Unexpected end of stream".to_string()))?
            .map_err(|e| AppError::Internal(format!("Failed to read greeting: {}", e)))?;

        let session = client
            .login(&self.username, &self.password)
            .await
            .map_err(|(err, _)| AppError::Internal(format!("Login failed: {}", err)))?;

        self.session = Some(session);
        Ok(())
    }

    pub async fn select_mailbox(&mut self, mailbox: &str) -> Result<u32, AppError> {
        let session = self.session.as_mut()
            .ok_or_else(|| AppError::Internal("Not connected".to_string()))?;

        let mailbox_info = session
            .select(mailbox)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to select mailbox: {}", e)))?;

        Ok(mailbox_info.exists)
    }

    pub async fn fetch_messages(&mut self, mailbox: &str, limit: Option<u32>) -> Result<Vec<EmailMessage>, AppError> {
        let session = self.session.as_mut()
            .ok_or_else(|| AppError::Internal("Not connected".to_string()))?;

        session
            .select(mailbox)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to select mailbox: {}", e)))?;

        let messages_stream = session
            .search("ALL")
            .await
            .map_err(|e| AppError::Internal(format!("Failed to search messages: {}", e)))?;

        let mut uids: Vec<u32> = messages_stream.into_iter().collect();
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(limit.unwrap_or(50) as usize);

        let mut result = Vec::new();

        for uid in uids {
            let messages_stream = session
                .fetch(uid.to_string(), "(UID FLAGS RFC822.HEADER)")
                .await
                .map_err(|e| AppError::Internal(format!("Failed to fetch message: {}", e)))?;

            let messages: Vec<_> = messages_stream
                .try_collect()
                .await
                .map_err(|e| AppError::Internal(format!("Failed to collect messages: {}", e)))?;

            if let Some(msg) = messages.first() {
                let uid = msg.uid.unwrap_or(0);
                let is_read = msg.flags().any(|f| matches!(f, async_imap::types::Flag::Seen));

                let mut subject = None;
                let mut from = None;
                let mut date = None;

                if let Some(header) = msg.header() {
                    let header_str = String::from_utf8_lossy(header);
                    for line in header_str.lines() {
                        if line.to_lowercase().starts_with("subject:") {
                            subject = Some(line[8..].trim().to_string());
                        } else if line.to_lowercase().starts_with("from:") {
                            from = Some(line[5..].trim().to_string());
                        } else if line.to_lowercase().starts_with("date:") {
                            date = Some(line[5..].trim().to_string());
                        }
                    }
                }

                result.push(EmailMessage {
                    uid,
                    subject,
                    from,
                    date,
                    body: None,
                    is_read,
                });
            }
        }

        Ok(result)
    }

    pub async fn fetch_message_body(&mut self, uid: u32) -> Result<Option<String>, AppError> {
        let session = self.session.as_mut()
            .ok_or_else(|| AppError::Internal("Not connected".to_string()))?;

        let messages_stream = session
            .fetch(uid.to_string(), "(RFC822)")
            .await
            .map_err(|e| AppError::Internal(format!("Failed to fetch message body: {}", e)))?;

        let messages: Vec<_> = messages_stream
            .try_collect()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to collect messages: {}", e)))?;

        if let Some(msg) = messages.first() {
            if let Some(body) = msg.body() {
                return Ok(Some(String::from_utf8_lossy(body).to_string()));
            }
        }

        Ok(None)
    }

    pub async fn disconnect(&mut self) -> Result<(), AppError> {
        if let Some(mut session) = self.session.take() {
            let _ = session.logout().await;
        }
        Ok(())
    }
}
