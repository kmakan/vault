//! Контракт богатого поста: Rust и JS согласны по JCS и подписи, включая
//! аудиторию и медиа. Фикстура зафиксирована в tests/fixtures.

use social_post::{canonical_post, verify_post, PostV1, SignedPost};

fn fixture() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/post-contract.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn signed() -> SignedPost {
    let fx = fixture();
    let post: PostV1 = serde_json::from_value(fx["post"].clone()).unwrap();
    let sig = fx["sig_hex"].as_str().unwrap().to_string();
    SignedPost { post, sig }
}

#[test]
fn fixture_canonical_matches_rust() {
    let fx = fixture();
    let expected = fx["canonical_post"].as_str().unwrap();
    let got = String::from_utf8(canonical_post(&signed().post).unwrap()).unwrap();
    assert_eq!(got, expected);
}

#[test]
fn fixture_signature_verifies_in_rust() {
    assert!(verify_post(&signed()));
}

#[test]
fn tampered_fixture_body_is_rejected() {
    let mut s = signed();
    s.post.body.push('!');
    assert!(!verify_post(&s));
}

#[test]
fn fixture_audience_and_media_are_present() {
    let s = signed();
    assert_eq!(s.post.audience.epoch, 3);
    assert_eq!(s.post.media.len(), 1);
    assert_eq!(s.post.media[0].mime, "image/jpeg");
    assert!(s.post.media[0].thumb_blob_id.is_some());
}
