//! Cross-format envelope converter (CLI↔Desktop↔send.js parity).
//!
//! Auto-detects input format:
//! - Vault envelope (ASCII-armored) → parse to JSON
//! - Vault JSON envelope → re-wrap to ASCII
//! - Base64 vault payload → decode (hex fallback)
//! - Plaintext → note (not a vault envelope)

use crate::cli::commands::attachments::EncryptedEnvelope;
use base64::Engine as _;
use std::str;

/// Dispatch to the convert command. Prints parsed/rewrapped result.
pub fn convert_envelope(text: &str) {
    if text.is_empty() {
        eprintln!("convert: empty input");
        return;
    }

    // 1. ASCII-armored envelope (Desktop EncryptedEnvelope / send.js)
    if EncryptedEnvelope::is_file_envelope(text) || text.contains("BEGIN VAULT ENCRYPTED") {
        match EncryptedEnvelope::parse(text) {
            Ok(data) => {
                println!("Parsed envelope (ASCII → JSON):");
                println!("  filename: {}", data.filename);
                println!("  content-type: {}", data.content_type);
                println!("  payload_b64: {}", data.payload_b64);
                if !data.signature_b64.is_empty() {
                    println!("  signature_b64: {}", data.signature_b64);
                }
            }
            Err(e) => eprintln!("convert: failed to parse envelope: {e}"),
        }
        return;
    }

    // 2. JSON envelope → re-wrap to ASCII
    if let Ok(json_obj) = serde_json::from_str::<serde_json::Value>(text) {
        if json_obj.get("filename").is_some() && json_obj.get("payload").is_some() {
            println!("JSON envelope detected — re-wrap with `encrypt` to produce ASCII.");
            println!("  keys: {}", json_obj.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_default());
            return;
        }
    }

    // 3. Base64 payload
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(text) {
        if let Ok(s) = str::from_utf8(&decoded) {
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(s) {
                println!("Base64-decoded → JSON:");
                println!("{}", s);
                let _ = json_val;
                return;
            }
            println!("Base64-decoded (UTF-8):");
            println!("{}", s);
            return;
        }
    }

    // 4. Hex payload fallback
    if text.len() % 2 == 0 && text.chars().all(|c| c.is_ascii_hexdigit()) && text.len() >= 32 {
        if let Ok(decoded) = (0..text.len()).step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i+2], 16))
            .collect::<Result<Vec<u8>, _>>()
        {
            if let Ok(s) = str::from_utf8(&decoded) {
                println!("Hex-decoded:");
                println!("{}", s);
                return;
            }
        }
    }

    // 5. Not a vault envelope
    println!("Input is not a recognized vault envelope format.");
    println!("Tip: /convert expects an ASCII envelope (BEGIN VAULT) or JSON.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_file_envelope_detection() {
        let env = EncryptedEnvelope::build("doc.txt", "text/plain", "dGVzdA==", "sig");
        assert!(EncryptedEnvelope::is_file_envelope(&env));
    }

    #[test]
    fn test_parse_and_roundtrip() {
        let original = EncryptedEnvelope::build("photo.png", "image/png", "AAAABB", "sig");
        let parsed = EncryptedEnvelope::parse(&original).unwrap();
        assert_eq!(parsed.filename, "photo.png");
        assert_eq!(parsed.content_type, "image/png");
        assert_eq!(parsed.payload_b64, "AAAABB");
        assert_eq!(parsed.signature_b64, "sig".to_string());
    }

    #[test]
    fn test_convert_empty() {
        convert_envelope(""); // should not panic, prints error to stderr
    }

    #[test]
    fn test_convert_non_envelope() {
        convert_envelope("hello world this is not an envelope");
    }
}
