use social_app::{Identity, SferaApp};
use social_contacts::ContactRecord;
use social_discussion::{
    compose_comment, compose_reaction, DiscussionError, DiscussionTarget, EventOutcome, PostRef,
};
use social_feed::PostId;
use social_post::{PostAudience, SignedPost};
use social_rights::{Audience, Role};
use social_sync::{Quota, RetryPolicy};
use storage_local::LocalStore;
use std::sync::Arc;

const A: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const B: &str = "0200000000000000000000000000000000000000000000000000000000000000";
const OUTSIDER: &str = "0300000000000000000000000000000000000000000000000000000000000000";

fn app_with_seed(seed: &str) -> SferaApp {
    let dir = tempfile::tempdir().unwrap();
    SferaApp::new(
        Identity::from_seed(seed).unwrap(),
        Arc::new(LocalStore::new(dir.path()).unwrap()),
        RetryPolicy::default(), Quota::new(60, 100_000, 100, 0),
    )
}
fn app() -> SferaApp { app_with_seed(A) }

fn post(app: &mut SferaApp) -> (PostId, SignedPost) {
    let post = app.publish_post(10, "Пост", PostAudience {
        id: "family".into(), epoch: 1, spec: Audience::AllContacts,
    }, vec![], 10).unwrap();
    app.receive_posts([post.clone()], 10);
    (PostId::from_post(&post.post).unwrap(), post)
}

fn target(post: &SignedPost) -> DiscussionTarget {
    DiscussionTarget {
        post_id: PostRef::from_post(&post.post).unwrap(),
        post_author: post.post.author.fp.clone(), audience: post.post.audience.clone(),
    }
}

fn add_contact(app: &mut SferaApp, seed: &str, role: Role) {
    let fp = social_model::Fingerprint::from_public_key_hex(&social_model::post::public_key_hex(seed).unwrap()).unwrap();
    app.put_contact(ContactRecord::contact(fp, role, vec![], true));
}

#[test]
fn contacts_can_discuss_but_outsider_and_restricted_cannot() {
    let mut app = app();
    let (id, post) = post(&mut app);
    let target = target(&post);
    let outsider = compose_comment(OUTSIDER, &"11".repeat(32), target.clone(), None, 20, "Чужой", vec![]).unwrap();
    assert!(matches!(app.receive_comment(&id, outsider), Err(social_app::AppError::Discussion(DiscussionError::NotInAudience))));
    assert!(app.discussion().comments_for(&target.post_id).is_empty());

    add_contact(&mut app, B, Role::Restricted);
    let restricted = compose_comment(B, &"22".repeat(32), target.clone(), None, 21, "Нельзя", vec![]).unwrap();
    assert!(matches!(app.receive_comment(&id, restricted), Err(social_app::AppError::Discussion(DiscussionError::ParticipationDenied))));
    assert!(app.discussion().comments_for(&target.post_id).is_empty());

    add_contact(&mut app, B, Role::Friend);
    let allowed = compose_comment(B, &"33".repeat(32), target.clone(), None, 22, "Вижу и отвечаю", vec![]).unwrap();
    assert_eq!(app.receive_comment(&id, allowed).unwrap(), EventOutcome::Inserted);
    assert_eq!(app.discussion().comments_for(&target.post_id).len(), 1);

    let reaction = compose_reaction(B, target.clone(), "❤️", 1, false).unwrap();
    assert_eq!(app.receive_reaction(&id, reaction).unwrap(), EventOutcome::Inserted);
    assert_eq!(app.discussion().reactions_for(&target.post_id).len(), 1);
}

