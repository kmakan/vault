//! Контрактная фикстура: один и тот же JSON читается Rust и JS.
//! Если форма отпечатка или канонического JSON разойдётся между ядром и
//! фронтом — подпись поста перестанет проверяться на одной из сторон.

use serde_json::Value;
use social_model::{
    canonical::canonical_string,
    post::{public_key_hex, sign, verify, PostPayload},
    Author, Fingerprint,
};

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
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    let fp = Fingerprint::from_str(fixture["author"]["fp"].as_str().unwrap());
    let json = serde_json::to_string(&fp).unwrap();
    assert_eq!(json, format!("\"{}\"", fp.as_str()));
    assert!(!json.contains('@'));
}

#[test]
fn signature_contract_matches_fixture() {
    // Подпись из фикстуры (сделана этим же кодом) проверяется; seed даёт тот же
    // pub_key, что записан в авторе. Это якорь для JS-стороны контракта.
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    let seed = fixture["signing"]["seed_hex"].as_str().unwrap();
    let sig = fixture["signing"]["sig_hex"].as_str().unwrap();
    let pub_key = fixture["author"]["pub_key"].as_str().unwrap();

    assert_eq!(public_key_hex(seed).unwrap(), pub_key);

    let payload: PostPayload = serde_json::from_value(fixture["post"].clone()).unwrap();
    assert!(verify(&payload, sig), "fixture signature must verify");
    assert_eq!(sign(seed, &payload).unwrap(), sig, "signature is deterministic");
}

#[test]
fn fixture_signature_rejects_tampered_body() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is json");
    let sig = fixture["signing"]["sig_hex"].as_str().unwrap();
    let mut payload: PostPayload = serde_json::from_value(fixture["post"].clone()).unwrap();
    payload.body = "подмена".to_string();
    assert!(!verify(&payload, sig));
}
