//! Контракт прав: фикстура фиксирует wire-форму для UI и не даёт правилам
//! молча разойтись с тем, что показывает фронт.

use social_model::Fingerprint;
use social_rights::{evaluate, Audience, RelationState, Role, RoleOverrides};

fn fixture() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/rights-contract.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn role_presets_match_fixture() {
    let fx = fixture();
    for (name, role) in [
        ("close", Role::Close),
        ("friend", Role::Friend),
        ("acquaintance", Role::Acquaintance),
        ("restricted", Role::Restricted),
    ] {
        let got = serde_json::to_value(role.preset()).unwrap();
        assert_eq!(got, fx["roles"][name], "preset {name}");
    }
}

#[test]
fn access_cases_match_fixture() {
    let fx = fixture();
    let viewer = Fingerprint::from_str(fx["viewer"].as_str().unwrap());
    let cases = fx["cases"].as_array().unwrap();
    assert!(!cases.is_empty());

    for (i, case) in cases.iter().enumerate() {
        let relation: RelationState = serde_json::from_value(case["relation"].clone()).unwrap();
        let role: Role = serde_json::from_value(case["role"].clone()).unwrap();
        let audience: Audience = serde_json::from_value(case["audience"].clone()).unwrap();
        let spheres: Vec<String> = serde_json::from_value(case["spheres"].clone()).unwrap();

        let got = serde_json::to_value(evaluate(
            &viewer,
            relation,
            role,
            &RoleOverrides::default(),
            &audience,
            &spheres,
        ))
        .unwrap();
        assert_eq!(got, case["access"], "case #{i}: {case}");
    }
}

#[test]
fn audiences_roundtrip_from_fixture() {
    let fx = fixture();
    for value in fx["audiences"].as_array().unwrap() {
        let audience: Audience = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(&serde_json::to_value(audience).unwrap(), value);
    }
}
