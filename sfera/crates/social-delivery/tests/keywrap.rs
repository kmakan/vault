//! Обёртка ключа аудитории: участник получает текущий ключ, не-участник —
//! отказ, удалённый не получает новый даже при попытке.

use rand::rngs::OsRng;
use social_audience::AudienceKeys;
use social_delivery::{
    unwrap_audience_key, wrap_audience_key, DeliveryError, RecipientKeyMaterial,
    SenderKeyMaterial,
};
use social_model::Fingerprint;
use vault_core::crypto_pq::pq_generate;
use x25519_dalek::{PublicKey, StaticSecret};

struct User {
    x_priv: String,
    x_pub: String,
    pq_seed: String,
    pq_ek: String,
    fp: Fingerprint,
}

fn user() -> User {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    let pq = pq_generate();
    let fp = Fingerprint::from_public_key_hex(&hex::encode(public.as_bytes())).unwrap();
    User {
        x_priv: hex::encode(secret.to_bytes()),
        x_pub: hex::encode(public.as_bytes()),
        pq_seed: pq.seed_hex,
        pq_ek: pq.ek_b64,
        fp,
    }
}

fn recipient(u: &User) -> RecipientKeyMaterial {
    RecipientKeyMaterial {
        fp: u.fp.clone(),
        x25519_public_hex: u.x_pub.clone(),
        pq_ek_b64: u.pq_ek.clone(),
    }
}

fn sender(u: &User) -> SenderKeyMaterial {
    SenderKeyMaterial {
        x25519_private_hex: u.x_priv.clone(),
        pq_seed_hex: Some(u.pq_seed.clone()),
    }
}

#[test]
fn member_receives_the_current_key() {
    let alice = user();
    let bob = user();
    let keys = AudienceKeys::new("sph_work", vec![alice.fp.clone(), bob.fp.clone()]);

    let wrapped = wrap_audience_key(&keys, &sender(&alice), &recipient(&bob)).unwrap();
    assert_eq!(wrapped.epoch, keys.epoch());
    assert_eq!(wrapped.audience_id, "sph_work");

    let got = unwrap_audience_key(&wrapped, &bob.x_priv, &alice.x_pub, &bob.pq_seed).unwrap();
    assert_eq!(&got, keys.current_key());
}

#[test]
fn non_member_is_refused() {
    let alice = user();
    let bob = user();
    let charlie = user();
    let keys = AudienceKeys::new("sph_work", vec![alice.fp.clone(), bob.fp.clone()]);

    assert!(matches!(
        wrap_audience_key(&keys, &sender(&alice), &recipient(&charlie)),
        Err(DeliveryError::NotAMember)
    ));
}

#[test]
fn removed_member_cannot_get_the_new_key() {
    let alice = user();
    let bob = user();
    let mut keys = AudienceKeys::new("sph_work", vec![alice.fp.clone(), bob.fp.clone()]);
    let epoch1 = *keys.current_key();

    // До удаления Bob законно получил ключ эпохи 1.
    let old_wrap = wrap_audience_key(&keys, &sender(&alice), &recipient(&bob)).unwrap();
    let old_key = unwrap_audience_key(&old_wrap, &bob.x_priv, &alice.x_pub, &bob.pq_seed).unwrap();
    assert_eq!(old_key, epoch1);

    // Удаление ротирует ключ.
    keys.remove_member(&bob.fp);
    let epoch2 = *keys.current_key();
    assert_ne!(epoch1, epoch2);

    // Попытка выдать Bob'у новый ключ — отказ, он уже не участник.
    assert!(matches!(
        wrap_audience_key(&keys, &sender(&alice), &recipient(&bob)),
        Err(DeliveryError::NotAMember)
    ));

    // Оставшийся участник получает именно НОВЫЙ ключ.
    let new_wrap = wrap_audience_key(&keys, &sender(&alice), &recipient(&alice)).unwrap();
    let new_key =
        unwrap_audience_key(&new_wrap, &alice.x_priv, &alice.x_pub, &alice.pq_seed).unwrap();
    assert_eq!(new_key, epoch2);
    assert_ne!(new_key, old_key);
}

#[test]
fn tampered_wire_is_rejected() {
    let alice = user();
    let bob = user();
    let keys = AudienceKeys::new("sph_work", vec![alice.fp.clone(), bob.fp.clone()]);
    let mut wrapped = wrap_audience_key(&keys, &sender(&alice), &recipient(&bob)).unwrap();

    // Портим base64-полезную нагрузку, сохраняя длину.
    let mut chars: Vec<char> = wrapped.wire.chars().collect();
    let pos = chars.len() / 2;
    chars[pos] = if chars[pos] == 'A' { 'B' } else { 'A' };
    wrapped.wire = chars.into_iter().collect();

    assert!(unwrap_audience_key(&wrapped, &bob.x_priv, &alice.x_pub, &bob.pq_seed).is_err());
}

#[test]
fn sender_debug_redacts_private_material() {
    let alice = user();
    let material = sender(&alice);
    let rendered = format!("{material:?}");
    assert!(rendered.contains("<redacted>"));
    assert!(!rendered.contains(&alice.x_priv));
    assert!(!rendered.contains(&alice.pq_seed));
}
