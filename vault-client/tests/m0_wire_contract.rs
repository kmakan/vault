//! M0 C1 — контракт обмена payload: Rust `incoming::classify` ↔ JS `parseEnvelope`.
//!
//! Общая фикстура `tests/fixtures/m0-wire-contract.json` читается и здесь, и
//! JS-гейтом `vault-desktop/scripts/m0-wire-smoke.mjs`: одни и те же байты
//! должны одинаково пониматься обеими сторонами.
//!
//! Правило «сколько объявлено — столько проверено»: число выполненных
//! утверждений сверяется с числом ожиданий в фикстуре, поэтому молча
//! выпавшая проверка валит тест, а не оставляет его «зелёным».

use serde_json::Value;
use vault_client::vault::incoming::{classify, ClassifyKind};

fn opt(v: Option<String>) -> Value {
    match v {
        Some(s) => Value::String(s),
        None => Value::Null,
    }
}

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/m0-wire-contract.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("фикстура {} недоступна: {e}", path.display()));
    serde_json::from_str(&raw).expect("фикстура — валидный JSON")
}

/// Поле результата classify по имени из фикстуры.
/// Неизвестное имя — паника: фикстура не должна молча расширяться.
fn field(r: &vault_client::vault::incoming::ClassifyResult, key: &str, case: &str) -> Value {
    match key {
        "kind" => Value::String(r.kind.to_string()),
        "id" => opt(r.env_id.clone()),
        "title" => opt(r.title.clone()),
        "chat_key" => opt(r.chat_key.clone()),
        other => panic!("[{case}] неизвестное ожидание rust_classify.{other} — добавь разбор в тест"),
    }
}

#[test]
fn payload_contract_matches_fixture() {
    let f = fixture();
    let from = f["from"].as_str().expect("поле from");
    let cases = f["cases"].as_array().expect("поле cases");
    assert!(!cases.is_empty(), "фикстура без кейсов");

    // Проход 1: сколько проверок объявлено — по всей фикстуре, до выполнения.
    // Иначе пропущенный кейс уменьшал бы и «объявлено», и «выполнено».
    let mut declared = 0usize;
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let exp = &case["expect"]["rust_classify"];
        if exp.is_null() {
            declared += 1; // ожидание «не конверт» — одно утверждение
            continue;
        }
        let obj = exp
            .as_object()
            .unwrap_or_else(|| panic!("[{name}] rust_classify должен быть объектом или null"));
        assert!(
            !obj.is_empty(),
            "[{name}] ожидание rust_classify пустое — кейс ничего не проверяет"
        );
        declared += obj.len();
    }

    // Проход 2: выполнение.
    let mut checked = 0usize;
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let payload = case["payload"]
            .as_str()
            .unwrap_or_else(|| panic!("[{name}] payload должен быть строкой"));
        let exp = &case["expect"]["rust_classify"];

        let got = classify(payload, from);

        if exp.is_null() {
            checked += 1;
            assert!(
                got.is_none(),
                "[{name}] ожидался не-конверт, а распознан {:?}",
                got.map(|r| r.kind)
            );
            continue;
        }

        let obj = exp.as_object().expect("проверено в проходе 1");
        let r = got.unwrap_or_else(|| panic!("[{name}] конверт не распознан"));
        for (key, want) in obj {
            let have = field(&r, key, name);
            assert_eq!(&have, want, "[{name}] rust_classify.{key}");
            checked += 1;
        }
    }

    assert_eq!(
        checked, declared,
        "выполнено проверок {checked} из объявленных {declared} — проверка выпала"
    );
    println!("M0 wire-contract (Rust): {checked}/{declared} проверок");
}

/// `ClassifyKind` печатается так же, как ожидания в фикстуре («message»).
#[test]
fn classify_kind_display_matches_fixture_vocabulary() {
    assert_eq!(ClassifyKind::Message.to_string(), "message");
    assert_eq!(ClassifyKind::Profile.to_string(), "profile");
    assert_eq!(ClassifyKind::Presence.to_string(), "presence");
    assert_eq!(ClassifyKind::Call.to_string(), "call");
}
