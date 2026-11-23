//! Роль — пресет прав, назначенный владельцем конкретному контакту.
//! Роль НЕ решает, какие посты человек получит (это аудитория, `audience.rs`),
//! а решает, что он может с ними делать (ADR-006 §4.2).

/// Видимость профиля: `нет / кратко / полностью`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileView {
    None,
    Brief,
    Full,
}

impl ProfileView {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProfileView::None => "none",
            ProfileView::Brief => "brief",
            ProfileView::Full => "full",
        }
    }
}

/// Что контакт может делать с доставленным постом.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PermissionSet {
    /// Ключи медиа выдаются только при `true` — это не «спрятать кнопку»,
    /// а не отдать файл (ADR-006 §4.2).
    pub can_view_media: bool,
    pub can_react: bool,
    pub can_view_history: bool,
    pub can_request_chat: bool,
    pub profile: ProfileView,
}

impl PermissionSet {
    pub const fn none() -> Self {
        Self {
            can_view_media: false,
            can_react: false,
            can_view_history: false,
            can_request_chat: false,
            profile: ProfileView::None,
        }
    }
}

/// Роли из таблицы ADR-006 §4.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Близкий: всё, включая историю.
    Close,
    /// Друг: медиа и реакции; история — по настройке (дефолт выключен).
    Friend,
    /// Знакомый: медиа да, реакции/история нет, профиль кратко.
    Acquaintance,
    /// Ограниченный: текст поста видит, ключи медиа НЕ выдаются.
    Restricted,
}

impl Role {
    /// Каноническое wire-значение: то, что приходит в DTO и в UI. Единственный
    /// источник строк — здесь, чтобы JS не дублировал протокол.
    pub const fn as_str(self) -> &'static str {
        match self {
            Role::Close => "close",
            Role::Friend => "friend",
            Role::Acquaintance => "acquaintance",
            Role::Restricted => "restricted",
        }
    }

    /// Все роли в порядке от самой привилегированной — для выбора в UI.
    pub const fn all() -> [Role; 4] {
        [Role::Close, Role::Friend, Role::Acquaintance, Role::Restricted]
    }

    pub const fn preset(self) -> PermissionSet {
        match self {
            Role::Close => PermissionSet {
                can_view_media: true,
                can_react: true,
                can_view_history: true,
                can_request_chat: true,
                profile: ProfileView::Full,
            },
            Role::Friend => PermissionSet {
                can_view_media: true,
                can_react: true,
                // «по настройке» — приватный дефолт, владелец включает явно.
                can_view_history: false,
                can_request_chat: true,
                profile: ProfileView::Full,
            },
            Role::Acquaintance => PermissionSet {
                can_view_media: true,
                can_react: false,
                can_view_history: false,
                can_request_chat: false,
                profile: ProfileView::Brief,
            },
            Role::Restricted => PermissionSet {
                can_view_media: false,
                can_react: false,
                can_view_history: false,
                can_request_chat: false,
                profile: ProfileView::None,
            },
        }
    }
}

/// Точечные переключатели поверх роли. `None` — «как в пресете».
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RoleOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_view_media: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_react: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_view_history: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_request_chat: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ProfileView>,
}

/// Итоговые права: пресет роли, поверх — явные переключатели.
pub fn permissions(role: Role, overrides: &RoleOverrides) -> PermissionSet {
    let mut p = role.preset();
    if let Some(v) = overrides.can_view_media {
        p.can_view_media = v;
    }
    if let Some(v) = overrides.can_react {
        p.can_react = v;
    }
    if let Some(v) = overrides.can_view_history {
        p.can_view_history = v;
    }
    if let Some(v) = overrides.can_request_chat {
        p.can_request_chat = v;
    }
    if let Some(v) = overrides.profile {
        p.profile = v;
    }
    p
}
