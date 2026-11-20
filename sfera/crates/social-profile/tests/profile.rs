//! Профиль: подпись в отдельном домене, валидация и книга «новее побеждает».

use social_model::post::{sign_with_domain, verify_value, SIGN_DOMAIN as POST_DOMAIN};
use social_profile::{
    compose, sign_profile, verify_profile, AvatarRef, ProfileBook, ProfileError, ProfileLink,
    ProfileV1, SignedProfile, UpsertOutcome, SIGN_DOMAIN,
};
use storage_api::BlobId;

const SEED_A: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const SEED_B: &str = "0200000000000000000000000000000000000000000000000000000000000000";

fn link(label: &str, url: &str) -> ProfileLink {
    ProfileLink {
        label: label.into(),
        url: url.into(),
    }
}

fn avatar() -> AvatarRef {
    AvatarRef {
        blob_id: BlobId::from_bytes([0xab; 32]),
        mime: "image/jpeg".into(),
        size: 4096,
    }
}

fn profile(seed: &str, ts: u64, name: &str) -> SignedProfile {
    compose(
        seed,
        ts,
        name,
        "био",
        Some(avatar()),
        vec![link("сайт", "https://example.org")],
    )
    .unwrap()
}

#[test]
fn sign_then_verify() {
    let signed = profile(SEED_A, 100, "Аня");
    assert!(verify_profile(&signed));
}

#[test]
fn tampered_field_is_rejected() {
    let mut evil = profile(SEED_A, 100, "Аня");
    evil.profile.display_name = "Аня!".into();
    assert!(!verify_profile(&evil));
}

#[test]
fn tampered_bio_avatar_and_link_are_rejected() {
    let base = profile(SEED_A, 100, "Аня");
    let mut evil_bio = base.clone();
    evil_bio.profile.bio = "другое био".into();
    assert!(!verify_profile(&evil_bio));

    let mut evil_avatar = base.clone();
    evil_avatar.profile.avatar.as_mut().unwrap().size += 1;
    assert!(!verify_profile(&evil_avatar));

    let mut evil_link = base;
    evil_link.profile.links[0].url = "https://evil.example".into();
    assert!(!verify_profile(&evil_link));
}

#[test]
fn other_key_cannot_verify() {
    let signed = profile(SEED_A, 100, "Аня");
    let sig_b = sign_profile(SEED_B, &signed.profile).unwrap();
    assert!(verify_profile(&signed));
    // Подпись B под тем же автором (A) не проходит.
    let mut evil = signed;
    evil.sig = sig_b.sig;
    assert!(!verify_profile(&evil));
}

#[test]
fn domain_separation_rejects_post_signature() {
    let signed = profile(SEED_A, 100, "Аня");
    let post_sig = sign_with_domain(POST_DOMAIN, SEED_A, &signed.profile).unwrap();

    let mut evil = signed.clone();
    evil.sig = post_sig;
    assert!(
        !verify_profile(&evil),
        "подпись в домене поста не обязана приниматься как подпись профиля"
    );

    // И обратно: подпись профиля не проходит проверку в домене поста.
    assert!(
        !verify_value(&signed.profile, &signed.profile.author, &signed.sig),
        "подпись профиля не обязана приниматься как подпись поста"
    );
    assert_eq!(SIGN_DOMAIN, b"sfera-profile:v1\0");
    assert_ne!(SIGN_DOMAIN, POST_DOMAIN);
}

#[test]
fn verify_rejects_bad_form_even_with_valid_signature_shape() {
    let mut evil = profile(SEED_A, 100, "Аня");
    evil.profile.v = 2;
    assert!(!verify_profile(&evil));
    evil = profile(SEED_A, 100, "Аня");
    evil.profile.kind = "social_post".into();
    assert!(!verify_profile(&evil));
}

#[test]
fn validation_limits_and_urls() {
    let long = "ы".repeat(81);
    assert_eq!(
        compose(SEED_A, 1, long, "", None, vec![]).unwrap_err(),
        ProfileError::NameTooLong { max: 80 }
    );
    let long_bio = "ы".repeat(501);
    assert_eq!(
        compose(SEED_A, 1, "Аня", long_bio, None, vec![]).unwrap_err(),
        ProfileError::BioTooLong { max: 500 }
    );
    let many: Vec<_> = (0..9).map(|_| link("л", "https://a.example")).collect();
    assert_eq!(
        compose(SEED_A, 1, "Аня", "", None, many).unwrap_err(),
        ProfileError::TooManyLinks { max: 8 }
    );

    for bad in [
        "javascript:alert(1)",
        "ftp://x.example",
        "https://",
        "https://x y.example",
        "example.org",
        "mailto:not-an-address",
    ] {
        assert!(
            matches!(
                compose(SEED_A, 1, "Аня", "", None, vec![link("л", bad)]).unwrap_err(),
                ProfileError::BadUrl(_)
            ),
            "url должен быть отклонён: {bad}"
        );
    }
    assert!(compose(
        SEED_A,
        1,
        "Аня",
        "",
        None,
        vec![link("почта", "mailto:a@example.org"), link("сайт", "http://a.example")]
    )
    .is_ok());
}

