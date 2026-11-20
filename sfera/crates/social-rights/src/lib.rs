//! Vault Sfera — чистые правила доступа (ADR-006 §4.2).
//!
//! Никакого состояния и никакого ввода-вывода: одна функция `evaluate`
//! принимает отношение, аудиторию и роль и возвращает решение. JS не
//! дублирует эту логику — он только показывает результат.

pub mod access;
pub mod audience;
pub mod role;

pub use access::{evaluate, Access, DenyReason, RelationState};
pub use audience::Audience;
pub use role::{permissions, PermissionSet, ProfileView, Role, RoleOverrides};
