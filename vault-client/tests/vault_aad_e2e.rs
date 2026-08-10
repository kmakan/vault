//! E2E AAD (Associated Data) vault-marker test over real email.
//!
//! Models the real Desktop chat flow. Since 10.08 the vault marker "VAULT"
//! lives ONLY in the XChaCha20-Poly1305 AAD (`CryptoClient::encrypt_vault` /
//! `decrypt_vault`), not as a plaintext prefix. A ciphertext is a vault message
//! iff `decrypt_vault` succeeds with AAD="VAULT"; plain mail / a foreign key
//! must return `Err`.
//!
//! 1. Alice & Bob each generate an X25519 keypair (CryptoClient).
//! 2. They exchange public keys directly in memory (key transport is covered by
//!    key_exchange_e2e) — alice.peer = bob pub, bob.peer = alice pub.
//! 3. Alice encrypts with `encrypt_vault`; the marker/plaintext are NOT in the
//!    ciphertext stream.
//! 4. Alice → SMTP → Bob (subject is a UX marker; body is clean base64 AAD).
//! 5. Bob fetches body and `decrypt_vault` → Ok — this IS a vault message.
//! 6. Error case: `decrypt_vault` of a non-vault (plain / non-AAD / wrong-key)
//!    message → Err, so only vault mails reach the chat.
//! 7. Bob encrypts `encrypt_vault` reply → SMTP → Alice → decrypt → Ok.
//! 8. `decrypt_vault` of short bytes / random base64 → Err, not a panic.
//!
//! Requires real Gmail accounts. Credentials come from environment:
//!   VAULT_TEST_ALICE_EMAIL / VAULT_TEST_ALICE_PASS
//!   VAULT_TEST_BOB_EMAIL   / VAULT_TEST_BOB_PASS
//!
//! Run via scripts/run-email-e2e.sh (loads gitignored scripts/.email_test_env).

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use vault_client::api::email::{EmailClient, EmailConfig};
use vault_client::crypto::CryptoClient;

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("env var {name} is not set"))
}

