//! Приём адресного профиля: конверт → подпись → книга и манифест аватара.

use crate::{AppError, ProfileUpsertOutcome, SferaApp};
use social_delivery::{open_payload, SealedEnvelope};

/// Открыть конверт приватными ключами получателя и принять подписанный профиль.
/// Возвращает исход книги, стабильный ID автора и манифест только внутри Rust.
#[derive(Debug)]
pub struct ReceivedProfile {
    pub outcome: ProfileUpsertOutcome,
    pub profile_id: String,
    pub avatar_manifest: Option<social_library::AvatarManifest>,
}

pub fn receive_profile_envelope(
    app: &mut SferaApp,
    envelope: &SealedEnvelope,
    recipient_x25519_private_hex: &str,
    recipient_pq_seed_hex: &str,
) -> Result<ReceivedProfile, AppError> {
    let plaintext = open_payload(
        envelope,
        recipient_x25519_private_hex,
        &envelope.from_x25519,
        recipient_pq_seed_hex,
    )
    .map_err(|e| AppError::Canonical(e.to_string()))?;
    let (signed, manifest) = social_profile::parse_envelope_json(&plaintext)?;
    let profile_id = social_profile::profile_id(&signed);
    let outcome = app.receive_profile(signed)?;
    Ok(ReceivedProfile { outcome, profile_id, avatar_manifest: manifest })
}
