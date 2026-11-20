//! Vault Sfera: реализации портов поверх конкретных фич (ADR-006 §9.5).
//!
//! Порты объявлены в `social-ports`, реализации живут здесь. Корень
//! (`social-app`) связывает их, не импортируя чужие реализации напрямую.
//! Направление: `social-ports-impl → social-contacts|social-audience|
//! social-rights`; фичи друг друга не видят.

use std::collections::BTreeMap;

use social_audience::AudienceKeys;
use social_contacts::ContactBook;
use social_model::Fingerprint;
use social_ports::{AudienceMembership, ContactDirectory, PermissionPolicy};
use social_rights::{evaluate, Access, Audience, RelationState, Role, RoleOverrides};

/// Реализация каталога контактов поверх `ContactBook`.
pub struct ContactsDirectory<'a>(pub &'a ContactBook);

impl ContactDirectory for ContactsDirectory<'_> {
    fn relation(&self, fp: &Fingerprint) -> RelationState {
        self.0.state_of(fp)
    }

    fn role(&self, fp: &Fingerprint) -> Option<Role> {
        self.0.get(fp).map(|r| r.role)
    }

    fn overrides(&self, fp: &Fingerprint) -> Option<&RoleOverrides> {
        self.0.get(fp).map(|r| &r.overrides)
    }

    fn spheres(&self, fp: &Fingerprint) -> &[String] {
        self.0.get(fp).map(|r| r.spheres.as_slice()).unwrap_or(&[])
    }
}

/// Реализация состава аудиторий поверх карты ключей корня.
pub struct Audiences<'a>(pub &'a BTreeMap<String, AudienceKeys>);

impl AudienceMembership for Audiences<'_> {
    fn is_member(&self, audience: &str, fp: &Fingerprint) -> bool {
        self.0
            .get(audience)
            .map(|keys| keys.is_member(fp))
            .unwrap_or(false)
    }

    fn epoch_key(&self, audience: &str, epoch: u64) -> Option<[u8; 32]> {
        let keys = self.0.get(audience)?;
        if epoch == keys.epoch() {
            Some(*keys.current_key())
        } else {
            keys.key_for(epoch).copied()
        }
    }
}

/// Политика доступа — тонкая обёртка над единственным правилом `social-rights`.
#[derive(Clone, Copy, Default)]
pub struct RightsPolicy;

impl PermissionPolicy for RightsPolicy {
    fn evaluate(
        &self,
        viewer: &Fingerprint,
        relation: RelationState,
        role: Role,
        overrides: &RoleOverrides,
        audience: &Audience,
        viewer_spheres: &[String],
    ) -> Access {
        evaluate(viewer, relation, role, overrides, audience, viewer_spheres)
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
    fn contacts_port_reads_book() {
        let mut book = ContactBook::new();
        let f = fp(1);
        book.upsert(social_contacts::ContactRecord::contact(
            f.clone(), Role::Friend, vec!["family".into()], true,
        ));
        let port = ContactsDirectory(&book);
        assert_eq!(port.relation(&f), RelationState::Contact);
        assert_eq!(port.role(&f), Some(Role::Friend));
        assert_eq!(port.spheres(&f), &["family".to_string()]);
    }

    #[test]
    fn audience_port_reads_current_and_history_keys() {
        let f = fp(2);
        let keys = AudienceKeys::new("family", [f.clone()]);
        let epoch = keys.epoch();
        let mut map = BTreeMap::new();
        map.insert("family".to_string(), keys);
        let port = Audiences(&map);
        assert!(port.is_member("family", &f));
        assert!(port.epoch_key("family", epoch).is_some());
        assert!(!port.is_member("other", &f), "неизвестная аудитория не содержит участника");
        assert!(port.epoch_key("other", 0).is_none());
    }

    #[test]
    fn rights_port_delegates_to_single_rule() {
        let f = fp(3);
        let p = RightsPolicy;
        let access = p.evaluate(
            &f, RelationState::Blocked, Role::Friend, &RoleOverrides::default(),
            &Audience::AllContacts, &[],
        );
        assert!(!access.delivered);
    }
}
