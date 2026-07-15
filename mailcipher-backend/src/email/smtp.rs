use lettre::message::{header::ContentType, Mailbox, Message, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use crate::error::AppError;

pub struct SmtpClient {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    server: String,
    port: u16,
    username: String,
    password: String,
    use_tls: bool,
}

#[derive(Debug)]
pub struct EmailAttachment {
    pub filename: String,
    pub content_type: ContentType,
    pub body: Vec<u8>,
}

impl SmtpClient {
    pub fn new(
        server: &str,
        port: u16,
        username: &str,
        password: &str,
        use_tls: bool,
    ) -> Self {
        SmtpClient {
            transport: None,
            server: server.to_string(),
            port,
            username: username.to_string(),
            password: password.to_string(),
            use_tls,
        }
    }

    pub async fn connect(&mut self) -> Result<(), AppError> {
        let credentials = Credentials::new(
            self.username.clone(),
            self.password.clone(),
        );

        let transport = if self.use_tls {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.server)
                .map_err(|e| AppError::Internal(format!("Failed to create SMTP transport: {}", e)))?
                .port(self.port)
                .credentials(credentials)
                .build()
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.server)
                .port(self.port)
                .credentials(credentials)
                .build()
        };

        self.transport = Some(transport);
        Ok(())
    }

    pub async fn send_email(
        &self,
        from: &str,
        to: &[&str],
        subject: &str,
        body: &str,
        is_html: bool,
    ) -> Result<(), AppError> {
        let transport = self.transport.as_ref()
            .ok_or_else(|| AppError::Internal("Not connected".to_string()))?;

        let from_mailbox: Mailbox = from.parse()
            .map_err(|e| AppError::Internal(format!("Invalid from address: {}", e)))?;

        let mut message = Message::builder()
            .from(from_mailbox)
            .subject(subject);

        for recipient in to {
            let to_mailbox: Mailbox = recipient.parse()
                .map_err(|e| AppError::Internal(format!("Invalid to address: {}", e)))?;
            message = message.to(to_mailbox);
        }

        let message = if is_html {
            message
                .header(ContentType::TEXT_HTML)
                .body(body.to_string())
                .map_err(|e| AppError::Internal(format!("Failed to create message: {}", e)))?
        } else {
            message
                .body(body.to_string())
                .map_err(|e| AppError::Internal(format!("Failed to create message: {}", e)))?
        };

        transport
            .send(message)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to send email: {}", e)))?;

        Ok(())
    }

    pub async fn send_email_with_attachments(
        &self,
        from: &str,
        to: &[&str],
        subject: &str,
        body: &str,
        is_html: bool,
        attachments: &[EmailAttachment],
    ) -> Result<(), AppError> {
        let transport = self.transport.as_ref()
            .ok_or_else(|| AppError::Internal("Not connected".to_string()))?;

        let from_mailbox: Mailbox = from.parse()
            .map_err(|e| AppError::Internal(format!("Invalid from address: {}", e)))?;

        let mut message = Message::builder()
            .from(from_mailbox)
            .subject(subject);

        for recipient in to {
            let to_mailbox: Mailbox = recipient.parse()
                .map_err(|e| AppError::Internal(format!("Invalid to address: {}", e)))?;
            message = message.to(to_mailbox);
        }

        let mut multipart = if is_html {
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(body.to_string())
                )
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(body.to_string())
                )
        } else {
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(body.to_string())
                )
        };

        for attachment in attachments {
            multipart = multipart.singlepart(
                lettre::message::Attachment::new(attachment.filename.clone())
                    .body(attachment.body.clone(), attachment.content_type.clone())
            );
        }

        let message = message
            .multipart(multipart)
            .map_err(|e| AppError::Internal(format!("Failed to create multipart message: {}", e)))?;

        transport
            .send(message)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to send email: {}", e)))?;

        Ok(())
    }

    pub async fn disconnect(&mut self) -> Result<(), AppError> {
        self.transport = None;
        Ok(())
    }
}
