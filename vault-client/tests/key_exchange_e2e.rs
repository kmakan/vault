//! E2E two-way key-exchange test over real email (demo scenario).
//!
//! 1. Alice generates an X25519 keypair and invites Bob via a self-contained link.
//! 2. Bob accepts the invite, derives the shared secret, and replies with his own invite.
//! 3. Alice accepts Bob's reply so both sides hold the peer's public key.
//! 4. Alice encrypts a message and sends it -> SMTP -> IMAP -> Bob decrypts.
//! 5. Bob encrypts a reply and sends it -> SMTP -> IMAP -> Alice decrypts.
//!
//! Requires real Gmail accounts. Credentials come from environment:
//!   VAULT_TEST_ALICE_EMAIL / VAULT_TEST_ALICE_PASS
//!   VAULT_TEST_BOB_EMAIL   / VAULT_TEST_BOB_PASS
//!
//! Run via scripts/run-email-e2e.sh (loads gitignored scripts/.email_test_env).

use anyhow::{bail, Context, Result};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use vault_client::api::email::{EmailClient, EmailConfig};
use vault_client::crypto::CryptoClient;
use vault_client::vault::contacts::{Contact, ContactBook};
use vault_client::vault::invite::Invite;

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("env var {name} is not set"))
}

/// Unique subject marker (SystemTime nanos) so Bob/Alice can find our messages.
fn unique_subject() -> String {
    format!(
        "[VAULT-KE] {}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

#[tokio::test]
#[ignore = "requires real Gmail app passwords (scripts/run-email-e2e.sh)"]
async fn key_exchange_via_invite_email_e2e() -> Result<()> {
    let alice_email = env("VAULT_TEST_ALICE_EMAIL")?;
    let alice_pass = env("VAULT_TEST_ALICE_PASS")?;
    let bob_email = env("VAULT_TEST_BOB_EMAIL")?;
    let bob_pass = env("VAULT_TEST_BOB_PASS")?;

    // -- 1. Alice: keypair + invite -> Bob -----------------------------------
    let mut alice_crypto = CryptoClient::new();
    let (alice_pub, _alice_priv) = alice_crypto.generate_keypair();
    let alice_invite = Invite::new(&alice_email, &bob_email, &alice_pub, 24);
    let link = alice_invite.to_link();
    println!("✓ Alice: keypair generated, invite link created (24h, self-contained)");

    // -- 2. Bob: accepts Alice's invite, adds contact, derives shared secret --
    let mut bob_crypto = CryptoClient::new();
    let (bob_pub, _bob_priv) = bob_crypto.generate_keypair();
    let (id, sender, key) =
        Invite::from_link(&link).context("Bob could not parse Alice's invite link")?;
    assert_eq!(sender, alice_email, "invite sender should be Alice's email");
    assert_eq!(key, alice_pub, "invite key should be Alice's public key");
    let mut bob_contacts = ContactBook::new();
    bob_contacts.add(Contact::new(&sender, "Alice", &key));
    bob_crypto
        .set_peer_key(&alice_pub)
        .context("Bob could not derive shared secret from Alice's key")?;
    println!("✓ Bob: accepted invite id={id}, sender={sender} → Alice added to contacts, DH shared secret derived");

    // -- 3. Bob: reply invite -> Alice (two-way exchange) --------------------
    let bob_invite = Invite::new(&bob_email, &alice_email, &bob_pub, 24);
    let reply_link = bob_invite.to_link();
    println!("✓ Bob: reply invite created (24h)");

    // -- 4. Alice: accepts Bob's reply, adds Bob as a contact ---------------
    let (reply_id, reply_sender, reply_key) =
        Invite::from_link(&reply_link).context("Alice could not parse Bob's reply")?;
    assert_eq!(
        reply_sender, bob_email,
        "reply sender should be Bob's email"
    );
    assert_eq!(reply_key, bob_pub, "reply key should be Bob's public key");
    let mut alice_contacts = ContactBook::new();
    alice_contacts.add(Contact::new(&reply_sender, "Bob", &reply_key));
    alice_crypto
        .set_peer_key(&bob_pub)
        .context("Alice could not derive shared secret from Bob's key")?;
    assert!(
        bob_contacts.contains(&alice_email),
        "Bob should have Alice as contact"
    );
    assert!(
        alice_contacts.contains(&bob_email),
        "Alice should have Bob as contact"
    );
    println!("✓ Alice: accepted reply id={reply_id} → Bob added to contacts, DH shared secret derived (two-way)");

    // -- 5. Alice: encrypt & send A->B over email ---------------------------
    let alice_sender = EmailClient::new(EmailConfig {
        email: alice_email.clone(),
        password: alice_pass.clone(),
        ..EmailConfig::default()
    });
    let plaintext_ab = "Привет Боб! E2E keys: 42";
    let subject_ab = unique_subject();
    let encrypted_ab = alice_crypto.encrypt(plaintext_ab);
    alice_sender
        .send_email(&bob_email, &subject_ab, &encrypted_ab)
        .await
        .context("SMTP alice→bob failed")?;
    println!("✓ Alice → Bob: encrypted email sent, subject={subject_ab}");

    // -- 6. Bob: poll IMAP, decrypt A->B ------------------------------------
    let mut bob_client = EmailClient::new(EmailConfig {
        email: bob_email.clone(),
        password: bob_pass,
        ..EmailConfig::default()
    });
    bob_client
        .connect_imap()
        .await
        .context("IMAP connect (bob) failed")?;
    let (uid_ab, body_ab) = poll_for_message(&mut bob_client, &subject_ab).await?;
    let decrypted_ab = bob_crypto
        .decrypt(&body_ab)
        .context("Bob could not decrypt A→B message")?;
    assert_eq!(decrypted_ab, plaintext_ab, "A→B plaintext mismatch");
    println!("✓ Bob: decrypted A→B message: {decrypted_ab}");
    bob_client
        .mark_as_read(&uid_ab)
        .await
        .context("mark Bob A→B message as read failed")?;

    // -- 7. Bob: encrypt & send B->A over email -----------------------------
    let plaintext_ba = "Привет Алиса! E2E keys roundtrip";
    let subject_ba = unique_subject();
    let encrypted_ba = bob_crypto.encrypt(plaintext_ba);
    bob_client
        .send_email(&alice_email, &subject_ba, &encrypted_ba)
        .await
        .context("SMTP bob→alice failed")?;
    println!("✓ Bob → Alice: encrypted email sent, subject={subject_ba}");

    // -- 8. Alice: poll IMAP, decrypt B->A ----------------------------------
    let mut alice_client = EmailClient::new(EmailConfig {
        email: alice_email.clone(),
        password: alice_pass,
        ..EmailConfig::default()
    });
    alice_client
        .connect_imap()
        .await
        .context("IMAP connect (alice) failed")?;
    let (uid_ba, body_ba) = poll_for_message(&mut alice_client, &subject_ba).await?;
    let decrypted_ba = alice_crypto
        .decrypt(&body_ba)
        .context("Alice could not decrypt B→A message")?;
    assert_eq!(decrypted_ba, plaintext_ba, "B→A plaintext mismatch");
    println!("✓ Alice: decrypted B→A message: {decrypted_ba}");
    alice_client
        .mark_as_read(&uid_ba)
        .await
        .context("mark Alice B→A message as read failed")?;

    bob_client.disconnect();
    alice_client.disconnect();

    println!("✅ KEY-EXCHANGE E2E PASS: two-way X25519 key exchange + E2E messages over email, both directions decrypted");
    Ok(())
}

/// Poll the INBOX (then the junk folder as fallback) for a message with the
/// given subject. Gmail's spam filter sometimes routes test mail away from
/// INBOX; delivery is still successful, so the test treats Junk hits as OK.
/// Returns (uid, body) — uid is needed for mark_as_read.
async fn poll_for_message(client: &mut EmailClient, subject: &str) -> Result<(String, String)> {
    for attempt in 1..=12u32 {
        let msgs = client.fetch_messages().await.context("IMAP fetch failed")?;

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
