//! Композиция публикации профиля: ключи, получатели, манифест и outbox.
//!
//! `SferaApp` остаётся тонким корнем; здесь только связывание портов.
//! Сборка профиля — `social-profile`, шифрование — `social-delivery`,
//! идемпотентность и квоты — `social-sync`.

use crate::{AppError, AvatarRef, ProfileLink, ProfilePublication, SferaApp};
use social_delivery::SenderKeyMaterial;
use social_profile::compose;

/// Опубликовать профиль адресно каждому контакту с публичными ключами.
/// Без ключей сохраняется старый локальный маркер: транспорт его отклонит,
/// а не выдаст за E2E-доставку.
#[allow(clippy::too_many_arguments)]
pub fn set_my_profile(
    app: &mut SferaApp,
    ts: u64,
    display_name: impl Into<String>,
    bio: impl Into<String>,
    avatar: Option<AvatarRef>,
    links: Vec<ProfileLink>,
    now: u64,
    avatar_manifest: Option<serde_json::Value>,
    peers: &[social_link::LinkedContact],
    sender: Option<&SenderKeyMaterial>,
) -> Result<ProfilePublication, AppError> {
    let signed = compose(app.identity().signing_seed(), ts, display_name, bio, avatar, links)?;
    let outcome = app.profiles_mut().upsert(signed.clone())?;
    let mut sealed = 0;
    let mut skipped = 0;
    if let Some(sender) = sender {
        let json = social_profile::envelope_json(&signed, avatar_manifest.as_ref())?;
        let batch = social_bridge::seal_profile_for_contacts(&json, sender, peers);
        skipped = batch.skipped.len();
        for item in batch.sealed {
            let id = social_profile::publication_id(&signed, &item.to)?;
            let wire = serde_json::to_string(&item.envelope)
                .map_err(|e| AppError::Canonical(e.to_string()))?;
            app.outbox_mut().enqueue_envelope(id, item.address, wire, false, now)?;
            sealed += 1;
        }
    }
    if sealed == 0 {
        let id = social_profile::publication_id(&signed, app.identity().fingerprint())?;
        app.outbox_mut().enqueue(id, signed.profile.bio.len() as u64, now)?;
    }
    Ok(ProfilePublication { outcome, sealed, skipped })
}
