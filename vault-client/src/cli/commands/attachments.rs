//! File attachment handling for Vault CLI.
//!
//! Provides file info display, size limit validation per email provider,
//! MIME multipart construction, and encryption via the Encryptor module.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Maximum attachment sizes per email provider (in bytes)
pub struct ProviderLimits;

impl ProviderLimits {
    pub const GMAIL: usize = 25 * 1024 * 1024; // 25 MB
    pub const OUTLOOK: usize = 20 * 1024 * 1024; // 20 MB
    pub const YANDEX: usize = 30 * 1024 * 1024; // 30 MB
    pub const MAIL_RU: usize = 25 * 1024 * 1024; // 25 MB
    pub const DEFAULT: usize = 25 * 1024 * 1024; // 25 MB (safe default)

    /// Get max attachment size for a given IMAP server hostname
    pub fn for_server(server: &str) -> usize {
        let server_lower = server.to_lowercase();
        if server_lower.contains("gmail") || server_lower.contains("googlemail") {
            Self::GMAIL
        } else if server_lower.contains("outlook") || server_lower.contains("office365") {
            Self::OUTLOOK
        } else if server_lower.contains("yandex") {
            Self::YANDEX
        } else if server_lower.contains("mail.ru") {
            Self::MAIL_RU
        } else {
            Self::DEFAULT
        }
    }

    /// Human-readable label for the limit
    pub fn label_for_server(server: &str) -> &'static str {
        let server_lower = server.to_lowercase();
        if server_lower.contains("gmail") || server_lower.contains("googlemail") {
            "Gmail (25 MB)"
        } else if server_lower.contains("outlook") || server_lower.contains("office365") {
            "Outlook (20 MB)"
        } else if server_lower.contains("yandex") {
            "Yandex (30 MB)"
        } else if server_lower.contains("mail.ru") {
            "Mail.ru (25 MB)"
        } else {
            "Default (25 MB)"
        }
    }
}

/// Information about a file to be attached
#[derive(Debug, Clone)]
pub struct FileInfo {
    pub path: PathBuf,
    pub filename: String,
    pub size: u64,
    pub mime_type: String,
}

impl FileInfo {
    /// Read file info from a path
    pub fn from_path(path: &str) -> Result<Self> {
        let path_buf = PathBuf::from(path);
        let metadata =
            std::fs::metadata(&path_buf).with_context(|| format!("Cannot read file: {}", path))?;

        if !metadata.is_file() {
            anyhow::bail!("Path is not a file: {}", path);
        }

        let filename = path_buf
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let mime_type = mime_guess::from_path(&path_buf)
            .first_or_octet_stream()
            .to_string();

        Ok(Self {
            path: path_buf,
            filename,
            size: metadata.len(),
            mime_type,
        })
    }

    /// Check if the file exceeds a size limit
    pub fn check_size_limit(&self, max_bytes: usize) -> Result<()> {
        if self.size as usize > max_bytes {
            anyhow::bail!(
                "File '{}' ({}) exceeds limit ({})",
                self.filename,
                human_size(self.size as usize),
                human_size(max_bytes)
            );
        }
        Ok(())
    }

    /// Read file contents
    pub fn read_contents(&self) -> Result<Vec<u8>> {
        std::fs::read(&self.path).with_context(|| format!("Failed to read file: {}", self.filename))
    }
}

