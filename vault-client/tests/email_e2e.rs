//! E2E email transport test: encrypt → SMTP (alice) → IMAP (bob) → decrypt.
//!
//! Requires real Gmail accounts. Credentials come from environment:
//!   VAULT_TEST_ALICE_EMAIL / VAULT_TEST_ALICE_PASS
//!   VAULT_TEST_BOB_EMAIL   / VAULT_TEST_BOB_PASS
//!
//! Run via scripts/run-email-e2e.sh (loads gitignored scripts/.email_test_env).

use anyhow::{bail, Context, Result};
use vault_client::api::email::{EmailClient, EmailConfig};
use vault_client::crypto::encryptor::{DecryptedContent, Encryptor};

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("env var {name} is not set"))
}

/// Unique subject marker so Bob can find exactly our message.
fn marker() -> String {
    format!(
        "[VAULT-E2E] {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    )
}

#[tokio::test]
#[ignore = "requires real Gmail app passwords (scripts/run-email-e2e.sh)"]
async fn e2e_encrypt_via_smtp_decrypt_via_imap() -> Result<()> {
    let alice_email = env("VAULT_TEST_ALICE_EMAIL")?;
    let alice_pass = env("VAULT_TEST_ALICE_PASS")?;
    let bob_email = env("VAULT_TEST_BOB_EMAIL")?;
    let bob_pass = env("VAULT_TEST_BOB_PASS")?;

    // 1. Alice and Bob share a group/session key (E2E: key exchange happened earlier —
    //    via /keyshare, QR, or /invite as in Session). Same 32-byte signing key.
    let key_bytes: [u8; 32] = *b"vault-e2e-shared-key-0123456789a"; // 32 bytes
    let alice = Encryptor::from_key_bytes(&key_bytes);
    let bob = Encryptor::from_key_bytes(&key_bytes);
    let plaintext = "Привет, Боб! Это E2E-тест Vault: привет мир 123!";
    let encrypted = alice.encrypt_text(plaintext);
    assert!(
        encrypted.contains("---BEGIN VAULT ENCRYPTED---"),
        "encrypted block missing BEGIN marker"
    );
    eprintln!("✓ Encryptor: alice keyshares with bob (same key bytes)");

    // 2. Alice sends the encrypted payload via SMTP
    let alice_client = EmailClient::new(EmailConfig {
        email: alice_email.clone(),
        password: alice_pass,
        ..EmailConfig::default()
    });
    let subject = marker();
    alice_client
        .send_email(&bob_email, &subject, &encrypted)
        .await
        .context("SMTP send failed")?;
    eprintln!("✓ SMTP: alice → bob, subject={subject}");

    // 3. Bob polls IMAP for the message
    let mut bob_client = EmailClient::new(EmailConfig {
        email: bob_email.clone(),
        password: bob_pass,
        ..EmailConfig::default()
    });
    bob_client
        .connect_imap()
        .await
        .context("IMAP connect failed")?;

    let found = poll_for_message(&mut bob_client, &subject).await?;

    // 4. Bob decrypts using the shared key
    match bob.decrypt(&found) {
        Ok(DecryptedContent::Text(text)) => {
            assert_eq!(text, plaintext, "decrypted text mismatch");
            println!("✅ E2E PASS: alice encrypted → SMTP → IMAP → bob decrypted");
            println!("   plaintext: {text}");
        }
        Ok(_) => bail!("expected Text content, got File"),
        Err(e) => bail!("bob could not decrypt with shared key: {e:#}"),
    }

    Ok(())
}

/// Poll the INBOX for a message with the given subject (up to ~90s).
async fn poll_for_message(client: &mut EmailClient, subject: &str) -> Result<String> {
    // UID search requires an open session; EmailClient exposes fetch_messages.
    for attempt in 1..=18u32 {
        let msgs = client.fetch_messages().await.context("IMAP fetch failed")?;

        if let Some(msg) = msgs.iter().find(|m| m.subject.contains(subject)) {
            let body = client
                .fetch_message_body(&msg.id)
                .await
                .context("fetch body failed")?;
            return Ok(body);
        }

        eprintln!(
            "  poll {attempt}/18: subject not found yet ({} msgs in INBOX), sleeping 5s…",
            msgs.len()
        );
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }

    bail!("message with subject {subject} not found in INBOX after 90s")
}
