//! Паритет `groups.json`: одна фикстура — два клиента (ADR-005 §W4).
//!
//! Файл `tests/fixtures/groups-file-contract.json` читают и этот тест (CLI,
//! `GroupManager`), и тест моста (`src-tauri/src/groups.rs`). Оба обязаны
//! разобрать одни и те же байты без потерь и одинаково ответить на вопрос
//! «моя ли группа». Молчаливое расхождение формата (например, поле
//! `fingerprint`, которого у одной из сторон нет) здесь падает, а не
//! всплывает у пользователя пропавшей группой.

use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;
use vault_client::vault::groups::{Group, GroupManager};
use vault_client::vault::identity::Identity;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/groups-file-contract.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("фикстура {} недоступна: {e}", path.display()));
    serde_json::from_str(&raw).expect("фикстура — валидный JSON")
}

fn me(f: &Value) -> Identity {
    let aliases: Vec<String> = f["me"]["aliases"]
        .as_array()
        .expect("me.aliases")
        .iter()
        .map(|v| v.as_str().expect("алиас — строка").to_string())
        .collect();
    Identity::new(
        f["me"]["email"].as_str().expect("me.email"),
        &aliases,
        f["me"]["fingerprint"].as_str().expect("me.fingerprint"),
    )
}

fn owned_ids<'a>(groups: impl Iterator<Item = &'a Group>, id: &Identity) -> BTreeSet<String> {
    groups
        .filter(|g| {
            id.owns_group(
                &g.created_by,
                g.members
                    .iter()
                    .map(|m| (m.email.as_str(), m.fingerprint.as_str())),
            )
        })
        .map(|g| g.id.clone())
        .collect()
}

fn ids(f: &Value, key: &str) -> BTreeSet<String> {
    f["expect"][key]
        .as_array()
        .unwrap_or_else(|| panic!("expect.{key}"))
        .iter()
        .map(|v| v.as_str().expect("id — строка").to_string())
        .collect()
}

/// Фикстура пишется во временный файл и читается НАСТОЯЩИМ путём CLI
/// (`GroupManager::with_path`), а не через serde напрямую: проверяется
/// чтение файла, включая тихую ветку «битый JSON → пустая карта».
#[test]
fn cli_reads_the_shared_groups_fixture_and_agrees_on_ownership() {
    let f = fixture();
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("groups.json");
    std::fs::write(&path, serde_json::to_vec(&f["groups"]).expect("сериализация"))
        .expect("запись фикстуры");

    let mgr = GroupManager::with_path(path);

    let fixture_ids: BTreeSet<String> = f["groups"]
        .as_object()
        .expect("groups — объект")
        .keys()
        .cloned()
        .collect();
    let loaded_ids: BTreeSet<String> = mgr.list_groups().iter().map(|g| g.id.clone()).collect();
    assert_eq!(
        loaded_ids, fixture_ids,
        "CLI потерял или выдумал группы при чтении общей фикстуры"
    );

    let id = me(&f);
    let owned = owned_ids(mgr.list_groups().into_iter(), &id);
    assert_eq!(owned, ids(&f, "owned_ids"), "CLI: список «мои группы»");
    assert!(
        owned.is_disjoint(&ids(&f, "not_owned_ids")),
        "чужие группы попали в «мои»"
    );
}

/// Старая запись (до появления `fingerprint`/`joined_at`/`key_shared`,
/// `blocked`/`group_key`) обязана читаться, а не обнулять всю карту.
#[test]
fn legacy_group_without_new_fields_still_loads() {
    let f = fixture();
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("groups.json");
    std::fs::write(&path, serde_json::to_vec(&f["groups"]).expect("сериализация"))
        .expect("запись фикстуры");

    let mgr = GroupManager::with_path(path);
    let legacy = mgr
        .get_group("grp_legacy_no_fields")
        .expect("старая группа прочитана");
    assert_eq!(legacy.group_key, "", "отсутствующий group_key — пустая строка");
    assert!(legacy.blocked.is_empty(), "отсутствующий blocked — пустой список");
    let admin = legacy
        .members
        .iter()
        .find(|m| m.email == "anna@mail.ru")
        .expect("участник старой группы");
    assert_eq!(admin.fingerprint, "", "нет поля fingerprint — пусто");
    assert_eq!(admin.joined_at, "", "нет поля joined_at — пусто");
    assert!(!admin.key_shared, "нет поля key_shared — false");
}
