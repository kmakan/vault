//! Контрактная фикстура: один и тот же JSON читается Rust и JS.
//! Если форма отпечатка или канонического JSON разойдётся между ядром и
//! фронтом — подпись поста перестанет проверяться на одной из сторон.

use serde_json::Value;
use social_model::{canonical::canonical_string, Author, Fingerprint};

const FIXTURE: &str = include_str!("fixtures/author-contract.json");

#[test]
fn fingerprint_contract_matches_fixture() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    let pub_key = fixture["author"]["pub_key"].as_str().unwrap();
    let expected = fixture["author"]["fp"].as_str().unwrap();

    let author = Author::from_public_key_hex(pub_key).expect("fixture pub_key is valid");
    assert_eq!(author.fp.as_str(), expected);
    assert_eq!(author.fp, Fingerprint::from_str(expected));
}

#[test]
fn canonical_post_matches_fixture() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    let post = &fixture["post"];
    let expected = fixture["canonical_post"].as_str().unwrap();

    let actual = canonical_string(post).expect("post is serializable");
    assert_eq!(actual, expected);
}

#[test]
fn author_serializes_to_fingerprint_string() {
    // fp в JSON — строка, не объект и не email.
    let fp = Fingerprint::from_str("02:00:00:00:00:00:00:00:****");
    let json = serde_json::to_string(&fp).unwrap();
    assert_eq!(json, r#""02:00:00:00:00:00:00:00:****""#);
    assert!(!json.contains('@'));
}
