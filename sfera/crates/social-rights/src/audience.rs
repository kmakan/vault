//! Аудитория решает, КАКИЕ посты человек получит (ADR-006 §4). Роль решает,
//! что он может с ними делать — это `role.rs`.

use social_model::Fingerprint;

/// Форма аудитории совпадает с полем `audience` конверта:
/// `{ "kind": "all_contacts|sphere|selected|all_except", ... }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Audience {
    /// Все принятые контакты.
    AllContacts,
    /// Именованный набор (сфера) у автора.
    Sphere { id: String },
    /// Явный список на один пост.
    Selected { fps: Vec<Fingerprint> },
    /// Все контакты, кроме перечисленных.
    AllExcept { fps: Vec<Fingerprint> },
}

impl Audience {
    /// Входит ли зритель в аудиторию. `viewer_spheres` — id сфер, в которых
    /// зритель состоит (членство хранится у автора).
    pub fn contains(&self, viewer: &Fingerprint, viewer_spheres: &[String]) -> bool {
        match self {
            Audience::AllContacts => true,
            Audience::Sphere { id } => viewer_spheres.iter().any(|s| s == id),
            Audience::Selected { fps } => fps.iter().any(|f| f.same(viewer)),
            Audience::AllExcept { fps } => !fps.iter().any(|f| f.same(viewer)),
        }
    }
}
