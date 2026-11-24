//! Vault Sfera — формат медиаблоба (ADR-006 §5).
//!
//! Блоб = заголовок `VAULTBLOB1` + независимые зашифрованные чанки.
//! `blob_id` = SHA-256 шифротекста (адрес для провайдера, без дедупликации),
//! ключ файла уходит получателю только внутри E2E-конверта.
//!
//! Чанки независимы: Range-запрос расшифровывает только нужный кусок — это
//! фундамент стриминга и будущего видеохостинга.

pub mod format;
pub mod thumb;

pub use format::{
    cipher_range_for, decrypt_blob, decrypt_chunk, decrypt_chunk_from, decrypt_range, encrypt_blob,
    parse_header, parse_header_prefix, verify_integrity, BlobHeader, EncryptedBlob,
};
pub use thumb::{decrypt_thumbnail, encrypt_thumbnail, thumb_key, THUMB_INFO};

use std::fmt;

/// Magic блоба: ровно 10 байт в начале каждого `VAULTBLOB1`.
pub const MAGIC: &[u8; 10] = b"VAULTBLOB1";
pub const VERSION: u8 = 1;
/// `magic(10) + ver(1) + chunk_size(4) + blob_id(32) + nonce_prefix(16) + total(8)`.
pub const HEADER_LEN: usize = 71;
pub const DEFAULT_CHUNK_SIZE: u32 = 4 * 1024 * 1024;
/// Длина тега Poly1305, добавленного к каждому чанку.
pub const TAG_LEN: usize = 16;
/// Домен AAD — отделяет блоб от подписи поста и других протоколов Vault.
pub const AAD_DOMAIN: &[u8] = b"vaultblob:v1\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    /// Слишком короткий блоб или неверная magic.
    InvalidHeader,
    UnsupportedVersion(u8),
    InvalidChunkSize,
    /// Фактическая длина не соответствует `total` и числу чанков.
    LengthMismatch,
    /// `blob_id` не совпал с SHA-256 шифротекста.
    BlobIdMismatch,
    /// Чанк не прошёл Poly1305 (подмена, битый ключ или неверный AAD).
    AuthFailed(u64),
    InvalidRange(String),
    /// Индекс чанка больше их числа.
    ChunkOutOfRange,
}

impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHeader => f.write_str("invalid VAULTBLOB1 header"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported blob version: {v}"),
            Self::InvalidChunkSize => f.write_str("chunk size must be > 0"),
            Self::LengthMismatch => f.write_str("blob length does not match header"),
            Self::BlobIdMismatch => f.write_str("blob_id does not match ciphertext hash"),
            Self::AuthFailed(i) => write!(f, "chunk {i} failed authentication"),
            Self::InvalidRange(m) => write!(f, "invalid range: {m}"),
            Self::ChunkOutOfRange => f.write_str("chunk index out of range"),
        }
    }
}

impl std::error::Error for MediaError {}

/// 32 случайных байта ключа файла. Ключ НЕ лежит в блобе — он завёртывается
/// ключом аудитории/получателя и едет в посте (ADR-006 §5.1, §5.2).
pub fn generate_file_key() -> [u8; 32] {
    use rand::RngCore;
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    key
}

/// 16 случайных байт префикса nonce (остальные 8 — индекс чанка).
pub fn generate_nonce_prefix() -> [u8; 16] {
    use rand::RngCore;
    let mut p = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut p);
    p
}
