//! Миниатюра — отдельный маленький блоб с ключом, выведенным из ключа файла
//! (ADR-006 §5.1). Провайдер видит два несвязанных блоба без ключей.

use hkdf::Hkdf;
use sha2::Sha256;

use crate::{
    decrypt_blob, encrypt_blob, generate_nonce_prefix, EncryptedBlob, MediaError,
    DEFAULT_CHUNK_SIZE,
};

/// Info HKDF для вывода ключа миниатюры.
pub const THUMB_INFO: &[u8] = b"vaultblob:thumb:v1";

/// `HKDF-SHA256(ikm = file_key, salt = none, info = THUMB_INFO, L = 32)`.
pub fn thumb_key(file_key: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, file_key);
    let mut out = [0u8; 32];
    // 32 байта < 255 * HashLen — expand всегда успешен при корректном размере.
    hk.expand(THUMB_INFO, &mut out)
        .expect("HKDF output length must be valid");
    out
}

/// Зашифровать миниатюру ключом, выведенным из `file_key`.
pub fn encrypt_thumbnail(
    thumb_plain: &[u8],
    file_key: &[u8; 32],
) -> Result<EncryptedBlob, MediaError> {
    let key = thumb_key(file_key);
    let prefix = generate_nonce_prefix();
    encrypt_blob(thumb_plain, &key, &prefix, DEFAULT_CHUNK_SIZE)
}

/// Расшифровать миниатюру. Ключ файла напрямую не подойдёт — только вывод HKDF.
pub fn decrypt_thumbnail(blob: &[u8], file_key: &[u8; 32]) -> Result<Vec<u8>, MediaError> {
    decrypt_blob(blob, &thumb_key(file_key))
}
