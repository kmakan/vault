//! E2E group chat test: create group + share key → SMTP invite (alice → bob)
//! → bob imports group → alice sends group message → bob decrypts with group key.
//!
//! Requires real Gmail accounts. Credentials come from environment:
//!   VAULT_TEST_ALICE_EMAIL / VAULT_TEST_ALICE_PASS
//!   VAULT_TEST_BOB_EMAIL   / VAULT_TEST_BOB_PASS
//!
//! Run via scripts/run-email-e2e.sh (loads gitignored scripts/.email_test_env).

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::path::PathBuf;
use tempfile::TempDir;
use vault_client::api::email::{EmailClient, EmailConfig};
use vault_client::crypto::encryptor::{DecryptedContent, Encryptor};
use vault_client::vault::GroupManager;

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("env var {name} is not set"))
}

/// Unique subject marker so Bob can find exactly our message.
fn marker() -> String {
    format!(
        "[VAULT-GROUP-E2E] {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    )
}

fn client_for(email: String, password: String) -> EmailClient {
    EmailClient::new(EmailConfig {
        email,
        password,
        ..EmailConfig::default()
    })
}

/// Poll the INBOX for a message whose subject contains `needle` (up to ~90s).
async fn poll_for_message(client: &mut EmailClient, needle: &str) -> Result<String> {
    for attempt in 1..=18u32 {
        let msgs = client.fetch_messages().await.context("IMAP fetch failed")?;

        if let Some(msg) = msgs.iter().find(|m| m.subject.contains(needle)) {
            let body = client
                .fetch_message_body(&msg.id)
                .await
                .context("fetch body failed")?;
            return Ok(body);
        }

        eprintln!(
            "  poll {attempt}/18: '{}' not found yet ({} msgs), sleeping 5s…",
            needle,
            msgs.len()
        );
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }

    bail!("message containing '{needle}' not found in INBOX after 90s")
}

#[tokio::test]
#[ignore = "requires real Gmail app passwords (scripts/run-email-e2e.sh)"]
async fn group_invite_and_message_e2e() -> Result<()> {
    let alice_email = env("VAULT_TEST_ALICE_EMAIL")?;
    let alice_pass = env("VAULT_TEST_ALICE_PASS")?;
    let bob_email = env("VAULT_TEST_BOB_EMAIL")?;
    let bob_pass = env("VAULT_TEST_BOB_PASS")?;

    let uniq = marker();
    let group_name = format!("E2E Group {}", &uniq[uniq.len() - 6..]);

    // ── 1. Alice creates a group (isolated storage, real file untouched) ──
    let alice_dir = TempDir::new().context("tempdir")?;
    let alice_path: PathBuf = alice_dir.path().join("groups.json");
    let mut alice_mgr = GroupManager::with_path(alice_path);
    let group = alice_mgr
        .create_group(&group_name, &alice_email)
        .map_err(|e| anyhow::anyhow!("alice create_group: {e}"))?;
    assert_eq!(group.group_key.len(), 64, "group key is 32 bytes hex");
    eprintln!("✓ Alice created group {} ({})", group.name, group.id);

    // ── 2. Alice invites Bob: add_member + send group key via email ──
    alice_mgr
        .add_member(&group.id, &bob_email)
        .map_err(|e| anyhow::anyhow!("alice add_member: {e}"))?;
    let payload = serde_json::json!({
        "group_id": group.id,
        "group_name": group.name,
        "group_key": group.group_key,
        "sender": alice_email,
    });
    let invite_body = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap().as_bytes());
    let invite_subject = format!("VaultGroupInvite: {}", group.id);
    let alice_client = client_for(alice_email.clone(), alice_pass);
    alice_client
        .send_email(&bob_email, &invite_subject, &invite_body)
        .await
        .context("SMTP invite send failed")?;
    eprintln!("✓ Alice sent group-key invite to Bob");

    // ── 3. Bob fetches the invite, parses it, imports the group ──
    let mut bob_client = client_for(bob_email.clone(), bob_pass);
    bob_client
        .connect_imap()
        .await
        .context("bob IMAP connect")?;

    // Search by the exact group id — previous runs leave invites behind, and a
    // bare "VaultGroupInvite:" match would pick up a stale one.
    let invite_raw =
        poll_for_message(&mut bob_client, &format!("VaultGroupInvite: {}", group.id)).await?;
    // IMAP bodies arrive wrapped at 76 chars (RFC 2045) — strip ALL whitespace
    // before base64-decoding the invite payload.
    let compact: String = invite_raw.chars().filter(|c| !c.is_whitespace()).collect();
    let invite_bytes = URL_SAFE_NO_PAD
        .decode(compact)
        .context("invite b64 decode")?;
    let invite: serde_json::Value =
        serde_json::from_slice(&invite_bytes).context("invite JSON parse")?;
    let gid = invite["group_id"].as_str().context("group_id")?.to_string();
    let gkey = invite["group_key"]
        .as_str()
        .context("group_key")?
        .to_string();
    let gname = invite["group_name"]
        .as_str()
        .context("group_name")?
        .to_string();
    let sender = invite["sender"].as_str().context("sender")?.to_string();
    assert_eq!(gid, group.id, "invite group_id matches");
    assert_eq!(gkey, group.group_key, "invite group_key matches");

    let bob_dir = TempDir::new().context("tempdir")?;
    let bob_path: PathBuf = bob_dir.path().join("groups.json");
    let mut bob_mgr = GroupManager::with_path(bob_path);
    bob_mgr
        .import_group(&gid, &gname, &gkey, &sender)
        .map_err(|e| anyhow::anyhow!("bob import_group: {e}"))?;
    let bob_group = bob_mgr.get_group(&gid).context("bob get_group")?;
    assert_eq!(bob_group.group_key, gkey, "bob stores the group key");
    eprintln!("✓ Bob imported group from invite");

    // ── 4. Alice sends an encrypted group message to all members ──
    let plaintext = "Привет, группа! Это групповое сообщение E2E 123";
    let key_bytes: [u8; 32] = hex::decode(&group.group_key)
        .context("group key hex decode")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("key length"))?;
    let alice_enc = Encryptor::from_key_bytes(&key_bytes);
    let encrypted = alice_enc.encrypt_text(plaintext);
    let msg_subject = format!("VaultGroup: {}", group.id);
    alice_client
        .send_email(&bob_email, &msg_subject, &encrypted)
        .await
        .context("SMTP group msg send failed")?;
    eprintln!("✓ Alice sent encrypted group message to Bob");

    // ── 5. Bob fetches the group message and decrypts with group key ──
    let msg_raw = poll_for_message(&mut bob_client, &format!("VaultGroup: {}", group.id)).await?;
    let bob_enc = Encryptor::from_key_bytes(&key_bytes);
    match bob_enc.decrypt(&msg_raw) {
        Ok(DecryptedContent::Text(text)) => {
            assert_eq!(text, plaintext, "group message decrypted mismatch");
            println!("✅ GROUP E2E PASS: invite → import → group msg → decrypt");
            println!("   group: {} ({})", gname, gid);
            println!("   plaintext: {text}");
        }
        Ok(_) => bail!("expected Text content, got File"),
        Err(e) => bail!("bob could not decrypt group message: {e:#}"),
    }

    Ok(())
}
