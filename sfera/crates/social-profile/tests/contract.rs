//! Контракт Rust↔JS для профиля. Фикстура зафиксирована в tests/fixtures.

use std::path::PathBuf;

use social_profile::{canonical_profile, compose, verify_profile, AvatarRef, ProfileLink};
use storage_api::BlobId;

const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/profile-contract.json")
}

fn fixture() -> serde_json::Value {
    let raw = std::fs::read_to_string(fixture_path()).expect("profile fixture must exist");
    serde_json::from_str(&raw).expect("profile fixture must be JSON")
}

/// Перегенерировать фикстуру после изменения формата:
/// `cargo test -p social-profile --test contract -- --ignored regenerate_fixture`
#[test]
#[ignore]
fn regenerate_fixture() {
    let signed = compose(
        SEED,
        1795000000,
        "Аня",
        "Если есть вопросы — пиши сюда.",
        Some(AvatarRef {
            blob_id: BlobId::from_bytes([0x11; 32]),
            mime: "image/jpeg".into(),
            size: 12_345,
        }),
        vec![
            ProfileLink {
                label: "сайт".into(),
                url: "https://example.org/about".into(),
            },
            ProfileLink {
                label: "почта".into(),
                url: "mailto:anya@example.org".into(),
            },
        ],
    )
    .unwrap();
    assert!(verify_profile(&signed));
    let fx = serde_json::json!({
        "canonical_profile": String::from_utf8(canonical_profile(&signed.profile).unwrap()).unwrap(),
        "domain": String::from_utf8_lossy(social_profile::SIGN_DOMAIN).to_string(),
        "profile": signed.profile,
        "seed_hex": SEED,
        "sig_hex": signed.sig,
    });
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(&fx).unwrap() + "\n").unwrap();
}

#[test]
fn fixture_signature_verifies_in_rust() {
    let fx = fixture();
    let profile = serde_json::from_value(fx["profile"].clone()).unwrap();
    let signed = social_profile::SignedProfile {
        profile,
        sig: fx["sig_hex"].as_str().unwrap().to_string(),
    };
    assert!(verify_profile(&signed));
}

#[test]
fn fixture_canonical_matches_rust() {
    let fx = fixture();
    let profile = serde_json::from_value(fx["profile"].clone()).unwrap();
    assert_eq!(
        String::from_utf8(canonical_profile(&profile).unwrap()).unwrap(),
        fx["canonical_profile"].as_str().unwrap()
    );
}

#[test]
fn fixture_domain_is_profile_domain() {
    let fx = fixture();
    assert_eq!(
        fx["domain"].as_str().unwrap(),
        String::from_utf8_lossy(social_profile::SIGN_DOMAIN)
    );
}