#[test]
fn avatar_semantics() {
    let bad = AvatarRef {
        blob_id: BlobId::from_bytes([1; 32]),
        mime: "".into(),
        size: 10,
    };
    assert_eq!(
        compose(SEED_A, 1, "Аня", "", Some(bad), vec![]).unwrap_err(),
        ProfileError::EmptyAvatarMime
    );
    let bad = AvatarRef {
        blob_id: BlobId::from_bytes([1; 32]),
        mime: "image/png".into(),
        size: 0,
    };
    assert_eq!(
        compose(SEED_A, 1, "Аня", "", Some(bad), vec![]).unwrap_err(),
        ProfileError::EmptyAvatar
    );
}

#[test]
fn book_newer_wins_and_stale_is_rejected() {
    let mut book = ProfileBook::new();
    let old = profile(SEED_A, 100, "Аня");
    let new = profile(SEED_A, 200, "Аня Новая");

    assert_eq!(book.upsert(new.clone()).unwrap(), UpsertOutcome::Inserted);
    assert_eq!(book.upsert(old).unwrap(), UpsertOutcome::Stale);
    assert_eq!(book.len(), 1);
    assert_eq!(book.get(&new.profile.author.fp), Some(&new));

    let newer = profile(SEED_A, 300, "Аня Новая");
    assert_eq!(book.upsert(newer.clone()).unwrap(), UpsertOutcome::Updated);
    assert_eq!(book.get(&newer.profile.author.fp), Some(&newer));
}

#[test]
fn book_dedup_and_deterministic_tie_break() {
    let mut book = ProfileBook::new();
    let first = profile(SEED_A, 100, "Аня");
    assert_eq!(book.upsert(first.clone()).unwrap(), UpsertOutcome::Inserted);
    assert_eq!(book.upsert(first.clone()).unwrap(), UpsertOutcome::Duplicate);

    let second = profile(SEED_A, 100, "Аня Вторая");
    let bytes_a = social_profile::canonical_profile(&first.profile).unwrap();
    let bytes_b = social_profile::canonical_profile(&second.profile).unwrap();
    let (winner, loser) = if bytes_a > bytes_b {
        (&first, &second)
    } else {
        (&second, &first)
    };

    let mut other = ProfileBook::new();
    for p in [&first, &second] {
        other.upsert(p.clone()).unwrap();
    }
    assert_eq!(book.len(), 1);
    assert_eq!(other.len(), 1);
    assert_eq!(book.snapshot(), other.snapshot());
    assert_eq!(book.get(&winner.profile.author.fp), Some(winner));
    assert_ne!(book.get(&loser.profile.author.fp), Some(loser));
}

#[test]
fn book_rejects_invalid_and_restores() {
    let mut evil = profile(SEED_A, 100, "Аня");
    evil.profile.bio = "подмена".into();
    let mut book = ProfileBook::new();
    assert_eq!(
        book.upsert(evil).unwrap_err(),
        ProfileError::InvalidSignature
    );
    assert!(book.is_empty());

    let a = profile(SEED_A, 100, "Аня");
    let b = profile(SEED_B, 200, "Боря");
    let restored = ProfileBook::restore(vec![a.clone(), b.clone()]).unwrap();
    assert_eq!(restored.len(), 2);
    assert_eq!(restored.get(&a.profile.author.fp), Some(&a));
    assert_eq!(restored.get(&b.profile.author.fp), Some(&b));

    let mut bad_restore = a;
    bad_restore.profile.bio = "подмена".into();
    assert!(ProfileBook::restore(vec![bad_restore]).is_err());
}

#[test]
fn book_remove_by_fingerprint() {
    let mut book = ProfileBook::new();
    let p = profile(SEED_A, 100, "Аня");
    assert_eq!(book.upsert(p.clone()).unwrap(), UpsertOutcome::Inserted);
    assert_eq!(book.remove(&p.profile.author.fp), Some(p));
    assert!(book.is_empty());
}

#[test]
fn profile_serde_roundtrip() {
    let signed = profile(SEED_A, 100, "Аня");
    let json = serde_json::to_string(&signed).unwrap();
    assert!(json.contains("\"sig\""), "подпись лежит рядом с формой");
    let back: SignedProfile = serde_json::from_str(&json).unwrap();
    assert_eq!(back, signed);
    assert!(verify_profile(&back));
}

#[test]
fn profile_v1_validate_standalone() {
    let signed = profile(SEED_A, 100, "Аня");
    assert!(signed.profile.validate().is_ok());
    let mut p: ProfileV1 = signed.profile;
    p.links.push(link("плохо", "gopher://x"));
    assert!(matches!(p.validate(), Err(ProfileError::BadUrl(_))));
}
