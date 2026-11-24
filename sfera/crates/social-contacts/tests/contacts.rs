//! Переходы отношения и политика заявок (ADR-006 §4.1).

use social_contacts::{
    can_send_request, transition, ContactAction, ContactBook, ContactError, ContactRecord,
    ContactRequest, RequestPolicy, RequestOutcome,
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
        address: String::new(),
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
fn set_role_changes_only_role_of_accepted_contact() {
    let a = fp(2);
    let mut book = ContactBook::new();
    let mut record = ContactRecord::contact(a.clone(), Role::Friend, vec!["work".into()], true);
    record.overrides.can_react = Some(true);
    book.upsert(record);

    book.set_role(&a, Role::Restricted).unwrap();
    let after = book.get(&a).unwrap();
    assert_eq!(after.role, Role::Restricted);
    // Остальное решение владельца не затирается сменой роли.
    assert_eq!(after.state, RelationState::Contact);
    assert_eq!(after.spheres, vec!["work"]);
    assert!(after.history_granted);
    assert_eq!(after.overrides.can_react, Some(true));
}

#[test]
fn set_role_rejects_missing_and_non_contact_records() {
    let mut book = ContactBook::new();
    assert_eq!(book.set_role(&fp(2), Role::Close), Err(ContactError::NotContact));

    book.upsert(ContactRecord {
        fp: fp(3),
        role: Role::Friend,
        overrides: Default::default(),
        spheres: Vec::new(),
        history_granted: false,
        state: RelationState::Requested,
        address: String::new(),
    });
    assert_eq!(book.set_role(&fp(3), Role::Close), Err(ContactError::NotContact));
    assert_eq!(book.get(&fp(3)).unwrap().role, Role::Friend);
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

// ── Идемпотентность заявок по (from, to, nonce), ADR-006 §7.5 ──────────────

#[test]
fn same_nonce_is_duplicate_and_does_not_change_state() {
    let mut book = ContactBook::new();
    let req = ContactRequest::new(fp(1), fp(2), 100, "n-1", "привет").unwrap();

    assert_eq!(book.accept_request(&req).unwrap(), RequestOutcome::Accepted);
    assert_eq!(book.state_of(&fp(1)), RelationState::Requested);

    // Повторная доставка того же письма — Duplicate, состояние не меняется.
    assert_eq!(book.accept_request(&req).unwrap(), RequestOutcome::Duplicate);
    assert_eq!(book.state_of(&fp(1)), RelationState::Requested);
}

#[test]
fn different_nonce_is_new_request() {
    let mut book = ContactBook::new();
    let a = ContactRequest::new(fp(1), fp(2), 100, "n-1", "раз").unwrap();
    let b = ContactRequest::new(fp(1), fp(2), 200, "n-2", "два").unwrap();
    assert_eq!(book.accept_request(&a).unwrap(), RequestOutcome::Accepted);
    assert_eq!(book.accept_request(&b).unwrap(), RequestOutcome::Accepted);
}

#[test]
fn blocked_sender_nonce_is_recorded_but_state_stays_blocked() {
    let mut book = ContactBook::new();
    let mut rec = ContactRecord::blocked(fp(1));
    rec.state = RelationState::Blocked;
    book.upsert(rec);

    let req = ContactRequest::new(fp(1), fp(2), 100, "n-b", "спам").unwrap();
    assert_eq!(book.accept_request(&req).unwrap(), RequestOutcome::Accepted);
    assert_eq!(book.state_of(&fp(1)), RelationState::Blocked);
    // Nonce записан: второй раз то же письмо — Duplicate.
    assert_eq!(book.accept_request(&req).unwrap(), RequestOutcome::Duplicate);
}

#[test]
fn mark_nonce_prevents_double_grant() {
    let mut book = ContactBook::new();
    assert!(book.mark_nonce(&fp(1), &fp(2), "grant-1"));
    assert!(!book.mark_nonce(&fp(1), &fp(2), "grant-1"), "повторная выдача запрещена");
    assert!(book.nonce_seen(&fp(1), &fp(2), "grant-1"));
    assert!(!book.nonce_seen(&fp(1), &fp(2), "grant-2"));
}

#[test]
fn request_address_is_carried_into_record() {
    // Адрес из заявки — единственный способ узнать, куда доставлять конверты
    // этому контакту. Если он теряется, отправка профиля невозможна.
    let mut book = ContactBook::new();
    let req = ContactRequest::new(fp(1), fp(2), 100, "n-addr", "привет")
        .unwrap()
        .with_address("anna@example.org");
    assert_eq!(book.accept_request(&req).unwrap(), RequestOutcome::Accepted);
    assert_eq!(book.get(&fp(1)).unwrap().address, "anna@example.org");
}

#[test]
fn empty_request_address_does_not_erase_known_one() {
    // Повторная заявка без адреса не должна обнулять уже известный адрес:
    // иначе одна старая форма ломает доставку.
    let mut book = ContactBook::new();
    let with_addr = ContactRequest::new(fp(1), fp(2), 100, "n-1", "привет")
        .unwrap()
        .with_address("anna@example.org");
    book.accept_request(&with_addr).unwrap();

    let without = ContactRequest::new(fp(1), fp(2), 101, "n-2", "ещё раз").unwrap();
    book.accept_request(&without).unwrap();
    assert_eq!(book.get(&fp(1)).unwrap().address, "anna@example.org");
}
