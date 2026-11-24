//! Ключи шифрования Sfera: генерация, хранение, идемпотентность загрузки.

use social_delivery::{open_payload, seal_payload, RecipientKeyMaterial};
use social_keys::{
    load_at, load_or_create_at, path_in, save_at, EncryptionIdentity, KeyError,
};

fn entropy(byte: u8) -> [u8; 32] {
    [byte; 32]
}

#[test]
fn generated_identity_has_both_public_keys() {
    let id = EncryptionIdentity::generate(entropy(7)).unwrap();
    assert_eq!(id.x25519_public_hex().len(), 64, "X25519 pub — 32 байта hex");
    assert!(!id.pq_ek_b64().is_empty(), "ML-KEM ek публикуется");
    // Приватные части не должны попадать в Debug.
    let dbg = format!("{id:?}");
    assert!(dbg.contains("<redacted>"), "Debug обязан скрывать секреты");
    assert!(!dbg.contains(id.x25519_private_hex()), "приватный ключ в Debug");
}

#[test]
fn same_entropy_gives_same_identity() {
    // Ядро детерминировано: случайность подаёт оболочка. Это позволяет
    // воспроизводить тесты, но НЕ означает, что ключ можно угадать.
    let a = EncryptionIdentity::generate(entropy(3)).unwrap();
    let b = EncryptionIdentity::generate(entropy(3)).unwrap();
    assert_eq!(a.x25519_public_hex(), b.x25519_public_hex());
}

#[test]
fn different_entropy_gives_different_identity() {
    let a = EncryptionIdentity::generate(entropy(1)).unwrap();
    let b = EncryptionIdentity::generate(entropy(2)).unwrap();
    assert_ne!(a.x25519_public_hex(), b.x25519_public_hex());
}

#[test]
fn save_then_load_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let id = EncryptionIdentity::generate(entropy(9)).unwrap();
    save_at(dir.path(), &id).unwrap();

    let loaded = load_at(dir.path()).unwrap();
    assert_eq!(loaded.x25519_public_hex(), id.x25519_public_hex());
    assert_eq!(loaded.pq_ek_b64(), id.pq_ek_b64());
    assert_eq!(loaded.x25519_private_hex(), id.x25519_private_hex());
}

#[test]
fn load_or_create_is_idempotent() {
    // Второй запуск НЕ должен создавать новый ключ: иначе ранее выданные
    // конверты перестанут открываться.
    let dir = tempfile::tempdir().unwrap();
    let first = load_or_create_at(dir.path(), entropy(5)).unwrap();
    let second = load_or_create_at(dir.path(), entropy(6)).unwrap();
    assert_eq!(first.x25519_public_hex(), second.x25519_public_hex());
}

#[test]
fn load_missing_file_is_error_not_silent_new_key() {
    let dir = tempfile::tempdir().unwrap();
    match load_at(dir.path()) {
        Err(KeyError::Io(_)) => {}
        other => panic!("ожидали Io, получили {other:?}"),
    }
}

#[test]
fn corrupt_file_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(path_in(dir.path()), b"{not json").unwrap();
    match load_at(dir.path()) {
        Err(KeyError::Corrupt(_)) => {}
        other => panic!("ожидали Corrupt, получили {other:?}"),
    }
}

#[test]
fn unknown_version_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let id = EncryptionIdentity::generate(entropy(4)).unwrap();
    save_at(dir.path(), &id).unwrap();
    let raw = std::fs::read_to_string(path_in(dir.path())).unwrap();
    let bumped = raw.replace("\"v\": 1", "\"v\": 2");
    std::fs::write(path_in(dir.path()), bumped).unwrap();
    match load_at(dir.path()) {
        Err(KeyError::Corrupt(m)) => assert!(m.contains("version"), "{m}"),
        other => panic!("ожидали Corrupt по версии, получили {other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn key_file_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let id = EncryptionIdentity::generate(entropy(8)).unwrap();
    save_at(dir.path(), &id).unwrap();
    let mode = std::fs::metadata(path_in(dir.path())).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "ключи только владельцу");
}

#[test]
fn seal_and_open_roundtrip_between_two_identities() {
    // Два разных приложения: Алиса запечатывает профиль для Боба, Боб открывает.
    let alice = EncryptionIdentity::generate(entropy(11)).unwrap();
    let bob = EncryptionIdentity::generate(entropy(22)).unwrap();

    let bob_public = RecipientKeyMaterial {
        fp: bob.fingerprint().unwrap(),
        x25519_public_hex: bob.x25519_public_hex().to_string(),
        pq_ek_b64: bob.pq_ek_b64().to_string(),
        address: "bob@example.org".into(),
    };
    assert!(bob_public.can_seal());

    let profile = r#"{"name":"Боб","bio":"тест"}"#;
    let envelope = seal_payload(profile, &alice.sender_material(), &bob_public).unwrap();
    assert_eq!(envelope.address, "bob@example.org");
    assert_eq!(envelope.to, bob.fingerprint().unwrap());

    let opened = open_payload(
        &envelope,
        bob.x25519_private_hex(),
        alice.x25519_public_hex(),
        bob.pq_seed_hex(),
    )
    .unwrap();
    assert_eq!(opened, profile);
}

#[test]
fn wrong_recipient_cannot_open() {
    let alice = EncryptionIdentity::generate(entropy(31)).unwrap();
    let bob = EncryptionIdentity::generate(entropy(32)).unwrap();
    let eve = EncryptionIdentity::generate(entropy(33)).unwrap();

    let bob_public = RecipientKeyMaterial {
        fp: bob.fingerprint().unwrap(),
        x25519_public_hex: bob.x25519_public_hex().to_string(),
        pq_ek_b64: bob.pq_ek_b64().to_string(),
        address: String::new(),
    };
    let envelope = seal_payload("секрет", &alice.sender_material(), &bob_public).unwrap();

    // Ева знает публичный ключ Алисы, но не приватный ключ Боба.
    assert!(open_payload(
        &envelope,
        eve.x25519_private_hex(),
        alice.x25519_public_hex(),
        eve.pq_seed_hex(),
    )
    .is_err());
}

#[test]
fn contact_without_keys_cannot_be_sealed() {
    // Контакт из bundle без ключей шифрования: отправлять нечем, и это должно
    // быть видно ДО попытки шифрования.
    let contact = social_link::LinkedContact {
        fp: social_model::Fingerprint::from_public_key_hex(&"11".repeat(32)).unwrap(),
        pub_key: "22".repeat(32),
        label: "Без ключей".into(),
        x25519_pub: String::new(),
        pq_ek: String::new(),
        address: "nokeys@example.org".into(),
    };
    let material = RecipientKeyMaterial::from_linked(&contact);
    assert!(!material.can_seal());
    assert_eq!(material.address, "nokeys@example.org");
}