#[test]
fn own_comment_and_reaction_use_the_actual_post_audience() {
    let mut app = app();
    let (id, post) = post(&mut app);
    let comment = app.comment_on_post(&id, None, 30, "Свой ответ", vec![], 30).unwrap();
    assert_eq!(comment.comment.target, target(&post));
    assert_eq!(app.outbox().len(), 1, "очередь содержит только пост, SMTP self-copy нет");
    let reaction = app.react_to_post(&id, "👍", false, 31).unwrap();
    assert_eq!(reaction.reaction.target, target(&post));
    assert_eq!(app.discussion().reactions_for(&target(&post).post_id).len(), 1);
    assert!(app.comment_on_post(&PostId::from_post(&post.post).unwrap(), Some(comment.comment.id.clone()), 32, "Ветка", vec![], 32).is_ok());
}

#[test]
fn author_attestation_reaches_audience_unknown_to_commenter() {
    let mut owner = app_with_seed(A);
    let mut commenter = app_with_seed(B);
    let mut viewer = app_with_seed(OUTSIDER);
    let owner_keys = social_keys::EncryptionIdentity::generate([11; 32]).unwrap();
    let commenter_keys = social_keys::EncryptionIdentity::generate([22; 32]).unwrap();
    let viewer_keys = social_keys::EncryptionIdentity::generate([33; 32]).unwrap();
    for (app, keys, address) in [(&mut owner, &owner_keys, "owner@example.test"), (&mut commenter, &commenter_keys, "commenter@example.test"), (&mut viewer, &viewer_keys, "viewer@example.test")] {
        app.set_encryption_identity(keys.sender_material());
        app.set_own_delivery(address.into());
        app.set_own_encryption_public(keys.x25519_public_hex().into(), keys.pq_ek_b64().into());
    }
    fn link(seed: &str, keys: &social_keys::EncryptionIdentity, address: &str) -> social_link::LinkedContact {
        social_link::LinkedContact {
            fp: social_model::Fingerprint::from_public_key_hex(&social_model::post::public_key_hex(seed).unwrap()).unwrap(),
            pub_key: social_model::post::public_key_hex(seed).unwrap(), label: String::new(),
            x25519_pub: keys.x25519_public_hex().into(), pq_ek: keys.pq_ek_b64().into(), address: address.into(),
        }
    }
    add_contact(&mut owner, B, Role::Friend);
    add_contact(&mut owner, OUTSIDER, Role::Friend);
    // Ключи привязываются после создания записей: неизвестный fingerprint
    // намеренно не попадает в адресную книгу доставки.
    owner.set_link_contacts(vec![
        link(B, &commenter_keys, "commenter@example.test"),
        link(OUTSIDER, &viewer_keys, "viewer@example.test"),
    ]);
    // У комментатора есть владелец поста, но нет viewer: полную аудиторию
    // знает только владелец, и это проверяется сценарием, а не комментарием.
    add_contact(&mut commenter, A, Role::Friend);
    add_contact(&mut viewer, A, Role::Friend);
    let (_, signed_post) = post(&mut owner);
    commenter.receive_posts([signed_post.clone()], 11);
    viewer.receive_posts([signed_post.clone()], 11);
    let id = PostId::from_post(&signed_post.post).unwrap();
    commenter.set_link_contacts(vec![link(A, &owner_keys, "owner@example.test")]);
    assert!(commenter.feed().get(&id).is_some(), "пост должен попасть в ленту комментатора");
    assert_eq!(commenter.contacts().contacts().count(), 1);
    let comment = commenter.comment_on_post(&id, None, 20, "Подтверждённый комментарий", vec![], 20).unwrap();
    assert_eq!(commenter.outbox().len(), 1);
    let submission = commenter.outbox().due(20)[0];
    assert_eq!(submission.to.as_deref(), Some("owner@example.test"));
    assert!(!submission.envelope.as_deref().unwrap().contains("Подтверждённый комментарий"));
    let envelope: social_delivery::SealedEnvelope = serde_json::from_str(submission.envelope.as_deref().unwrap()).unwrap();
    assert_eq!(owner.receive_discussion_envelope(&envelope, owner_keys.x25519_private_hex(), owner_keys.pq_seed_hex()).unwrap(), EventOutcome::Inserted);
    assert_eq!(owner.discussion().comments_for(&target(&signed_post).post_id).len(), 1);
    owner.set_link_contacts(vec![
        link(B, &commenter_keys, "commenter@example.test"),
        link(OUTSIDER, &viewer_keys, "viewer@example.test"),
    ]);
    // Конверты уже выпущены владельцем: третий участник открывает свой,
    // хотя его книга не содержит автора комментария.
    assert_eq!(owner.outbox().pending_count(), 5, "пост и по два конверта каждому участнику");
    let fanout = owner.outbox().due(20).into_iter()
        .filter(|item| item.to.is_some())
        .collect::<Vec<_>>();
    assert_eq!(fanout.len(), 4);
    let fanout = fanout.into_iter()
        .find_map(|item| {
            if item.to.as_deref() != Some("viewer@example.test") { return None; }
            let envelope: social_delivery::SealedEnvelope = serde_json::from_str(item.envelope.as_deref()?).ok()?;
            let plaintext = social_delivery::open_payload(&envelope, viewer_keys.x25519_private_hex(), &envelope.from_x25519, viewer_keys.pq_seed_hex()).ok()?;
            let payload = social_discussion::parse_envelope_json(&plaintext).ok()?;
            matches!(payload, social_discussion::DiscussionPayload::CommentAttestation(_)).then_some(envelope)
        }).expect("attestation for the viewer");
    let attested: social_delivery::SealedEnvelope = fanout;
    let plaintext = social_delivery::open_payload(&attested, viewer_keys.x25519_private_hex(), &attested.from_x25519, viewer_keys.pq_seed_hex()).unwrap();
    let payload = social_discussion::parse_envelope_json(&plaintext).unwrap();
    assert_eq!(viewer.receive_discussion_payload(payload, 21).unwrap(), EventOutcome::Inserted);
    assert_eq!(viewer.discussion().comments_for(&target(&signed_post).post_id)[0].comment.id, comment.comment.id);
    let direct = social_discussion::DiscussionPayload::SocialComment(comment.clone());
    assert!(viewer.receive_discussion_payload(direct, 22).is_err(), "неподтверждённая самоподпись не выдаёт себе доступ");

    // Владелец выдаёт адресный материал B только внутри исходной аудитории.
    let delegated = owner.outbox().due(20).into_iter().find_map(|item| {
        let envelope: social_delivery::SealedEnvelope = serde_json::from_str(item.envelope.as_deref()?).ok()?;
        let plaintext = social_delivery::open_payload(&envelope, viewer_keys.x25519_private_hex(), &envelope.from_x25519, viewer_keys.pq_seed_hex()).ok()?;
        match social_discussion::parse_envelope_json(&plaintext).ok()? {
            social_discussion::DiscussionPayload::PeerDelegate(delegated) => Some(delegated),
            _ => None,
        }
    }).expect("owner delegates the commenter address to the viewer");
    assert_eq!(viewer.receive_discussion_payload(
        social_discussion::DiscussionPayload::PeerDelegate(delegated), 23,
    ).unwrap(), EventOutcome::Updated);
    let reply = viewer.comment_on_post(&id, Some(comment.comment.id.clone()), 24, "Ответ участнику", vec![], 24).unwrap();
    assert_eq!(reply.comment.parent_id.as_deref(), Some(comment.comment.id.as_str()));
    let addressed = viewer.outbox().due(24).into_iter()
        .find(|item| item.to.as_deref() == Some("owner@example.test"))
        .expect("reply is submitted to the original post owner");
    let envelope: social_delivery::SealedEnvelope = serde_json::from_str(addressed.envelope.as_deref().unwrap()).unwrap();
    assert_eq!(owner.receive_discussion_envelope(
        &envelope, owner_keys.x25519_private_hex(), owner_keys.pq_seed_hex(),
    ).unwrap(), EventOutcome::Inserted);
    let fanout = owner.outbox().due(24).into_iter().find_map(|item| {
        if item.to.as_deref() != Some("commenter@example.test") { return None; }
        let envelope: social_delivery::SealedEnvelope = serde_json::from_str(item.envelope.as_deref()?).ok()?;
        let plaintext = social_delivery::open_payload(&envelope, commenter_keys.x25519_private_hex(), &envelope.from_x25519, commenter_keys.pq_seed_hex()).ok()?;
        match social_discussion::parse_envelope_json(&plaintext).ok()? {
            social_discussion::DiscussionPayload::CommentAttestation(attested)
                if attested.comment.comment.id == reply.comment.id => Some(envelope),
            _ => None,
        }
    }).expect("owner attests the reply to the original commenter");
    assert_eq!(commenter.receive_discussion_envelope(
        &fanout, commenter_keys.x25519_private_hex(), commenter_keys.pq_seed_hex(),
    ).unwrap(), EventOutcome::Inserted);
    assert_eq!(commenter.discussion().comments_for(&target(&signed_post).post_id).len(), 2);
}

