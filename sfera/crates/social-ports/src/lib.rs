//! Vault Sfera: порты между фичами (ADR-006 §9.5).
//!
//! Три контракта, через которые фичи видят друг друга, не импортируя
//! чужие реализации: `ContactDirectory`, `AudienceMembership`,
//! `PermissionPolicy`. Реализации живут в своих крейтах, корень связывает.
//!
//! Направление стрелок: `feature → social-ports`, `feature ↛ feature`.

use social_model::Fingerprint;
use social_rights::{Access, Audience, RelationState, Role, RoleOverrides};

/// Книга контактов, как её видят другие фичи. Только чтение: решение о
/// изменении отношения принимает `social-contacts`.
pub trait ContactDirectory {
    fn relation(&self, fp: &Fingerprint) -> RelationState;
    fn role(&self, fp: &Fingerprint) -> Option<Role>;
    fn overrides(&self, fp: &Fingerprint) -> Option<&RoleOverrides>;
    fn spheres(&self, fp: &Fingerprint) -> &[String];
}

/// Состав аудитории и ключ эпохи. `social-post` решает, кому доставить,
/// не зная внутреннего устройства `social-audience`.
pub trait AudienceMembership {
    fn is_member(&self, audience: &str, fp: &Fingerprint) -> bool;
    fn epoch_key(&self, audience: &str, epoch: u64) -> Option<[u8; 32]>;
}

/// Чистая политика доступа. Реализация — `social-rights::evaluate`.
pub trait PermissionPolicy {
    fn evaluate(
        &self,
        viewer: &Fingerprint,
        relation: RelationState,
        role: Role,
        overrides: &RoleOverrides,
        audience: &Audience,
        viewer_spheres: &[String],
    ) -> Access;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Порты — трейты: проверяем, что объект можно передать как dyn и что
    // вызов решения не требует знания конкретной реализации.
    struct StubDirectory;
    impl ContactDirectory for StubDirectory {
        fn relation(&self, _: &Fingerprint) -> RelationState { RelationState::Contact }
        fn role(&self, _: &Fingerprint) -> Option<Role> { Some(Role::Acquaintance) }
        fn overrides(&self, _: &Fingerprint) -> Option<&RoleOverrides> { None }
        fn spheres(&self, _: &Fingerprint) -> &[String] { &[] }
    }

    #[test]
    fn directory_is_dyn_compatible() {
        let d: &dyn ContactDirectory = &StubDirectory;
        let fp = Fingerprint::from_str("02:00:00:00:00:00:00:00:****");
        assert_eq!(d.relation(&fp), RelationState::Contact);
        assert_eq!(d.role(&fp), Some(Role::Acquaintance));
    }
}
