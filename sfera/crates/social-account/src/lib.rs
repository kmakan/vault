//! Vault Sfera: тип аккаунта (ADR-006 §17).
//!
//! Организация — не вторая лента и не «страница» внутри пользователя, а
//! аккаунт с другим типом. У неё те же примитивы: ключ, отпечаток,
//! сертификат устройства, репозиторий, лента. Это устраняет дублирование
//! логики: organization подключается как обычный контакт.
//!
//! Роли Owner/Admin/Editor/Viewer НЕ вводят новую систему доступа: они
//! раскладываются в существующие `Role` + `RoleOverrides` из `social-rights`.
//! Никаких прав в UI.

use serde::{Deserialize, Serialize};
use social_model::post as signing;
use social_model::{Author, Fingerprint};
use social_rights::{permissions, PermissionSet, Role, RoleOverrides};

/// Ошибка сборки идентичности: seed не превратился в валидный ключ подписи.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdentityError {
    BadSeed(String),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadSeed(m) => write!(f, "bad identity: {m}"),
        }
    }
}

impl std::error::Error for IdentityError {}

/// Локальная идентичность приложения: seed приватного ключа и производный
/// автор. Вынесена из композиционного корня (бюджет ADR-006 §9.5): корень
/// только реэкспортирует её — `social-ffi → social-app`, не в обход.
/// Seed не попадает в `Debug`.
#[derive(Clone)]
pub struct Identity {
    seed_hex: String,
    author: Author,
}

impl Identity {
    /// Собрать идентичность из 32-байтного seed (hex).
    pub fn from_seed(seed_hex: impl Into<String>) -> Result<Self, IdentityError> {
        let seed_hex = seed_hex.into();
        let pub_key = signing::public_key_hex(&seed_hex).map_err(IdentityError::BadSeed)?;
        let author = Author::from_public_key_hex(&pub_key).map_err(IdentityError::BadSeed)?;
        Ok(Self { seed_hex, author })
    }

    pub fn author(&self) -> &Author {
        &self.author
    }

    pub fn fingerprint(&self) -> &Fingerprint {
        &self.author.fp
    }

    /// Seed нужен корню для подписи поста/профиля (`social_post::compose`,
    /// `social_profile::compose`). Публичный доступ только внутри приложения:
    /// в FFI, `Debug` и сериализацию он не попадает.
    pub fn signing_seed(&self) -> &str {
        &self.seed_hex
    }
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("fp", &self.author.fp)
            .field("seed_hex", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Person,
    Organization,
}

/// Роль в организации. Внутри — существующие примитивы прав.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgRole {
    Owner,
    Admin,
    Editor,
    Viewer,
}

impl OrgRole {
    /// Единственное место, где org-роль превращается в права Sfera.
    /// `can_request_chat` выключен для всех: organization — не чат-контакт.
    pub fn permission_set(self) -> PermissionSet {
        let (role, overrides) = match self {
            OrgRole::Owner => (Role::Close, RoleOverrides::default()),
            OrgRole::Admin => (Role::Close, RoleOverrides {
                can_request_chat: Some(false),
                ..Default::default()
            }),
            OrgRole::Editor => (Role::Friend, RoleOverrides {
                can_view_history: Some(false),
                can_request_chat: Some(false),
                ..Default::default()
            }),
            OrgRole::Viewer => (Role::Restricted, RoleOverrides {
                can_request_chat: Some(false),
                ..Default::default()
            }),
        };
        let mut p = permissions(role, &overrides);
        p.can_request_chat = false;
        p
    }
}

/// Аккаунт: тип + идентичность. Email здесь нет, как и в `Author` (§8).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub kind: AccountKind,
    pub fp: Fingerprint,
    /// Организация может иметь отображаемое имя; у пользователя оно живёт
    /// в профиле, а не здесь.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl Account {
    pub fn person(fp: Fingerprint) -> Self {
        Self { kind: AccountKind::Person, fp, display_name: None }
    }

    pub fn organization(fp: Fingerprint, display_name: impl Into<String>) -> Self {
        Self {
            kind: AccountKind::Organization,
            fp,
            display_name: Some(display_name.into()),
        }
    }

    pub fn is_organization(&self) -> bool {
        self.kind == AccountKind::Organization
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(byte: u8) -> Fingerprint {
        let mut key = [0u8; 32];
        key[0] = byte;
        Fingerprint::from_public_key_hex(&hex::encode(key)).unwrap()
    }

    #[test]
    fn organization_is_account_kind_not_second_feed() {
        let org = Account::organization(fp(1), "Vault Inc");
        assert!(org.is_organization());
        assert_eq!(org.fp, fp(1));
        let person = Account::person(fp(2));
        assert!(!person.is_organization());
    }

    #[test]
    fn owner_has_full_rights_except_chat() {
        let p = OrgRole::Owner.permission_set();
        assert!(p.can_view_media);
        assert!(p.can_react);
        assert!(p.can_view_history);
        assert!(!p.can_request_chat);
    }

    #[test]
    fn viewer_cannot_get_media_keys() {
        let p = OrgRole::Viewer.permission_set();
        assert!(!p.can_view_media, "Restricted не получает ключи медиа");
        assert!(!p.can_request_chat);
    }

    #[test]
    fn editor_has_media_but_no_history() {
        let p = OrgRole::Editor.permission_set();
        assert!(p.can_view_media);
        assert!(!p.can_view_history);
    }

    #[test]
    fn org_roles_use_existing_permission_model() {
        // Все четыре роли дают ненулевой набор прав через social-rights:
        // второй модели доступа нет.
        for role in [OrgRole::Owner, OrgRole::Admin, OrgRole::Editor, OrgRole::Viewer] {
            let p = role.permission_set();
            assert!(!p.can_request_chat);
        }
    }

    const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn identity_derives_author_from_seed() {
        let id = Identity::from_seed(SEED).unwrap();
        assert_eq!(id.signing_seed(), SEED);
        // Отпечаток выводится из публичного ключа, а не задаётся снаружи.
        assert_eq!(
            id.fingerprint().as_str(),
            Fingerprint::from_public_key_hex(&signing::public_key_hex(SEED).unwrap())
                .unwrap()
                .as_str()
        );
    }

    #[test]
    fn identity_rejects_bad_seed() {
        assert!(matches!(
            Identity::from_seed("not-hex"),
            Err(IdentityError::BadSeed(_))
        ));
    }

    #[test]
    fn identity_debug_redacts_seed() {
        let id = Identity::from_seed(SEED).unwrap();
        let rendered = format!("{id:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains(SEED));
    }
}