/// Format a byte size to a human-readable string
pub fn human_size(bytes: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = 1024 * KB;
    const GB: usize = 1024 * MB;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Encrypted file envelope — the format used for Vault file attachments.
///
/// Format:
/// ```text
/// ---BEGIN VAULT ENCRYPTED---
/// Version: 1
/// Type: file
/// Filename: document.pdf
/// Content-Type: application/pdf
/// ---
/// <base64-encoded payload>
/// <base64-encoded signature>
/// ---END VAULT ENCRYPTED---
/// ```
///
/// The payload is: nonce (24 bytes) || ciphertext || enc_key (32 bytes)
pub struct EncryptedEnvelope;

impl EncryptedEnvelope {
    const BEGIN_MARKER: &'static str = "---BEGIN VAULT ENCRYPTED---";
    const END_MARKER: &'static str = "---END VAULT ENCRYPTED---";

    /// Build a Vault encrypted envelope from raw file data
    pub fn build(
        filename: &str,
        content_type: &str,
        encrypted_payload_b64: &str,
        signature_b64: &str,
    ) -> String {
        format!(
            "{}\nVersion: 1\nType: file\nFilename: {}\nContent-Type: {}\n---\n{}\n{}\n{}\n",
            Self::BEGIN_MARKER,
            filename,
            content_type,
            encrypted_payload_b64,
            signature_b64,
            Self::END_MARKER,
        )
    }

    /// Parse an encrypted envelope and extract filename, content_type, payload_b64, signature_b64
    pub fn parse(envelope: &str) -> Result<EncryptedEnvelopeData> {
        let envelope = envelope.trim();

        let start = envelope
            .find(Self::BEGIN_MARKER)
            .context("Missing BEGIN marker")?;
        let end = envelope
            .find(Self::END_MARKER)
            .context("Missing END marker")?;

        let block = &envelope[start + Self::BEGIN_MARKER.len()..end];
        let block = block.trim();

        // Split on "---" separator
        let sep_pos = block.find("---").context("Missing header/body separator")?;
        let header = block[..sep_pos].trim();
        let body = block[sep_pos + 3..].trim();

        // Parse header
        let mut version = None;
        let mut data_type = None;
        let mut filename = None;
        let mut content_type = None;

        for line in header.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("Version: ") {
                version = Some(v.trim().to_string());
            } else if let Some(t) = line.strip_prefix("Type: ") {
                data_type = Some(t.trim().to_string());
            } else if let Some(f) = line.strip_prefix("Filename: ") {
                filename = Some(f.trim().to_string());
            } else if let Some(ct) = line.strip_prefix("Content-Type: ") {
                content_type = Some(ct.trim().to_string());
            }
        }

        let _version = version.context("Missing Version in header")?;
        let type_str = data_type.context("Missing Type in header")?;
        if type_str != "file" {
            anyhow::bail!("Expected Type: file, got: {}", type_str);
        }

        let lines: Vec<&str> = body.lines().collect();
        if lines.len() < 2 {
            anyhow::bail!("Expected payload and signature in body");
        }

        Ok(EncryptedEnvelopeData {
            filename: filename.unwrap_or_else(|| "unknown".into()),
            content_type: content_type.unwrap_or_else(|| "application/octet-stream".into()),
            payload_b64: lines[0].trim().to_string(),
            signature_b64: lines[1].trim().to_string(),
        })
    }

    /// Check if a string looks like a Vault encrypted file envelope
    pub fn is_file_envelope(input: &str) -> bool {
        input.contains(Self::BEGIN_MARKER)
            && input.contains(Self::END_MARKER)
            && input.contains("Type: file")
    }
}

/// Parsed data from an encrypted envelope
#[derive(Debug, Clone)]
pub struct EncryptedEnvelopeData {
    pub filename: String,
    pub content_type: String,
    pub payload_b64: String,
    pub signature_b64: String,
}

