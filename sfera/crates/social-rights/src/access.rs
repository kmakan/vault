//! Матрица доступа: отношение × аудитория × роль → решение (ADR-006 §4.1–4.3).
//! Чистая функция без состояния: одно и то же решение на телефоне и десктопе.

use social_model::Fingerprint;

use crate::audience::Audience;
use crate::role::{permissions, PermissionSet, Role, RoleOverrides};

/// Состояние отношения (ADR-006 §4.1: `none → requested → contact | declined | blocked`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationState {
    None,
    Requested,
    Contact,
    Declined,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DenyReason {
    /// Заявка ещё не одобрена.
    PendingRequest,
    /// Заявку отклонили.
    Declined,
    /// Владелец заблокировал.
    Blocked,
    /// Контакт есть, но пост не входит в его аудиторию.
    NotInAudience,
    /// Отношения нет вовсе.
    NotAContact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Access {
    /// Пост вообще доставляется этому зрителю.
    pub delivered: bool,
    pub permissions: PermissionSet,
    pub deny: Option<DenyReason>,
}

impl Access {
    /// Медиа доступно только если пост доставлен И роль даёт ключ медиа.
    pub fn can_view_media(&self) -> bool {
        self.delivered && self.permissions.can_view_media
    }

    pub fn can_view_history(&self) -> bool {
        self.delivered && self.permissions.can_view_history
    }

    pub fn can_react(&self) -> bool {
        self.delivered && self.permissions.can_react
    }
}

/// Единственное место, где решается доступ. `role`/`overrides` имеют смысл
/// только при `RelationState::Contact`; для остальных состояний прав нет.
pub fn evaluate(
    viewer: &Fingerprint,
    relation: RelationState,
    role: Role,
    overrides: &RoleOverrides,
    audience: &Audience,
    viewer_spheres: &[String],
) -> Access {
    match relation {
        RelationState::Blocked => Access {
            delivered: false,
            permissions: PermissionSet::none(),
            deny: Some(DenyReason::Blocked),
        },
        RelationState::None => Access {
            delivered: false,
            permissions: PermissionSet::none(),
            deny: Some(DenyReason::NotAContact),
        },
        RelationState::Requested => Access {
            delivered: false,
            permissions: PermissionSet::none(),
            deny: Some(DenyReason::PendingRequest),
        },
        RelationState::Declined => Access {
            delivered: false,
            permissions: PermissionSet::none(),
            deny: Some(DenyReason::Declined),
        },
        RelationState::Contact => {
            if !audience.contains(viewer, viewer_spheres) {
                return Access {
                    delivered: false,
                    permissions: PermissionSet::none(),
                    deny: Some(DenyReason::NotInAudience),
                };
            }
            Access {
                delivered: true,
                permissions: permissions(role, overrides),
                deny: None,
            }
        }
    }
}
