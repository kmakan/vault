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
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RecipientKeyMaterial {
    pub fp: Fingerprint,
    /// X25519-публичный ключ получателя, hex (32 байта).
    pub x25519_public_hex: String,
    /// ML-KEM-768 ek получателя, base64.
    pub pq_ek_b64: String,
    /// Адрес получателя в книге отправителя (подсказка доставки).
    /// Пусто — адрес неизвестен; на шифр не влияет.
    pub address: String,
}

impl RecipientKeyMaterial {
    /// Материал получателя из контакта bundle связывания. Ключи берутся
    /// только публичные: приватная половина остаётся у владельца (ADR-009 §4).
    pub fn from_linked(contact: &social_link::LinkedContact) -> Self {
        Self {
            fp: contact.fp.clone(),
            x25519_public_hex: contact.x25519_pub.clone(),
            pq_ek_b64: contact.pq_ek.clone(),
            address: contact.address.clone(),
        }
    }

    /// Готов ли контакт к адресной отправке: нужны оба публичных ключа.
    /// Без них шифровать нечем — конверт не собрать.
    pub fn can_seal(&self) -> bool {
        !self.x25519_public_hex.is_empty() && !self.pq_ek_b64.is_empty()
    }
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

/// Неполный PQ-конверт помечается как требующий повторного разбора.
/// Этот предикат задаёт решение в домене доставки, а не подстрокой ошибки в IMAP.
#[must_use]
pub fn is_retryable_delivery_error(error: &DeliveryError) -> bool {
    matches!(error, DeliveryError::MissingKemct)
}

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

// --- Конверт профиля (ADR-006 §7.6) ---------------------------------------
//
// Профиль (имя, аватар, ссылки) публикуется адресно: каждому контакту — свой
// конверт, запечатанный ТЕМ ЖЕ E2E-примитивом Vault, что и сообщения. Открытый
// профиль в конверте не лежит, поэтому сервер/релей его не читает.
//
// Конверт отличается от обёртки ключа аудитории назначением, а не шифром:
// `wrap_audience_key` несёт 32-байтный ключ эпохи, `seal_payload` — произвольный
// текст (профиль). Разделяем типы, чтобы их нельзя было перепутать местами.

/// Адресный конверт произвольного содержимого.
///
/// `PartialEq` не выводится: `HybridHeader` из `vault-core` его не реализует,
/// а сравнивать конверты целиком незачем — адресат и адрес проверяются полями.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SealedEnvelope {
    /// Версия адресного конверта.
    pub v: u8,
    /// Кому адресован конверт (X25519-отпечаток получателя).
    pub to: Fingerprint,
    /// Публичный X25519 отправителя: нужен получателю для hybrid KDF.
    /// Это не секрет; приватный ключ в конверт не входит.
    pub from_x25519: String,
    /// Адрес получателя в книге отправителя: подсказка для доставки и для
    /// случая, когда отпечаток не совпал (алиас, смена адреса).
    pub address: String,
    /// Шифротекст (base64), как его отдаёт `hybrid_encrypt_vault`.
    pub wire: String,
    /// Гибридный заголовок: `kemct` и метаданные PQ.
    pub header: HybridHeader,
}

/// Версия wire-формы адресного конверта.
pub const ENVELOPE_VERSION: u8 = 1;

/// Запечатать `plaintext` для получателя.
pub fn seal_payload(
    plaintext: &str,
    sender: &SenderKeyMaterial,
    recipient: &RecipientKeyMaterial,
) -> Result<SealedEnvelope, DeliveryError> {
    let (wire, header) = hybrid_encrypt_vault(
        plaintext,
        &sender.x25519_private_hex,
        &recipient.x25519_public_hex,
        sender.pq_seed_hex.as_deref(),
        &recipient.pq_ek_b64,
    )
    .map_err(|e| DeliveryError::Wrap(e.to_string()))?;
    let private_bytes: [u8; 32] = hex::decode(&sender.x25519_private_hex)
        .map_err(|e| DeliveryError::Wrap(e.to_string()))?
        .try_into()
        .map_err(|_| DeliveryError::Wrap("sender X25519 key must be 32 bytes".to_string()))?;
    let private = x25519_dalek::StaticSecret::from(private_bytes);
    let from_x25519 = hex::encode(x25519_dalek::PublicKey::from(&private).as_bytes());

    Ok(SealedEnvelope {
        v: ENVELOPE_VERSION,
        to: recipient.fp.clone(),
        from_x25519,
        address: recipient.address.clone(),
        wire,
        header,
    })
}

/// Открыть конверт получателем. `sender_x25519_public_hex` — публичный ключ
/// отправителя: он нужен гибридному примитиву для вывода общего секрета.
pub fn open_payload(
    envelope: &SealedEnvelope,
    recipient_x25519_private_hex: &str,
    sender_x25519_public_hex: &str,
    recipient_pq_seed_hex: &str,
) -> Result<String, DeliveryError> {
    let kemct = envelope
        .header
        .kemct
        .as_deref()
        .ok_or(DeliveryError::MissingKemct)?;
    let plaintext = hybrid_decrypt_vault(
        &envelope.wire, recipient_x25519_private_hex,
        sender_x25519_public_hex, recipient_pq_seed_hex, kemct,
    ).map_err(|e| DeliveryError::Unwrap(e.to_string()))?;
    let parsed: serde_json::Value = serde_json::from_str(&plaintext)
        .map_err(|e| DeliveryError::Unwrap(format!("payload is not JSON: {e}")))?;
    if let Some(text) = parsed.as_str() {
        return Ok(text.to_string());
    }
    // Новые типизированные конверты (пост, профиль, обсуждение) несут объект
    // напрямую. Legacy-форма hybrid_encrypt_vault может вернуть JSON-строку;
    // обе формы проходят один и тот же гибридный E2E-путь.
    if parsed.is_object() {
        return Ok(plaintext);
    }
    Err(DeliveryError::Unwrap("payload is not a JSON object or string".into()))
}

// --- Адресный пост ---------------------------------------------------------
// Подпись, JSON и publication id принадлежат `social-post`: транспортный
// crate не зависит от постовой фичи и лишь шифрует произвольный plaintext.
