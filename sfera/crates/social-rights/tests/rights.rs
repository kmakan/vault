//! Матрица доступа: роль → права, аудитория → доставка, отношение → гейт.

use social_model::Fingerprint;
use social_rights::{
    evaluate, permissions, Audience, DenyReason, ProfileView, RelationState, Role, RoleOverrides,
};

fn fp(byte: u8) -> Fingerprint {
    let mut key = [0u8; 32];
    key[0] = byte;
    Fingerprint::from_public_key_hex(&hex::encode(key)).unwrap()
}

#[test]
fn role_presets_match_the_table() {
    let close = Role::Close.preset();
    assert!(close.can_view_media && close.can_react && close.can_view_history);
    assert_eq!(close.profile, ProfileView::Full);

    let friend = Role::Friend.preset();
    assert!(friend.can_view_media && friend.can_react);
    assert!(!friend.can_view_history, "история у Друга — по настройке, дефолт выкл");

    let acquaintance = Role::Acquaintance.preset();
    assert!(acquaintance.can_view_media);
    assert!(!acquaintance.can_react && !acquaintance.can_view_history);
    assert_eq!(acquaintance.profile, ProfileView::Brief);

    let restricted = Role::Restricted.preset();
    assert!(!restricted.can_view_media, "Ограниченный не получает ключи медиа");
    assert_eq!(restricted.profile, ProfileView::None);
}

#[test]
fn overrides_apply_on_top_of_preset() {
    let o = RoleOverrides {
        can_view_media: Some(false),
        can_react: Some(true),
        can_view_history: Some(true),
        can_request_chat: None,
        profile: Some(ProfileView::Brief),
    };
    let p = permissions(Role::Close, &o);
    assert!(!p.can_view_media);
    assert!(p.can_react);
    assert!(p.can_view_history);
    assert!(p.can_request_chat, "не переопределено — остаётся пресет");
    assert_eq!(p.profile, ProfileView::Brief);
}

#[test]
fn audience_membership() {
    let a = fp(2);
    let b = fp(3);
    assert!(Audience::AllContacts.contains(&a, &[]));
    assert!(Audience::Sphere { id: "work".into() }.contains(&a, &["work".into()]));
    assert!(!Audience::Sphere { id: "work".into() }.contains(&a, &["family".into()]));
    assert!(Audience::Selected { fps: vec![a.clone()] }.contains(&a, &[]));
    assert!(!Audience::Selected { fps: vec![b.clone()] }.contains(&a, &[]));
    assert!(Audience::AllExcept { fps: vec![b] }.contains(&a, &[]));
    assert!(!Audience::AllExcept { fps: vec![a.clone()] }.contains(&a, &[]));
    assert!(Audience::Public.contains(&Fingerprint::from_str(""), &[]));
}

#[test]
fn public_audience_is_read_only_and_needs_no_contact() {
    let a = fp(2);
    let access = evaluate(
        &a,
        RelationState::None,
        Role::Restricted,
        &RoleOverrides::default(),
        &Audience::Public,
        &[],
    );
    assert!(access.delivered, "публичный пост виден без контакта");
    assert!(access.can_view_media(), "публичное медиа открыто");
    assert!(access.can_view_history(), "публичная история открыта");
    assert!(!access.can_react(), "публичность не даёт реакций");
    assert!(!access.permissions.can_request_chat);
    assert!(access.deny.is_none());
}

#[test]
fn blocked_stays_denied_even_for_public_audience() {
    let a = fp(2);
    let access = evaluate(
        &a,
        RelationState::Blocked,
        Role::Close,
        &RoleOverrides::default(),
        &Audience::Public,
        &[],
    );
    assert!(!access.delivered);
    assert_eq!(access.deny, Some(DenyReason::Blocked));
}

#[test]
fn empty_fingerprint_is_never_in_a_selected_audience() {
    let empty = Fingerprint::from_str("");
    let list = Audience::Selected {
        fps: vec![Fingerprint::from_str("")],
    };
    assert!(!list.contains(&empty, &[]));
    // В списке ИСКЛЮЧЕНИЙ пустой fp никого не исключает (`same` не срабатывает),
    // поэтому AllExcept остаётся «всем» — это корректно, а не дыра.
    assert!(Audience::AllExcept {
        fps: vec![Fingerprint::from_str("")]
    }
    .contains(&empty, &[]));
}

#[test]
fn blocked_is_denied_even_for_close_audience() {
    let a = fp(2);
    let access = evaluate(
        &a,
        RelationState::Blocked,
        Role::Close,
        &RoleOverrides::default(),
        &Audience::AllContacts,
        &[],
    );
    assert!(!access.delivered);
    assert_eq!(access.deny, Some(DenyReason::Blocked));
    assert!(!access.can_view_media());
}

#[test]
fn non_contact_states_are_denied() {
    let a = fp(2);
    for (rel, reason) in [
        (RelationState::None, DenyReason::NotAContact),
        (RelationState::Requested, DenyReason::PendingRequest),
        (RelationState::Declined, DenyReason::Declined),
    ] {
        let access = evaluate(
            &a,
            rel,
            Role::Close,
            &RoleOverrides::default(),
            &Audience::AllContacts,
            &[],
        );
        assert!(!access.delivered, "{rel:?} must not deliver");
        assert_eq!(access.deny, Some(reason));
    }
}

#[test]
fn contact_gets_post_but_restricted_gets_no_media() {
    let a = fp(2);
    let access = evaluate(
        &a,
        RelationState::Contact,
        Role::Restricted,
        &RoleOverrides::default(),
        &Audience::AllContacts,
        &[],
    );
    assert!(access.delivered, "текст поста доставляется");
    assert!(!access.can_view_media(), "ключи медиа не выдаются");
    assert!(access.deny.is_none());
}

#[test]
fn contact_outside_audience_is_not_delivered() {
    let a = fp(2);
    let access = evaluate(
        &a,
        RelationState::Contact,
        Role::Close,
        &RoleOverrides::default(),
        &Audience::AllExcept { fps: vec![a.clone()] },
        &[],
    );
    assert!(!access.delivered);
    assert_eq!(access.deny, Some(DenyReason::NotInAudience));

    let not_member = evaluate(
        &a,
        RelationState::Contact,
        Role::Close,
        &RoleOverrides::default(),
        &Audience::Sphere { id: "work".into() },
        &["family".into()],
    );
    assert_eq!(not_member.deny, Some(DenyReason::NotInAudience));
}

#[test]
fn audience_serializes_with_kind_tag() {
    let json = serde_json::to_value(Audience::Sphere { id: "work".into() }).unwrap();
    assert_eq!(json["kind"], "sphere");
    assert_eq!(json["id"], "work");

    let json = serde_json::to_value(Audience::AllContacts).unwrap();
    assert_eq!(json["kind"], "all_contacts");

    let json = serde_json::to_value(Audience::AllExcept { fps: vec![fp(2)] }).unwrap();
    assert_eq!(json["kind"], "all_except");
    assert!(json["fps"].is_array());
}
