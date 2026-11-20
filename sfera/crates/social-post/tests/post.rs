//! Пост: подпись тем же доменом, что simple-post; любая правка ломает
//! проверку; форма (аудитория/медиа) валидируется отдельно от подписи.

use social_model::Fingerprint;
use social_post::{
    canonical_post, compose, sign_post, verify_post, MediaRef, PostAudience, PostError, PostV1,
    SignedPost, POST_KIND,
};
use social_rights::Audience;
use storage_api::BlobId;

const SEED_A: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const SEED_B: &str = "0200000000000000000000000000000000000000000000000000000000000000";
const TS: u64 = 1795000000;

fn audience() -> PostAudience {
    PostAudience {
        id: "aud_work".into(),
        epoch: 3,
        spec: Audience::Sphere { id: "work".into() },
    }
}

fn media() -> Vec<MediaRef> {
    vec![MediaRef {
        blob_id: BlobId::from_bytes([0x11; 32]),
        thumb_blob_id: Some(BlobId::from_bytes([0x22; 32])),
        mime: "image/jpeg".into(),
        size: 12_345,
    }]
}

fn signed() -> SignedPost {
    compose(SEED_A, TS, "привет", audience(), media()).unwrap()
}

#[test]
fn composed_post_verifies() {
    let s = signed();
    assert_eq!(s.post.kind, POST_KIND);
    assert_eq!(s.post.v, 1);
    assert!(verify_post(&s));
}

#[test]
fn any_field_edit_breaks_the_signature() {
    let base = signed();

    let mut body = base.clone();
    body.post.body.push('!');
    assert!(!verify_post(&body));

    let mut ts = base.clone();
    ts.post.ts += 1;
    assert!(!verify_post(&ts));

    let mut epoch = base.clone();
    epoch.post.audience.epoch += 1;
    assert!(!verify_post(&epoch));

    let mut media = base.clone();
    media.post.media[0].blob_id = BlobId::from_bytes([0x99; 32]);
    assert!(!verify_post(&media));

    let mut thumb = base.clone();
    thumb.post.media[0].thumb_blob_id = None;
    assert!(!verify_post(&thumb));
}

#[test]
fn signing_with_another_key_is_rejected() {
    let base = signed();
    // Подпись чужим ключом поверх поста автора A.
    let forged = sign_post(SEED_B, &base.post).unwrap();
    assert!(!verify_post(&forged));
}

#[test]
fn mismatched_author_fingerprint_is_rejected() {
    let mut evil = signed();
    evil.post.author.fp = Fingerprint::from_public_key_hex(
        "0200000000000000000000000000000000000000000000000000000000000000",
    )
    .unwrap();
    assert!(!verify_post(&evil));
}

#[test]
fn semantic_validation_is_separate_from_signature() {
    let base = signed().post;

    let mut p = base.clone();
    p.v = 2;
    assert_eq!(p.validate(), Err(PostError::InvalidVersion(2)));

    let mut p = base.clone();
    p.kind = "social_reaction".into();
    assert_eq!(p.validate(), Err(PostError::InvalidKind("social_reaction".into())));

    let mut p = base.clone();
    p.audience.id = "  ".into();
    assert_eq!(p.validate(), Err(PostError::EmptyAudienceId));

    let mut p = base.clone();
    p.audience.epoch = 0;
    assert_eq!(p.validate(), Err(PostError::InvalidEpoch));

    let mut p = base.clone();
    p.media[0].mime = "".into();
    assert_eq!(p.validate(), Err(PostError::EmptyMime));

    let mut p = base.clone();
    p.media[0].size = 0;
    assert_eq!(p.validate(), Err(PostError::EmptyMedia));
}

#[test]
fn media_only_post_is_allowed() {
    let s = compose(SEED_A, TS, "", audience(), media()).unwrap();
    assert!(verify_post(&s));
}

#[test]
fn signed_post_roundtrips_through_json() {
    let s = signed();
    let json = serde_json::to_string(&s).unwrap();
    let back: SignedPost = serde_json::from_str(&json).unwrap();
    assert_eq!(back, s);
    assert!(verify_post(&back));
}

#[test]
fn canonical_form_is_stable_and_contains_audience_and_media() {
    let a = canonical_post(&signed().post).unwrap();
    let b = canonical_post(&signed().post).unwrap();
    assert_eq!(a, b);
    let text = String::from_utf8(a).unwrap();
    assert!(text.contains("\"aud_work\""));
    assert!(text.contains("\"sphere\""));
    assert!(text.contains("\"image/jpeg\""));
}

#[test]
fn post_can_be_built_manually_then_signed() {
    let pub_key = social_model::post::public_key_hex(SEED_A).unwrap();
    let author = social_model::Author::from_public_key_hex(&pub_key).unwrap();
    let post = PostV1::new(author, TS, "руками", audience(), vec![]).unwrap();
    let signed = sign_post(SEED_A, &post).unwrap();
    assert!(verify_post(&signed));
}
