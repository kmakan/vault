//! Эпохи аудитории: ротация только на реальное изменение, свежий ключ,
//! история старых эпох для чтения, ключи не светятся в Debug.

use social_audience::{AudienceKeys, AudienceRestoreError, MembershipChange};
use social_model::Fingerprint;

fn fp(byte: u8) -> Fingerprint {
    let mut key = [0u8; 32];
    key[0] = byte;
    Fingerprint::from_public_key_hex(&hex::encode(key)).unwrap()
}

fn keys() -> AudienceKeys {
    AudienceKeys::new("sph_work", vec![fp(2), fp(3)])
}

#[test]
fn new_audience_starts_at_epoch_one() {
    let a = keys();
    assert_eq!(a.epoch(), 1);
    assert_eq!(a.key_for(1), Some(a.current_key()));
    assert_eq!(a.members().count(), 2);
    assert!(a.is_member(&fp(2)));
    assert!(!a.is_member(&fp(4)));
}

#[test]
fn adding_existing_member_does_not_rotate() {
    let mut a = keys();
    let before = *a.current_key();
    assert_eq!(a.add_member(&fp(2)), MembershipChange::Unchanged);
    assert_eq!(a.epoch(), 1);
    assert_eq!(*a.current_key(), before);
}

#[test]
fn adding_new_member_rotates_with_a_fresh_key() {
    let mut a = keys();
    let epoch1 = *a.current_key();
    assert_eq!(a.add_member(&fp(4)), MembershipChange::Changed);

    assert_eq!(a.epoch(), 2);
    assert_ne!(*a.current_key(), epoch1, "ключ обязан смениться");
    // Старый ключ сохраняется только для чтения прошлых постов.
    assert_eq!(a.key_for(1), Some(&epoch1));
    assert_eq!(a.key_for(2), Some(a.current_key()));
    assert!(a.is_member(&fp(4)));
}

#[test]
fn removing_member_rotates_so_the_leaver_gets_no_new_posts() {
    let mut a = keys();
    let epoch1 = *a.current_key();
    assert_eq!(a.remove_member(&fp(2)), MembershipChange::Changed);

    assert_eq!(a.epoch(), 2);
    assert_ne!(*a.current_key(), epoch1);
    assert!(!a.is_member(&fp(2)));
    // Ушедший знает ключ эпохи 1 — он остаётся в истории, но не равен новому.
    assert_eq!(a.key_for(1), Some(&epoch1));
}

#[test]
fn removing_non_member_does_not_rotate() {
    let mut a = keys();
    let before = *a.current_key();
    assert_eq!(a.remove_member(&fp(9)), MembershipChange::Unchanged);
    assert_eq!(a.epoch(), 1);
    assert_eq!(*a.current_key(), before);
}

#[test]
fn history_keeps_every_epoch() {
    let mut a = keys();
    a.add_member(&fp(4));
    a.remove_member(&fp(3));
    assert_eq!(a.epoch(), 3);
    for epoch in 1..=3 {
        assert!(a.key_for(epoch).is_some(), "epoch {epoch} must be kept");
    }
    assert!(a.key_for(4).is_none());
}

#[test]
fn two_audiences_with_same_members_have_different_keys() {
    let a = AudienceKeys::new("sph_a", vec![fp(2), fp(3)]);
    let b = AudienceKeys::new("sph_b", vec![fp(2), fp(3)]);
    assert_ne!(a.current_key(), b.current_key(), "ключ не выводится из состава");
}

#[test]
fn apply_membership_is_order_independent_and_rotates_only_on_change() {
    let mut a = keys();
    let before = *a.current_key();
    assert_eq!(
        a.apply_membership(vec![fp(3), fp(2)]),
        MembershipChange::Unchanged
    );
    assert_eq!(*a.current_key(), before);

    assert_eq!(
        a.apply_membership(vec![fp(2), fp(3), fp(4)]),
        MembershipChange::Changed
    );
    assert_eq!(a.epoch(), 2);
    assert!(a.is_member(&fp(4)));
}

#[test]
fn debug_does_not_leak_key_material() {
    let a = keys();
    let rendered = format!("{a:?}");
    assert!(rendered.contains("<redacted>"));
    assert!(!rendered.contains(&hex::encode(a.current_key())));
}

#[test]
fn snapshot_roundtrip_keeps_epochs_members_and_history() {
    let mut a = keys();
    a.add_member(&fp(4));
    a.remove_member(&fp(3));

    let snapshot = a.snapshot_for_storage();
    let restored = AudienceKeys::restore(snapshot.clone()).expect("снимок валиден");
    assert_eq!(restored.epoch(), a.epoch());
    assert_eq!(restored.current_key(), a.current_key());
    assert_eq!(
        restored.members().collect::<Vec<_>>(),
        a.members().collect::<Vec<_>>()
    );
    for epoch in 1..=a.epoch() {
        assert_eq!(restored.key_for(epoch), a.key_for(epoch));
    }
    assert!(!format!("{snapshot:?}").contains(&hex::encode(a.current_key())));
}

#[test]
fn restore_rejects_broken_snapshot() {
    let mut zero = keys().snapshot_for_storage();
    zero.epoch = 0;
    assert_eq!(
        AudienceKeys::restore(zero).unwrap_err(),
        AudienceRestoreError::BadEpoch
    );

    let mut mismatched = keys().snapshot_for_storage();
    mismatched.current = [9u8; 32];
    assert_eq!(
        AudienceKeys::restore(mismatched).unwrap_err(),
        AudienceRestoreError::MissingCurrent
    );

    let mut future = keys().snapshot_for_storage();
    future.history.push((future.epoch + 1, [7u8; 32]));
    assert_eq!(
        AudienceKeys::restore(future).unwrap_err(),
        AudienceRestoreError::FutureHistory
    );
}
