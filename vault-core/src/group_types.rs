//! Запись группы, общая для CLI и моста десктопа.
//!
//! ДО ЭТОГО МОДУЛЯ формы было две: `vault-client/src/vault/groups.rs` и
//! `src-tauri/src/groups.rs` описывали один и тот же `groups.json` разными
//! структурами. Расхождение было не косметическим: у моста поле `fingerprint`
//! есть, у ядра — нет, поэтому в CLI участник, сменивший почту, опознавался
//! только по старому адресу, а в десктопе — по отпечатку. Два клиента на одном
//! файле давали разные ответы на вопрос «моя ли группа».
//!
//! Здесь только форма записи (serde), без хранилища и без правил: чтение и
//! запись файла остаются у клиентов, решения — в `identity`/`group_rules`.
//! `joined_at`, `key_shared` и `fingerprint` имеют `serde(default)`: старые
//! `groups.json` и инвайты прежних версий читаются без миграции.

use serde::{Deserialize, Serialize};

/// Групповой чат (модель Signal): общий ключ на группу, роли участников.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: String,
    pub members: Vec<GroupMember>,
    #[serde(default)]
    pub blocked: Vec<String>,
    pub encrypted: bool,
    /// Hex-encoded 32-byte key for group encryption (XChaCha20-Poly1305)
    #[serde(default)]
    pub group_key: String,
}

/// Участник группы в том виде, в каком он лежит в `groups.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupMember {
    pub email: String,
    pub role: GroupRole,
    // Инвайт передаёт список участников только с email+role — при десериализации
    // отсутствующие поля получают значения по умолчанию.
    #[serde(default)]
    pub joined_at: String,
    #[serde(default)]
    pub key_shared: bool,
    /// Отпечаток публичного ключа участника в форме десктопа
    /// (`xx:xx:…:****`). Стабилен при смене почты; пустой у старых групп —
    /// заполняется лениво. Значение, равное самому публичному ключу, — след
    /// старого backfill (он писал ключ вместо отпечатка) и чинится при
    /// первом же чтении `peer_keys`.
    #[serde(default)]
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GroupRole {
    Admin,
    Moderator,
    Member,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Старая запись без `joined_at`, `key_shared` и `fingerprint` читается:
    /// иначе обновление приложения «теряло» бы группы, записанные прошлой
    /// версией. Проверяем именно форму файла, а не конструктор.
    #[test]
    fn legacy_member_without_new_fields_loads() {
        let json = r#"{
            "g1": {
                "id": "g1", "name": "team", "created_by": "a@x",
                "created_at": "2025-01-01T00:00:00Z",
                "members": [{"email": "a@x", "role": "Admin"}],
                "encrypted": true
            }
        }"#;
        let groups: std::collections::HashMap<String, Group> =
            serde_json::from_str(json).expect("старый groups.json читается");
        let g = groups.get("g1").unwrap();
        assert_eq!(g.members[0].joined_at, "");
        assert!(!g.members[0].key_shared);
        assert_eq!(g.members[0].fingerprint, "");
        assert!(g.blocked.is_empty());
        assert_eq!(g.group_key, "");
    }

    /// Одна форма на оба клиента: отпечаток участника переживает запись и
    /// чтение, а роль не превращается в строку-«другое».
    #[test]
    fn fingerprint_and_role_roundtrip() {
        let g = Group {
            id: "g1".into(),
            name: "team".into(),
            created_by: "a@x".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            members: vec![GroupMember {
                email: "b@x".into(),
                role: GroupRole::Moderator,
                joined_at: "2025-01-02T00:00:00Z".into(),
                key_shared: true,
                fingerprint: "aa:bb:cc:dd:ee:ff:00:11:****".into(),
            }],
            blocked: vec!["c@x".into()],
            encrypted: true,
            group_key: "ab".repeat(32),
        };
        let json = serde_json::to_string(&g).unwrap();
        let back: Group = serde_json::from_str(&json).unwrap();
        assert_eq!(back, g);
    }
}
