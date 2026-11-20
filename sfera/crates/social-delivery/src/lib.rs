//! Vault Sfera — доставка ключа аудитории (ADR-006 §4, §7.1).
//!
//! Ключ эпохи (`social_audience::AudienceKeys`) обёртывается адресно каждому
//! ТЕКУЩЕМУ участнику тем же E2E-примитивом Vault, что и сообщения
//! мессенджера (PQ-hybrid из `vault-core`). Здесь — только обёртка/разбор;
//! outbox, ретраи и порты email/relay появятся отдельной партией.
//!
//! Инвариант: обернуть ключ можно только участнику, который входит в состав
//! СЕЙЧАС. Удалённый участник получает `NotAMember` — новый ключ ему не
//! уходит, даже если его адрес ещё лежит в старом списке рассылки.

use social_audience::AudienceKeys;
use social_model::Fingerprint;
use vault_core::crypto_pq::{hybrid_decrypt_vault, hybrid_encrypt_vault, HybridHeader};

use std::fmt;

/// Открытые ключи получателя, нужные для обёртки.
#[derive(Clone, Debug)]
pub struct RecipientKeyMaterial {
    pub fp: Fingerprint,
    /// X25519-публичный ключ получателя, hex (32 байта).
    pub x25519_public_hex: String,
    /// ML-KEM-768 ek получателя, base64.
    pub pq_ek_b64: String,
}

/// Приватные ключи отправителя для обёртки.
#[derive(Clone)]
pub struct SenderKeyMaterial {
    /// X25519-приватный ключ отправителя, hex (32 байта).
    pub x25519_private_hex: String,
    /// ML-KEM-768 seed отправителя, hex (64 байта); `None` — без PQ-метаданных.
    pub pq_seed_hex: Option<String>,
}

impl fmt::Debug for SenderKeyMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SenderKeyMaterial")
            .field("x25519_private_hex", &"<redacted>")
            .field("pq_seed_hex", &self.pq_seed_hex.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Обёрнутый ключ эпохи. `wire` и `header` кладутся в E2E-конверт получателя.
#[derive(Clone, Debug)]
pub struct WrappedAudienceKey {
    pub audience_id: String,
    pub epoch: u64,
    pub wire: String,
    pub header: HybridHeader,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryError {
    /// Получатель не входит в текущий состав аудитории.
    NotAMember,
    /// В конверте нет `kemct` — это не гибридный ключ.
    MissingKemct,
    /// Обёртка не удалась (битые ключи получателя/отправителя).
    Wrap(String),
    /// Разбор не удался (чужая подпись ключа, порча, не тот получатель).
    Unwrap(String),
    /// Расшифрованный plaintext — не 32-байтный ключ.
    BadKey,
}

impl fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAMember => f.write_str("recipient is not a current audience member"),
            Self::MissingKemct => f.write_str("wrapped key has no kemct"),
            Self::Wrap(m) => write!(f, "wrap failed: {m}"),
            Self::Unwrap(m) => write!(f, "unwrap failed: {m}"),
            Self::BadKey => f.write_str("decrypted payload is not a 32-byte key"),
        }
    }
}

impl std::error::Error for DeliveryError {}

/// Обернуть ключ ТЕКУЩЕЙ эпохи для участника. Не-участнику — отказ.
pub fn wrap_audience_key(
    keys: &AudienceKeys,
    sender: &SenderKeyMaterial,
    recipient: &RecipientKeyMaterial,
) -> Result<WrappedAudienceKey, DeliveryError> {
    if !keys.is_member(&recipient.fp) {
        return Err(DeliveryError::NotAMember);
    }
    let plaintext = hex::encode(keys.current_key());
    let (wire, header) = hybrid_encrypt_vault(
        &plaintext,
        &sender.x25519_private_hex,
        &recipient.x25519_public_hex,
        sender.pq_seed_hex.as_deref(),
        &recipient.pq_ek_b64,
    )
    .map_err(|e| DeliveryError::Wrap(e.to_string()))?;

    Ok(WrappedAudienceKey {
        audience_id: keys.audience_id().to_string(),
        epoch: keys.epoch(),
        wire,
        header,
    })
}

/// Развернуть ключ эпохи получателем.
pub fn unwrap_audience_key(
    wrapped: &WrappedAudienceKey,
    recipient_x25519_private_hex: &str,
    sender_x25519_public_hex: &str,
    recipient_pq_seed_hex: &str,
) -> Result<[u8; 32], DeliveryError> {
    let kemct = wrapped
        .header
        .kemct
        .as_deref()
        .ok_or(DeliveryError::MissingKemct)?;
    let plaintext = hybrid_decrypt_vault(
        &wrapped.wire,
        recipient_x25519_private_hex,
        sender_x25519_public_hex,
        recipient_pq_seed_hex,
        kemct,
    )
    .map_err(|e| DeliveryError::Unwrap(e.to_string()))?;

    let bytes = hex::decode(plaintext.trim()).map_err(|_| DeliveryError::BadKey)?;
    let key: [u8; 32] = bytes.try_into().map_err(|_| DeliveryError::BadKey)?;
    Ok(key)
}
