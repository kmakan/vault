//! Живая приёмка двух ИЗОЛИРОВАННЫХ экземпляров Sfera.
//! Не подключается к мессенджеру и не читает его профили. Пароли только в env.
//! Запуск: scripts/live-email-discussion.sh (Alice/Bob из scripts/.email_test_env).

use std::{path::{Path, PathBuf}, sync::Arc, time::{SystemTime, UNIX_EPOCH}};
use sfera_app::live_test_support::{imap::{ImapConfig, receive_once}, smtp::{SmtpConfig, SmtpDelivery}};
use sfera_app::imap;
use social_app::{Identity, Role, SferaApp};
use social_ffi::SferaState;
use social_link::LinkedContact;
use social_post::PostAudience;
use social_rights::Audience;
use social_sync::{Quota, RetryPolicy};
use storage_local::LocalStore;

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() }
fn env(name: &str) -> String { std::env::var(name).unwrap_or_else(|_| panic!("missing {name}")) }
fn fp(seed: &str) -> social_model::Fingerprint {
    social_model::Fingerprint::from_public_key_hex(&social_model::post::public_key_hex(seed).unwrap()).unwrap()
}
fn contact(seed: &str, keys: &social_keys::EncryptionIdentity, address: String) -> LinkedContact {
    LinkedContact { fp: fp(seed), pub_key: social_model::post::public_key_hex(seed).unwrap(),
        label: String::new(), x25519_pub: keys.x25519_public_hex().into(),
        pq_ek: keys.pq_ek_b64().into(), address }
}
fn state(seed: &str, root: &Path, email: String) -> (SferaState, social_keys::EncryptionIdentity) {
    let keys_dir = root.join("keys");
    let keys = social_keys::load_or_create_at(root, [seed.as_bytes()[0]; 32]).unwrap();
    social_keys::save_at(&keys_dir, &keys).unwrap();
    let mut app = SferaApp::new(Identity::from_seed(seed).unwrap(),
        Arc::new(LocalStore::new(root.join("blobs")).unwrap()),
        RetryPolicy::default(), Quota::new(3600, 20_000_000, 100, now()));
    app.set_encryption_identity(keys.sender_material());
    app.set_own_encryption_public(keys.x25519_public_hex().into(), keys.pq_ek_b64().into());
    app.set_own_delivery(email.clone());
    let delivery = Arc::new(SmtpDelivery::new(SmtpConfig {
        email: email.clone(), password: env("SFERA_LIVE_PASSWORD"),
        server: env("SFERA_LIVE_SMTP_SERVER"),
        port: env("SFERA_LIVE_SMTP_PORT").parse().unwrap(), allow_insecure: false,
    }));
    (SferaState::new(app, Some(delivery)).with_keys_dir(keys_dir), keys)
}
fn setup(state: &SferaState, seed: &str, role: Role, peer: LinkedContact) {
    state.call(|app| {
        app.put_contact(social_contacts::ContactRecord::contact(fp(seed), role, vec![], true));
        app.set_link_contacts(vec![peer]);
        Ok::<(), social_ffi::CommandError>(())
    }).unwrap();
}
fn send(state: &SferaState, required: usize) {
    let report = state.sync_outbox(now()).unwrap();
    assert_eq!(report.rejected, 0, "SMTP rejected: {report:?}");
    assert!(report.inserted >= required, "expected {required} SMTP deliveries: {report:?}");
    println!("SMTP accepted {} envelope(s)", report.inserted);
}
fn receive(state: &SferaState, root: &Path) -> imap::ReceiveReport {
    receive_once(&ImapConfig {
        email: env("SFERA_LIVE_EMAIL"), password: env("SFERA_LIVE_PASSWORD"),
        server: env("SFERA_LIVE_IMAP_SERVER"),
        port: env("SFERA_LIVE_IMAP_PORT").parse().unwrap(), allow_insecure: false,
    }, root, state).unwrap()
}
fn wait_for(state: &SferaState, root: &Path, expected: &str) {
    for attempt in 1..=6 {
        let report = receive(state, root);
        let found = state.call(|app| Ok(app.discussion().snapshot_comments().iter().any(|item| item.comment.body == expected))).unwrap();
        println!("IMAP attempt {attempt}: candidates={}, accepted={}, rejected={}, comments={}, event={found}",
            report.candidates, report.accepted, report.rejected, report.comments);
        if std::env::var_os("SFERA_LIVE_STARTED").is_none() {
            assert_eq!(report.rejected, 0, "конверт отклонён транспортным приёмником");
        }
        if found {
            assert_eq!(report.comments, 1, "одно уведомление о новом комментарии");
            assert_eq!(report.reactions, 0);
            return;
        }
        if attempt < 6 { std::thread::sleep(std::time::Duration::from_secs(10)); }
    }
    panic!("подтверждённое событие не получено через живой IMAP");
}
fn main() {
    let root = PathBuf::from(env("SFERA_LIVE_ROOT"));
    assert!(root.starts_with(std::env::var("HOME").map(PathBuf::from).unwrap().join(".hermes/cache/scratch")),
        "live state only in scratch");
    let a = "0100000000000000000000000000000000000000000000000000000000000001";
    let b = "0200000000000000000000000000000000000000000000000000000000000002";
    let phase = env("SFERA_LIVE_PHASE");
    let email = env("SFERA_LIVE_EMAIL");
    let (state, keys) = state(if phase == "owner" || phase == "owner-receive" { a } else { b }, &root, email.clone());
    let other_email = env("SFERA_LIVE_PEER_EMAIL");
    if phase == "commenter" {
        std::fs::write(root.join("peer.link.json"), serde_json::to_vec(&contact(b, &keys, email.clone())).unwrap()).unwrap();
    }
    if phase == "owner" {
        let other = contact(b, &social_keys::EncryptionIdentity::generate([0x22; 32]).unwrap(), other_email);
        setup(&state, b, Role::Friend, other);
        let post = state.call(|app| Ok(app.publish_post(now(), "Sfera live discussion", PostAudience {
            id: "live-test".into(), epoch: 1, spec: Audience::AllContacts,
        }, vec![], now())?)).unwrap();
        std::fs::write(root.join("post.json"), serde_json::to_vec(&post).unwrap()).unwrap();
        std::fs::write(root.join("author.link.json"), serde_json::to_vec(&contact(a, &keys, email)).unwrap()).unwrap();
        state.call(|app| { app.receive_posts([post], now()); Ok::<(), social_ffi::CommandError>(()) }).unwrap();
        println!("owner: fixture prepared; waiting for encrypted submission");
    } else if phase == "commenter" {
        let post: social_post::SignedPost = serde_json::from_slice(&std::fs::read(env("SFERA_LIVE_POST")).unwrap()).unwrap();
        let author: LinkedContact = serde_json::from_slice(&std::fs::read(env("SFERA_LIVE_AUTHOR")).unwrap()).unwrap();
        setup(&state, a, Role::Friend, author);
        state.call(|app| { app.receive_posts([post.clone()], now()); Ok::<(), social_ffi::CommandError>(()) }).unwrap();
        let id = social_app::PostId::from_post(&post.post).unwrap();
        let _comment = state.call(|app| Ok(app.comment_on_post(&id, None, now(), "Sfera live comment", vec![], now())?)).unwrap();
        send(&state, 1);
        println!("commenter: encrypted submission sent to post owner");
    } else if phase == "owner-receive" {
        state.call(|app| {
            let other: LinkedContact = serde_json::from_slice(&std::fs::read(env("SFERA_LIVE_PEER_LINK")).unwrap()).unwrap();
            app.put_contact(social_contacts::ContactRecord::contact(fp(b), Role::Friend, vec![], true));
            app.set_link_contacts(vec![other]);
            let post: social_post::SignedPost = serde_json::from_slice(&std::fs::read(root.join("post.json")).unwrap()).unwrap();
            let report = app.receive_posts([post], now());
            assert_eq!(report.rejected, 0);
            assert_eq!(report.inserted + report.duplicates, 1);
            Ok::<(), social_ffi::CommandError>(())
        }).unwrap();
        wait_for(&state, &root, "Sfera live comment");
        send(&state, 1);
        println!("owner: submission accepted, attestation sealed and sent");
    } else if phase == "commenter-receive" {
        state.call(|app| {
            let author: LinkedContact = serde_json::from_slice(&std::fs::read(env("SFERA_LIVE_AUTHOR")).unwrap()).unwrap();
            app.set_link_contacts(vec![author]);
            let post: social_post::SignedPost = serde_json::from_slice(&std::fs::read(env("SFERA_LIVE_POST")).unwrap()).unwrap();
            app.receive_posts([post], now());
            Ok::<(), social_ffi::CommandError>(())
        }).unwrap();
        wait_for(&state, &root, "Sfera live comment");
        println!("PASS: real SMTP/IMAP owner attestation reached the second independent instance");
    } else { panic!("unknown phase"); }
}
