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

fn app() -> SferaApp {
    let dir = tempfile::tempdir().unwrap();
    SferaApp::new(
        Identity::from_seed(A).unwrap(),
        Arc::new(LocalStore::new(dir.path()).unwrap()),
        RetryPolicy::default(), Quota::new(60, 100_000, 100, 0),
    )
}

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
    assert_eq!(app.outbox().len(), 2);
    let reaction = app.react_to_post(&id, "👍", false, 31).unwrap();
    assert_eq!(reaction.reaction.target, target(&post));
    assert_eq!(app.discussion().reactions_for(&target(&post).post_id).len(), 1);
    assert!(app.comment_on_post(&PostId::from_post(&post.post).unwrap(), Some(comment.comment.id.clone()), 32, "Ветка", vec![], 32).is_ok());
}

#[test]
fn unknown_post_is_not_replaced_by_another_target() {
    let mut app = app();
    let (_, post) = post(&mut app);
    let comment = compose_comment(B, &"11".repeat(32), target(&post), None, 20, "Нет поста", vec![]).unwrap();
    let unknown = "00".repeat(32).parse().unwrap();
    assert!(matches!(app.receive_comment(&unknown, comment), Err(_)));
}