/// Unique subject marker (SystemTime nanos) so Alice/Bob can find our messages
/// even when the e2e suite runs several tests concurrently.
fn unique_subject(direction: &str) -> String {
    format!(
        "[VAULT-AAD/{direction}] {}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

/// Poll the INBOX (then the junk folder as fallback) for a message with the
/// given subject. Gmail's spam filter sometimes routes test mail away from
/// INBOX; delivery is still successful, so the test treats Junk hits as OK.
/// Returns (uid, body) — uid is needed for mark_as_read.
async fn poll_for_message(client: &mut EmailClient, subject: &str) -> Result<(String, String)> {
    for attempt in 1..=12u32 {
        let msgs = client
            .fetch_messages()
            .await
            .context("IMAP fetch failed")?;

        if let Some(msg) = msgs.iter().find(|m| m.subject.contains(subject)) {
            let uid = msg.id.clone();
            let body = client
                .fetch_message_body(&uid)
                .await
                .context("fetch body failed")?;
            return Ok((uid, body));
        }

        eprintln!(
            "  poll {attempt}/12 (INBOX): subject not found yet ({} msgs), sleeping 5s…",
            msgs.len()
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
    }

    // Fallback: Gmail junk folder (localized). Delivery succeeded — the mail
    // just landed in Spam. Find it there so B→A direction is still verified.
    eprintln!("  INBOX exhausted — falling back to junk folder…");
    let junk = client.junk_folder().await;
    eprintln!("  junk folder resolved as: {junk}");
    for attempt in 1..=4u32 {
        let msgs = client.fetch_messages_from(&junk).await.unwrap_or_default();
        if !msgs.is_empty() {
            eprintln!("  junk check {attempt}/4: {} msgs", msgs.len());
        }
        if let Some(msg) = msgs.iter().find(|m| m.subject.contains(subject)) {
            let uid = msg.id.clone();
            let body = client
                .fetch_message_body(&uid)
                .await
                .context("fetch body (junk) failed")?;
            eprintln!("  ✓ found in junk folder (Gmail spam filter)");
            return Ok((uid, body));
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }

    bail!("message with subject {subject} not found in INBOX or junk folder after ~80s")
}

#[tokio::test]
#[ignore = "requires real Gmail app passwords (scripts/run-email-e2e.sh)"]
async fn vault_aad_marker_roundtrip_e2e() -> Result<()> {
    let alice_email = env("VAULT_TEST_ALICE_EMAIL")?;
    let bob_email = env("VAULT_TEST_BOB_EMAIL")?;
    let alice_pass = env("VAULT_TEST_ALICE_PASS")?;
    let bob_pass = env("VAULT_TEST_BOB_PASS")?;

    // -- 1. Alice & Bob: each own X25519 keypair ------------------------------
    let mut alice_crypto = CryptoClient::new();
    let (alice_pub, _alice_priv) = alice_crypto.generate_keypair();
    let mut bob_crypto = CryptoClient::new();
    let (bob_pub, _bob_priv) = bob_crypto.generate_keypair();
    println!("[vault-aad] step 1: alice/bob X25519 keypairs generated");

    // -- 2. In-memory peer key exchange (transport covered elsewhere) ---------
    alice_crypto
        .set_peer_key(&bob_pub)
        .context("Alice could not set Bob's public key")?;
    bob_crypto
        .set_peer_key(&alice_pub)
        .context("Bob could not set Alice's public key")?;
    println!("[vault-aad] step 2: alice.peer=bob, bob.peer=alice (in-memory DH)");

    // -- 3. Alice: encrypt_vault — marker/plaintext must NOT leak -------------
    let plaintext_ab = "привет, я A";
    let enc_ab = alice_crypto
        .encrypt_vault(plaintext_ab)
        .context("Alice: encrypt_vault failed")?;
    assert!(
        !enc_ab.contains("VAULT"),
        "AAD label 'VAULT' leaked into ciphertext stream"
    );
    assert!(
        !enc_ab.contains("---BEGIN"),
        "legacy PEM header leaked into ciphertext stream"
    );
    assert!(
        !enc_ab.contains("привет"),
        "plaintext leaked into ciphertext stream"
    );
    println!("[vault-aad] step 3: encrypt_vault OK — body holds no 'VAULT'/'---BEGIN'/plaintext");

    // -- 4. Alice → SMTP → Bob -------------------------------------------------
    let alice_sender = EmailClient::new(EmailConfig {
        email: alice_email.clone(),
        password: alice_pass.clone(),
        ..EmailConfig::default()
    });
    let subject_ab = unique_subject("ab");
    alice_sender
        .send_email(&bob_email, &subject_ab, &enc_ab)
        .await
        .context("SMTP alice→bob failed")?;
    println!("[vault-aad] step 4: SMTP alice→bob, subject={subject_ab}");

    // -- 5. Bob: poll IMAP, decrypt_vault → Ok (a vault message) ---------------
    let mut bob_client = EmailClient::new(EmailConfig {
        email: bob_email.clone(),
        password: bob_pass.clone(),
        ..EmailConfig::default()
    });
    bob_client
        .connect_imap()
        .await
        .context("IMAP connect (bob) failed")?;
    let (uid_ab, body_ab) = poll_for_message(&mut bob_client, &subject_ab).await?;
    let dec_ab = bob_crypto
        .decrypt_vault(&body_ab)
        .context("Bob could not decrypt_vault A→B message")?;
    assert_eq!(dec_ab, plaintext_ab, "A→B vault plaintext mismatch");
    println!("[vault-aad] step 5: Bob decrypt_vault Ok → {dec_ab:?} (vault mail)");
    bob_client
        .mark_as_read(&uid_ab)
        .await
        .context("mark Bob A→B message as read failed")?;

    // -- 6. ERROR CASE: non-vault mail must decrypt_vault → Err ---------------
    // 6a. Plain text (not even base64) — chat must reject it.
    let plain_err = bob_crypto.decrypt_vault("hello");
    assert!(plain_err.is_err(), "plain text must NOT decrypt as a vault message");

    // 6b. Ciphertext with the SAME shared DH key, but encrypted WITHOUT the
    //     "VAULT" AAD (legacy `alice_crypto.encrypt()`). AAD auth must fail → Err.
    let non_vault = alice_crypto.encrypt("hello");
    let non_vault_err = bob_crypto.decrypt_vault(&non_vault);
    assert!(
        non_vault_err.is_err(),
        "ciphertext without AAD('VAULT') must fail decrypt_vault"
    );

    // 6c. Vault AAD ciphertext, but with a WRONG key (a forged/foreign message
    //     claiming to be vault) — must fail decryption.
    let mut mallory = CryptoClient::new();
    let _ = mallory.generate_keypair(); // untrusted keypair, not alice
    let forged = mallory
        .encrypt_vault("not really from alice")
        .context("mallory encrypt_vault failed")?;
    let forged_err = bob_crypto.decrypt_vault(&forged);
    assert!(
        forged_err.is_err(),
        "vault ciphertext with wrong key must fail decrypt_vault"
    );
    println!("[vault-aad] step 6: plain / non-AAD / wrong-key all reject via decrypt_vault Err ✓");

    // -- 7. Bob: encrypt_vault reply → SMTP → Alice → decrypt Ok --------------
    let plaintext_ba = "привет, я B";
    let enc_ba = bob_crypto
        .encrypt_vault(plaintext_ba)
        .context("Bob: encrypt_vault reply failed")?;
    let subject_ba = unique_subject("ba");
    bob_client
        .send_email(&alice_email.clone(), &subject_ba, &enc_ba)
        .await
        .context("SMTP bob→alice failed")?;
    println!("[vault-aad] step 7a: SMTP bob→alice, subject={subject_ba}");

    let mut alice_client = EmailClient::new(EmailConfig {
        email: alice_email,
        password: alice_pass,
        ..EmailConfig::default()
    });
    alice_client
        .connect_imap()
        .await
        .context("IMAP connect (alice) failed")?;
    let (uid_ba, body_ba) = poll_for_message(&mut alice_client, &subject_ba).await?;
    let dec_ba = alice_crypto
        .decrypt_vault(&body_ba)
        .context("Alice could not decrypt_vault B→A message")?;
    assert_eq!(dec_ba, plaintext_ba, "B→A vault plaintext mismatch");
    alice_client
        .mark_as_read(&uid_ba)
        .await
        .context("mark Alice B→A message as read failed")?;
    println!("[vault-aad] step 7b: Alice decrypt_vault Ok → {dec_ba:?}");

    // -- 8. decrypt_vault of malformed base64 → Err, not a panic --------------
    // 8a. Base64 decoding to <24 bytes (too short for the nonce‖ct scheme).
    let short = "aGk="; // decodes to 3 bytes
    let short_err = alice_crypto.decrypt_vault(short);
    assert!(short_err.is_err(), "decrypt_vault must reject <24-byte payload");

    // 8b. Random bytes (>= 24) that are valid base64 but NOT our nonce‖ct AAD
    //     scheme — AAD auth must fail → Err (no panic, no accidental Ok).
    let mut random_bytes = [0u8; 40];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut random_bytes);
    let random_b64 = BASE64.encode(random_bytes);
    let random_err = alice_crypto.decrypt_vault(&random_b64);
    assert!(
        random_err.is_err(),
        "decrypt_vault must reject random base64 (not our AAD scheme)"
    );
    println!("[vault-aad] step 8: short/random base64 → Err (no panic) ✓");

    bob_client.disconnect();
    alice_client.disconnect();

    println!("[vault-aad] ✅ PASS: two-way AAD-vault roundtrip over email; only AAD-marked mails decrypt Ok");
    Ok(())
}
