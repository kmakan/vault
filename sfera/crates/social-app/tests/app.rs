//! Композиционный корень: фичи не импортируют друг друга, но корень их связывает.

use std::io::Cursor;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use social_app::{AppError, Identity, SferaApp};
use social_audience::AudienceKeys;
use social_contacts::ContactRecord;
use social_feed::PostId;
use social_model::Fingerprint;
use social_post::PostAudience;
use social_rights::{Audience, DenyReason, RelationState, Role, RoleOverrides};
use social_sync::{Quota, QuotaError, RetryPolicy};
use storage_api::{BlobId, Locator};
use storage_local::LocalStore;

const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const SEED2: &str = "0200000000000000000000000000000000000000000000000000000000000000";

fn app(quota: Quota, dir: &std::path::Path) -> SferaApp {
    let store = LocalStore::new(dir).unwrap();
    SferaApp::new(
        Identity::from_seed(SEED).unwrap(),
        Arc::new(store),
        RetryPolicy::default(),
        quota,
    )
}

fn audience(id: &str) -> PostAudience {
    PostAudience {
        id: id.into(),
        epoch: 1,
        spec: Audience::AllContacts,
    }
}

#[test]
fn identity_debug_redacts_seed() {
    let identity = Identity::from_seed(SEED).unwrap();
    let debug = format!("{identity:?}");
    assert!(!debug.contains(SEED));
    assert!(debug.contains("<redacted>"));
}

#[test]
fn published_post_goes_to_outbox_then_into_feed() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(Quota::new(60, 10_000, 10, 0), dir.path());

    let post = app
        .publish_post(100, "привет", audience("aud_all"), vec![], 50)
        .unwrap();
    assert_eq!(app.outbox().len(), 1, "пост поставлен в очередь");
    assert_eq!(app.outbox().pending_count(), 1);
    assert!(app.feed().is_empty(), "публикация НЕ вставляет в ленту сама");

    let report = app.receive_posts(vec![post.clone()], 101);
    assert_eq!(report.inserted, 1);
    assert_eq!(app.feed().len(), 1);
    let id = PostId::from_post(&post.post).unwrap();
    assert!(app.feed().contains(&id));
    assert!(app.mark_read(&id));
    assert!(!app.mark_read(&id), "повтор не меняет read-state");
}

#[test]
fn incoming_posts_are_deduped_and_invalid_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(Quota::new(60, 10_000, 10, 0), dir.path());
    let good = app
        .publish_post(100, "первый", audience("aud_all"), vec![], 0)
        .unwrap();
    let mut evil = app
        .publish_post(101, "второй", audience("aud_all"), vec![], 0)
        .unwrap();
    evil.post.body = "подмена".into();

    let report = app.receive_posts(vec![good.clone(), good, evil], 200);
    assert_eq!(report.inserted, 1);
    assert_eq!(report.duplicates, 1);
    assert_eq!(report.rejected, 1, "подписанный конверт с правкой отвергнут");
}

#[test]
fn profile_publication_goes_through_outbox_and_book() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(Quota::new(60, 10_000, 10, 0), dir.path());

    let outcome = app
        .set_my_profile(100, "Аня", "био", None, vec![], 10)
        .unwrap();
    assert_eq!(outcome, social_profile::UpsertOutcome::Inserted);
    assert_eq!(app.outbox().len(), 1);
    let me = app.identity().fingerprint().clone();
    let mine = app.profile_of(&me).unwrap().clone();
    assert_eq!(mine.profile.display_name, "Аня");

    let stale = social_profile::compose(
        SEED,
        50,
        "Старое имя",
        "",
        None,
        vec![],
    )
    .unwrap();
    assert_eq!(
        app.receive_profile(stale).unwrap(),
        social_profile::UpsertOutcome::Stale,
        "старый профиль не откатывает новый"
    );
    assert_eq!(app.profile_of(&me).unwrap().profile.display_name, "Аня");
}

#[test]
fn access_combines_contact_state_and_rights_without_js() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(Quota::new(60, 10_000, 10, 0), dir.path());
    let viewer = Fingerprint::from_public_key_hex(&social_model::post::public_key_hex(SEED2).unwrap())
        .unwrap();

    // Нет контакта — доступа нет, даже при включении в аудиторию.
    assert!(app.access(&viewer, &Audience::AllContacts, &[]).is_none());

    let mut record = ContactRecord::contact(viewer.clone(), Role::Restricted, vec![], false);
    app.put_contact(record.clone());
    let access = app.access(&viewer, &Audience::AllContacts, &[]).unwrap();
    assert!(access.delivered);
    assert!(!access.can_view_media(), "ограниченный не получает ключ медиа");

    record.role = Role::Close;
    record.overrides = RoleOverrides::default();
    app.put_contact(record);
    assert!(app.access(&viewer, &Audience::AllContacts, &[]).unwrap().can_view_media());

    app.put_contact(ContactRecord::blocked(viewer.clone()));
    let blocked = app.access(&viewer, &Audience::AllContacts, &[]).unwrap();
    assert!(!blocked.delivered);
    assert_eq!(blocked.deny, Some(DenyReason::Blocked));

    // Права считает social-rights: проверка статуса отношения — из contacts.
    assert_eq!(app.contacts().state_of(&viewer), RelationState::Blocked);
}

