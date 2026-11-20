//! Переходы отношения и политика заявок (ADR-006 §4.1).

use social_contacts::{
    can_send_request, transition, ContactAction, ContactBook, ContactError, ContactRecord,
    ContactRequest, RequestPolicy,
};
use social_model::Fingerprint;
use social_rights::{RelationState, Role};

fn fp(byte: u8) -> Fingerprint {
    let mut key = [0u8; 32];
    key[0] = byte;
    Fingerprint::from_public_key_hex(&hex::encode(key)).unwrap()
}

fn approve() -> ContactAction {
    ContactAction::Approve {
        role: Role::Acquaintance,
        spheres: vec!["work".into()],
        history_granted: false,
    }
}

#[test]
fn happy_path_request_approve_remove() {
    let s = transition(RelationState::None, &ContactAction::Request).unwrap();
    assert_eq!(s, RelationState::Requested);
    let s = transition(s, &approve()).unwrap();
    assert_eq!(s, RelationState::Contact);
    let s = transition(s, &ContactAction::Remove).unwrap();
    assert_eq!(s, RelationState::None);
}

#[test]
fn reject_then_reapply_is_allowed() {
    let s = transition(RelationState::Requested, &ContactAction::Reject).unwrap();
    assert_eq!(s, RelationState::Declined);
    let s = transition(s, &ContactAction::Request).unwrap();
    assert_eq!(s, RelationState::Requested);
}

#[test]
fn blocked_ignores_requests_and_requires_explicit_unblock() {
    let s = transition(RelationState::Contact, &ContactAction::Block).unwrap();
    assert_eq!(s, RelationState::Blocked);
    // Заявка от заблокированного ничего не меняет.
    assert_eq!(
        transition(s, &ContactAction::Request).unwrap(),
        RelationState::Blocked
    );
    // Удалением блокировку не снять.
    assert_eq!(
        transition(s, &ContactAction::Remove),
        Err(ContactError::NotBlocked)
    );
    // Только явный Unblock.
    assert_eq!(
        transition(s, &ContactAction::Unblock).unwrap(),
        RelationState::None
    );
}

#[test]
fn approve_or_reject_without_request_fails() {
    for state in [
        RelationState::None,
        RelationState::Contact,
        RelationState::Declined,
        RelationState::Blocked,
    ] {
        assert_eq!(
            transition(state, &approve()),
            Err(ContactError::NoPendingRequest),
            "approve from {state:?}"
        );
        assert_eq!(
            transition(state, &ContactAction::Reject),
            Err(ContactError::NoPendingRequest),
            "reject from {state:?}"
        );
    }
}

#[test]
fn repeated_request_is_idempotent_but_contact_rejects_it() {
    assert_eq!(
        transition(RelationState::Requested, &ContactAction::Request).unwrap(),
        RelationState::Requested
    );
    assert_eq!(
        transition(RelationState::Contact, &ContactAction::Request),
        Err(ContactError::AlreadyContact)
    );
}

#[test]
fn unblock_requires_blocked_state() {
    assert_eq!(
        transition(RelationState::None, &ContactAction::Unblock),
        Err(ContactError::NotBlocked)
    );
}

#[test]
fn self_request_is_rejected() {
    let a = fp(2);
    assert_eq!(
        ContactRequest::new(a.clone(), a, 1, "n", "hi"),
        Err(ContactError::SelfRequest)
    );
}

#[test]
fn request_policy() {
    assert!(can_send_request(RequestPolicy::Everyone, false));
    assert!(!can_send_request(RequestPolicy::LinkOnly, false));
    assert!(can_send_request(RequestPolicy::LinkOnly, true));
    assert!(!can_send_request(RequestPolicy::Nobody, true));
}

#[test]
fn contact_book_tracks_state_and_lists_only_contacts() {
    let a = fp(2);
    let b = fp(3);
    let c = fp(4);
    let mut book = ContactBook::new();

    book.upsert(ContactRecord::contact(
        a.clone(),
        Role::Friend,
        vec!["work".into()],
        false,
    ));
    book.upsert(ContactRecord {
        fp: b.clone(),
        role: Role::Restricted,
        overrides: Default::default(),
        spheres: Vec::new(),
        history_granted: false,
        state: RelationState::Requested,
    });
    book.upsert(ContactRecord::blocked(c.clone()));

    assert_eq!(book.state_of(&a), RelationState::Contact);
    assert_eq!(book.state_of(&b), RelationState::Requested);
    assert_eq!(book.state_of(&c), RelationState::Blocked);
    assert_eq!(book.state_of(&fp(9)), RelationState::None);

    let contacts: Vec<_> = book.contacts().map(|r| r.fp.as_str()).collect();
    assert_eq!(contacts, vec![a.as_str()]);
}

#[test]
fn record_serializes_with_defaults() {
    let r = ContactRecord::contact(fp(2), Role::Friend, vec![], false);
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["role"], "friend");
    assert_eq!(json["state"], "contact");
    // overrides по умолчанию пуст и не ломает разбор.
    let back: ContactRecord = serde_json::from_value(json).unwrap();
    assert_eq!(back, r);
}