#[test]
fn peer_delegate_rejects_wrong_domain_and_does_not_leak_to_outsider() {
    let mut owner = app_with_seed(A);
    let owner_keys = social_keys::EncryptionIdentity::generate([11; 32]).unwrap();
    owner.set_encryption_identity(owner_keys.sender_material());
    owner.set_own_delivery("owner@example.test".into());
    owner.set_own_encryption_public(owner_keys.x25519_public_hex().into(), owner_keys.pq_ek_b64().into());
    let (_, signed_post) = post(&mut owner);
    let actor = social_model::Author::from_public_key_hex(&social_model::post::public_key_hex(B).unwrap()).unwrap();
    let keys = social_keys::EncryptionIdentity::generate([22; 32]).unwrap();
    let material = social_delivery::RecipientKeyMaterial {
        fp: actor.fp.clone(), x25519_public_hex: keys.x25519_public_hex().into(),
        pq_ek_b64: keys.pq_ek_b64().into(), address: "commenter@example.test".into(),
    };
    let mut delegated = social_discussion::delegate_peer(A, signed_post, actor, material, 30, owner.own_delivery_material().unwrap()).unwrap();
    assert!(social_discussion::verify_peer_delegate(&delegated));
    delegated.sig = social_model::post::sign_with_domain(
        social_discussion::COMMENT_ATTESTATION_DOMAIN, A,
        &social_discussion::PeerDelegate { sig: String::new(), ..delegated.clone() },
    ).unwrap();
    assert!(!social_discussion::verify_peer_delegate(&delegated));
}

#[test]
fn foreign_comment_without_author_material_is_not_marked_sent() {
    let mut commenter = app_with_seed(B);
    let (_, signed_post) = post(&mut app_with_seed(A));
    commenter.receive_posts([signed_post.clone()], 11);
    add_contact(&mut commenter, A, Role::Friend);
    commenter.set_encryption_identity(social_keys::EncryptionIdentity::generate([22; 32]).unwrap().sender_material());
    let id = PostId::from_post(&signed_post.post).unwrap();
    assert!(commenter.comment_on_post(&id, None, 20, "Не отправлено", vec![], 20).is_err());
    assert!(commenter.discussion().comments_for(&target(&signed_post).post_id).is_empty());
    assert_eq!(commenter.outbox().len(), 0);
}
#[test]
fn unknown_post_is_not_replaced_by_another_target() {
    let mut app = app();
    let (_, post) = post(&mut app);
    let comment = compose_comment(B, &"11".repeat(32), target(&post), None, 20, "Нет поста", vec![]).unwrap();
    let unknown = "00".repeat(32).parse().unwrap();
    assert!(matches!(app.receive_comment(&unknown, comment), Err(_)));
}