#[test]
fn audience_membership_rotation_is_delegated() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(Quota::new(60, 10_000, 10, 0), dir.path());
    let me = app.identity().fingerprint().clone();
    let other =
        Fingerprint::from_public_key_hex(&social_model::post::public_key_hex(SEED2).unwrap())
            .unwrap();

    app.put_audience(AudienceKeys::new("aud_work", vec![me.clone()]));
    let epoch = app.audience("aud_work").unwrap().epoch();
    let key_before = *app.audience("aud_work").unwrap().current_key();

    assert_eq!(
        app.set_audience_members("aud_work", vec![me.clone(), other.clone()])
            .unwrap(),
        social_audience::MembershipChange::Changed
    );
    let keys = app.audience("aud_work").unwrap();
    assert_eq!(keys.epoch(), epoch + 1);
    assert_ne!(keys.current_key(), &key_before, "ключ свежий, не выводимый из старого");
    assert!(keys.is_member(&other));
    assert_eq!(
        app.set_audience_members("aud_work", vec![me, other]).unwrap(),
        social_audience::MembershipChange::Unchanged
    );
}

#[test]
fn quota_failure_does_not_publish_half_post() {
    let dir = tempfile::tempdir().unwrap();
    // Квота на 1 отправку: второй пост не должен ни попасть в очередь, ни
    // вернуться как «опубликованный».
    let mut app = app(Quota::new(60, 10_000, 1, 0), dir.path());
    assert!(app.publish_post(1, "первый", audience("aud_all"), vec![], 0).is_ok());
    assert!(matches!(
        app.publish_post(2, "второй", audience("aud_all"), vec![], 0),
        Err(AppError::Quota(QuotaError::ItemsExceeded { .. }))
    ));
    assert_eq!(app.outbox().len(), 1);
}

#[test]
fn outbox_drain_is_transport_agnostic() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(Quota::new(60, 10_000, 10, 0), dir.path());
    let a = app
        .publish_post(1, "a", audience("aud_all"), vec![], 0)
        .unwrap();
    app.publish_post(2, "b", audience("aud_all"), vec![], 0).unwrap();
    let ids: Vec<_> = app.outbox().due(0).iter().map(|i| i.id.clone()).collect();
    let first = ids[0].clone();

    // Замыкание-адаптер: отправляем только первый, второй уходит в ретрай.
    let report = app.sync_outbox(0, |item| item.id == first);
    assert_eq!(report.sent, 1);
    assert_eq!(report.retried, 1);
    assert_eq!(app.outbox().pending_count(), 1);
    let sent = app.outbox().get(&first).unwrap();
    assert_eq!(sent.state, social_sync::OutboxState::Sent);
    assert_eq!(sent.attempts, 0, "отправленный элемент без неудачных попыток");
    let retried = app.outbox().get(&PostId::from_post(&a.post).unwrap().to_hex()).unwrap();
    assert_eq!(retried.attempts, if retried.id == first { 0 } else { 1 });
}

#[tokio::test]
async fn storage_port_is_wired_and_conformant() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    storage_conformance::run(&store).await.expect("conformance");

    let app = app(Quota::new(60, 10_000, 10, 0), dir.path());
    assert_eq!(app.store().caps().kind, storage_api::StoreKind::Local);
}

#[tokio::test]
async fn media_roundtrips_through_the_wired_storage_port() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(Quota::new(60, 10_000, 10, 0), dir.path());

    let plaintext = "привет из Sfera".as_bytes().repeat(8);
    let key = [0x42; 32];
    let nonce = [0x11; 16];
    let encrypted = social_media::encrypt_blob(&plaintext, &key, &nonce, 16).unwrap();
    // По ADR §5.1 blob_id = SHA-256(шифротекст), а заголовок (71 байт) —
    // метаданные конверта; провайдер видит только шифротекст.
    let (header, ciphertext) = encrypted.bytes.split_at(social_media::HEADER_LEN);
    let header = header.to_vec();
    let loc: Locator = app
        .store()
        .put(
            &encrypted.blob_id,
            Box::new(Cursor::new(ciphertext.to_vec())),
            ciphertext.len() as u64,
        )
        .await
        .unwrap();
    assert_eq!(
        loc.blob_id,
        BlobId::from_bytes(Sha256::digest(ciphertext).into())
    );

    let mut reader = app.store().get(&loc, None).await.unwrap();
    use tokio::io::AsyncReadExt;
    let mut downloaded = header;
    reader.read_to_end(&mut downloaded).await.unwrap();
    assert_eq!(
        social_media::decrypt_blob(&downloaded, &key).unwrap(),
        plaintext
    );
}
