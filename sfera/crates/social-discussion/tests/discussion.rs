use social_discussion::*;
use social_model::Author;
use social_post::{PostAudience, PostV1, SignedPost};
use social_rights::Audience;

const A: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const B: &str = "0200000000000000000000000000000000000000000000000000000000000000";

fn target() -> DiscussionTarget {
    target_post().1
}

fn target_post() -> (SignedPost, DiscussionTarget) {
    let author = Author::from_public_key_hex(&social_model::post::public_key_hex(A).unwrap()).unwrap();
    let post = PostV1::new(author, 10, "post", PostAudience {
        id: "sphere:family".into(), epoch: 2, spec: Audience::AllContacts,
    }, vec![]).unwrap();
    let target = DiscussionTarget {
        post_id: PostRef::from_post(&post).unwrap(), post_author: post.author.fp.clone(),
        audience: post.audience.clone(),
    };
    (social_post::sign_post(A, &post).unwrap(), target)
}

fn comment(id: &str, body: &str) -> SignedComment {
    compose_comment(B, id, target(), None, 20, body, vec![]).unwrap()
}

#[test]
fn attestation_requires_post_owner_and_covers_event() {
    let (post, _) = target_post();
    let signed = comment(&"11".repeat(32), "Подтверждённый");
    let valid = attest_comment(A, signed.clone(), post.clone(), 30).unwrap();
    assert!(verify_comment_attestation(&valid));
    let mut tampered = valid.clone();
    tampered.comment.comment.body = "Подмена".into();
    assert!(!verify_comment_attestation(&tampered));
    let forged = attest_comment(B, signed, post, 30).unwrap();
    assert!(!verify_comment_attestation(&forged), "ключ комментатора не подтверждает чужой пост");
}

#[test]
fn reaction_attestation_uses_its_own_domain() {
    let (post, _) = target_post();
    let reaction = compose_reaction(B, target(), "❤️", 1, false).unwrap();
    let valid = attest_reaction(A, reaction, post, 30).unwrap();
    assert!(verify_reaction_attestation(&valid));
    assert_ne!(publication_id(&DiscussionPayload::ReactionSubmission {
        reaction: valid.reaction.clone(), post: valid.post.clone(),
    }, &valid.reaction.reaction.author.fp).unwrap(),
        publication_id(&DiscussionPayload::ReactionAttestation(valid.clone()),
            &valid.reaction.reaction.author.fp).unwrap());
    let mut wrong_domain = valid;
    wrong_domain.sig = social_model::post::sign_with_domain(
        COMMENT_ATTESTATION_DOMAIN, A,
        &serde_json::json!({"event": wrong_domain.reaction, "post": wrong_domain.post, "ts": 30}),
    ).unwrap();
    assert!(!verify_reaction_attestation(&wrong_domain));
}

#[test]
fn signed_comment_and_reply_are_deterministic() {
    let root = comment(&"11".repeat(32), "Первый");
    assert!(verify_comment(&root));
    let mut book = DiscussionBook::new();
    assert_eq!(book.insert_comment(root.clone()).unwrap(), EventOutcome::Inserted);
    assert_eq!(book.insert_comment(root.clone()).unwrap(), EventOutcome::Duplicate);
    let reply = compose_comment(A, &"22".repeat(32), target(), Some(root.comment.id.clone()), 21, "Ответ", vec![]).unwrap();
    assert_eq!(book.insert_comment(reply).unwrap(), EventOutcome::Inserted);
    let shown = book.comments_for(&target().post_id);
    assert_eq!(shown.len(), 2);
    assert_eq!(shown[0].comment.body, "Первый");
    assert_eq!(shown[1].comment.body, "Ответ");
}

#[test]
fn tampering_and_wrong_domain_are_rejected() {
    let mut evil = comment(&"11".repeat(32), "Текст");
    evil.comment.body = "Подмена".into();
    assert!(!verify_comment(&evil));
    assert_eq!(DiscussionBook::new().insert_comment(evil), Err(DiscussionError::InvalidSignature));
    let reaction = compose_reaction(B, target(), "❤️", 1, false).unwrap();
    let forged = SignedComment {
        comment: comment(&"33".repeat(32), "Не реакция").comment,
        sig: reaction.sig,
    };
    assert!(!verify_comment(&forged));
}

#[test]
fn parent_must_belong_to_the_same_post() {
    let mut book = DiscussionBook::new();
    let parent = comment(&"11".repeat(32), "Родитель");
    let mut child = compose_comment(A, &"22".repeat(32), target(), Some(parent.comment.id.clone()), 21, "Ответ", vec![]).unwrap();
    assert_eq!(book.insert_comment(child.clone()), Err(DiscussionError::UnknownParent));
    book.insert_comment(parent).unwrap();
    child.comment.target.post_id = PostRef::from_post(&PostV1::new(
        child.comment.author.clone(), 1, "other", child.comment.target.audience.clone(), vec![],
    ).unwrap()).unwrap();
    child.sig = social_model::post::sign_with_domain(COMMENT_DOMAIN, A, &child.comment).unwrap();
    assert_eq!(book.insert_comment(child), Err(DiscussionError::UnknownParent));
}

#[test]
fn reused_comment_id_cannot_replace_another_event() {
    let mut book = DiscussionBook::new();
    let first = comment(&"11".repeat(32), "Первый");
    book.insert_comment(first).unwrap();
    let second = comment(&"11".repeat(32), "Другой");
    assert!(book.insert_comment(second).is_err());
}

#[test]
fn empty_comment_and_self_reply_are_rejected() {
    assert_eq!(comment(&"11".repeat(32), "Текст").comment.validate(), Ok(()));
    assert!(compose_comment(B, &"11".repeat(32), target(), None, 20, " ", vec![]).is_err());
    assert!(compose_comment(B, &"11".repeat(32), target(), Some("11".repeat(32)), 20, "self", vec![]).is_err());
}

#[test]
fn reaction_newer_wins_and_tombstone_removes_from_view() {
    let mut book = DiscussionBook::new();
    let first = compose_reaction(B, target(), "❤️", 1, false).unwrap();
    let stale = compose_reaction(B, target(), "❤️", 2, false).unwrap();
    let latest = compose_reaction(B, target(), "❤️", 3, true).unwrap();
    assert_eq!(book.insert_reaction(stale).unwrap(), EventOutcome::Inserted);
    assert_eq!(book.insert_reaction(first.clone()).unwrap(), EventOutcome::Stale);
    assert_eq!(book.reactions_for(&target().post_id).len(), 1);
    assert_eq!(book.insert_reaction(latest.clone()).unwrap(), EventOutcome::Updated);
    assert!(book.reactions_for(&target().post_id).is_empty());
    assert_eq!(book.insert_reaction(latest).unwrap(), EventOutcome::Duplicate);
    assert_eq!(book.snapshot_reactions().len(), 1, "tombstone сохраняется для синхронизации");
}

#[test]
fn invalid_reaction_and_cross_type_signature_fail() {
    assert!(compose_reaction(B, target(), "", 1, false).is_err());
    assert!(compose_reaction(B, target(), "❤️", 0, false).is_err());
    let comment = comment(&"11".repeat(32), "Не подпись реакции");
    let mut reaction = compose_reaction(B, target(), "❤️", 1, false).unwrap();
    reaction.sig = comment.sig;
    assert!(!verify_reaction(&reaction));
}