/// Build a MIME multipart body for an encrypted file attachment.
///
/// The format wraps the encrypted envelope in a MIME multipart structure
/// suitable for SMTP transport.
pub fn build_mime_multipart(
    encrypted_envelope: &str,
    filename: &str,
    content_type: &str,
) -> String {
    let boundary = format!("----VaultAttachment_{}", uuid::Uuid::new_v4());

    format!(
        "Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\
         \r\n\
         --{boundary}\r\n\
         Content-Type: text/plain; charset=\"utf-8\"\r\n\
         Content-Transfer-Encoding: 7bit\r\n\
         \r\n\
         This is a Vault encrypted file attachment.\r\n\
         Decrypt with /decrypt or a Vault client.\r\n\
         \r\n\
         --{boundary}\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Disposition: attachment; filename=\"{filename}.vault\"\r\n\
         Content-Transfer-Encoding: base64\r\n\
         \r\n\
         {envelope_b64}\r\n\
         --{boundary}--\r\n",
        boundary = boundary,
        filename = filename,
        envelope_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            encrypted_envelope.as_bytes(),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_limits_gmail() {
        assert_eq!(
            ProviderLimits::for_server("imap.gmail.com"),
            25 * 1024 * 1024
        );
        assert_eq!(
            ProviderLimits::label_for_server("imap.gmail.com"),
            "Gmail (25 MB)"
        );
    }

    #[test]
    fn test_provider_limits_outlook() {
        assert_eq!(
            ProviderLimits::for_server("outlook.office365.com"),
            20 * 1024 * 1024
        );
        assert_eq!(
            ProviderLimits::label_for_server("outlook.office365.com"),
            "Outlook (20 MB)"
        );
    }

    #[test]
    fn test_provider_limits_yandex() {
        assert_eq!(
            ProviderLimits::for_server("imap.yandex.com"),
            30 * 1024 * 1024
        );
        assert_eq!(
            ProviderLimits::label_for_server("imap.yandex.com"),
            "Yandex (30 MB)"
        );
    }

    #[test]
    fn test_provider_limits_mail_ru() {
        assert_eq!(ProviderLimits::for_server("imap.mail.ru"), 25 * 1024 * 1024);
        assert_eq!(
            ProviderLimits::label_for_server("imap.mail.ru"),
            "Mail.ru (25 MB)"
        );
    }

    #[test]
    fn test_provider_limits_default() {
        assert_eq!(
            ProviderLimits::for_server("imap.unknown.com"),
            25 * 1024 * 1024
        );
    }

    #[test]
    fn test_human_size() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(1048576), "1.0 MB");
        assert_eq!(human_size(1073741824), "1.0 GB");
    }

    #[test]
    fn test_file_info_from_path() {
        let temp_dir = std::env::temp_dir().join("vault_attachment_test");
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("test_doc.pdf");
        std::fs::write(&file_path, b"test content for pdf").unwrap();

        let info = FileInfo::from_path(file_path.to_str().unwrap()).unwrap();
        assert_eq!(info.filename, "test_doc.pdf");
        assert_eq!(info.size, 20);
        assert!(info.mime_type.contains("pdf") || info.mime_type.contains("octet-stream"));

        std::fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_file_info_not_found() {
        let result = FileInfo::from_path("/nonexistent/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_file_info_directory_rejected() {
        let temp_dir = std::env::temp_dir().join("vault_attachment_dir_test");
        std::fs::create_dir_all(&temp_dir).unwrap();

        let result = FileInfo::from_path(temp_dir.to_str().unwrap());
        assert!(result.is_err());

        std::fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_check_size_limit_within() {
        let info = FileInfo {
            path: PathBuf::from("test.txt"),
            filename: "test.txt".into(),
            size: 1024,
            mime_type: "text/plain".into(),
        };
        assert!(info.check_size_limit(25 * 1024 * 1024).is_ok());
    }

    #[test]
    fn test_check_size_limit_exceeded() {
        let info = FileInfo {
            path: PathBuf::from("big.bin"),
            filename: "big.bin".into(),
            size: 30 * 1024 * 1024, // 30 MB
            mime_type: "application/octet-stream".into(),
        };
        // Outlook limit is 20 MB
        assert!(info.check_size_limit(ProviderLimits::OUTLOOK).is_err());
        // Yandex limit is 30 MB — exactly at limit, should pass
        assert!(info.check_size_limit(ProviderLimits::YANDEX).is_ok());
    }

    #[test]
    fn test_encrypted_envelope_build_and_parse() {
        let envelope = EncryptedEnvelope::build(
            "secret.pdf",
            "application/pdf",
            "dGVzdHBheWxvYWQ=",     // base64("testpayload")
            "dGVzdHNpZ25hdHVyZQ==", // base64("testsignature")
        );

        assert!(envelope.contains("---BEGIN VAULT ENCRYPTED---"));
        assert!(envelope.contains("Type: file"));
        assert!(envelope.contains("Filename: secret.pdf"));
        assert!(envelope.contains("Content-Type: application/pdf"));
        assert!(envelope.contains("---END VAULT ENCRYPTED---"));

        let parsed = EncryptedEnvelope::parse(&envelope).unwrap();
        assert_eq!(parsed.filename, "secret.pdf");
        assert_eq!(parsed.content_type, "application/pdf");
        assert_eq!(parsed.payload_b64, "dGVzdHBheWxvYWQ=");
        assert_eq!(parsed.signature_b64, "dGVzdHNpZ25hdHVyZQ==");
    }

    #[test]
    fn test_encrypted_envelope_is_file_envelope() {
        let envelope = EncryptedEnvelope::build("doc.txt", "text/plain", "payload", "sig");
        assert!(EncryptedEnvelope::is_file_envelope(&envelope));
        assert!(!EncryptedEnvelope::is_file_envelope("not an envelope"));
    }

    #[test]
    fn test_encrypted_envelope_parse_missing_begin() {
        let result = EncryptedEnvelope::parse("no markers here");
        assert!(result.is_err());
    }

    #[test]
    fn test_build_mime_multipart() {
        let multipart =
            build_mime_multipart("encrypted envelope data", "report.pdf", "application/pdf");
        assert!(multipart.contains("Content-Type: multipart/mixed"));
        assert!(multipart.contains("report.pdf.vault"));
        assert!(multipart.contains("Vault encrypted file attachment"));
    }

    #[test]
    fn test_file_info_read_contents() {
        let temp_dir = std::env::temp_dir().join("vault_read_test");
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("data.bin");
        let data = vec![0u8, 1, 2, 3, 255, 254];
        std::fs::write(&file_path, &data).unwrap();

        let info = FileInfo::from_path(file_path.to_str().unwrap()).unwrap();
        let contents = info.read_contents().unwrap();
        assert_eq!(contents, data);

        std::fs::remove_dir_all(&temp_dir).unwrap();
    }
}
