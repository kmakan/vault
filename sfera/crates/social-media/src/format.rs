//! Формат `VAULTBLOB1`: заголовок + независимые зашифрованные чанки (ADR-006 §5.1).

use aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};
use storage_api::BlobId;

use crate::{MediaError, AAD_DOMAIN, HEADER_LEN, MAGIC, TAG_LEN, VERSION};

/// Разобранный заголовок. Все целые little-endian, длина ровно [`HEADER_LEN`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobHeader {
    pub version: u8,
    pub chunk_size: u32,
    pub blob_id: BlobId,
    pub nonce_prefix: [u8; 16],
    /// Длина plaintext в байтах.
    pub total: u64,
}

impl BlobHeader {
    pub fn chunk_count(&self) -> u64 {
        if self.total == 0 {
            0
        } else {
            self.total.div_ceil(self.chunk_size as u64)
        }
    }

    /// Ожидаемая полная длина блоба (заголовок + ciphertext + теги).
    pub fn expected_len(&self) -> Result<usize, MediaError> {
        let cipher_len = self
            .total
            .checked_add(self.chunk_count().saturating_mul(TAG_LEN as u64))
            .ok_or(MediaError::LengthMismatch)?;
        let full = cipher_len
            .checked_add(HEADER_LEN as u64)
            .ok_or(MediaError::LengthMismatch)?;
        usize::try_from(full).map_err(|_| MediaError::LengthMismatch)
    }
}

/// Результат шифрования. `file_key` НЕ лежит в `bytes` и не должен попадать
/// в логи: он завёртывается ключом аудитории и уходит в посте.
#[derive(Clone)]
pub struct EncryptedBlob {
    /// Заголовок + шифротекст, готовые к записи в `BlobStore`.
    pub bytes: Vec<u8>,
    pub blob_id: BlobId,
    /// Секретный ключ файла — caller обязан защитить его при хранении.
    pub file_key: [u8; 32],
    pub nonce_prefix: [u8; 16],
    pub chunk_size: u32,
    pub total: u64,
}

// `file_key` — секрет: в `Debug` печатаем только маркер, чтобы случайный
// `{:?}` не слил ключ в лог (правило «секреты не в логи»).
impl std::fmt::Debug for EncryptedBlob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedBlob")
            .field("blob_id", &self.blob_id)
            .field("chunk_size", &self.chunk_size)
            .field("total", &self.total)
            .field("nonce_prefix", &hex::encode(self.nonce_prefix))
            .field("file_key", &"<redacted>")
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

/// `nonce = nonce_prefix || i`, `aad = AAD_DOMAIN || nonce_prefix || i || total`.
/// `i` и `total` — u64 little-endian. `blob_id` намеренно НЕ в AAD: он есть
/// SHA-256 шифротекста и не может быть его входом (цикл, см. ADR-006 §5.1).
fn nonce_and_aad(nonce_prefix: &[u8; 16], i: u64, total: u64) -> (XNonce, Vec<u8>) {
    let ib = i.to_le_bytes();
    let mut nonce_bytes = [0u8; 24];
    nonce_bytes[..16].copy_from_slice(nonce_prefix);
    nonce_bytes[16..].copy_from_slice(&ib);

    let mut aad = Vec::with_capacity(AAD_DOMAIN.len() + 16 + 8 + 8);
    aad.extend_from_slice(AAD_DOMAIN);
    aad.extend_from_slice(nonce_prefix);
    aad.extend_from_slice(&ib);
    aad.extend_from_slice(&total.to_le_bytes());

    (*XNonce::from_slice(&nonce_bytes), aad)
}

/// Позиция чанка `i` в массиве байт блоба: `(offset ciphertext, длина ciphertext)`.
/// Все чанки кроме последнего имеют длину ровно `chunk_size`, поэтому смещение
/// считается формулой без цикла.
fn chunk_bounds(i: u64, h: &BlobHeader) -> Result<(usize, usize), MediaError> {
    if i >= h.chunk_count() {
        return Err(MediaError::ChunkOutOfRange);
    }
    let remaining = h.total - i * h.chunk_size as u64;
    let pt_len = h
        .chunk_size
        .min(u32::try_from(remaining).unwrap_or(u32::MAX));
    let ct_start = HEADER_LEN
        + usize::try_from(i * (h.chunk_size as u64 + TAG_LEN as u64))
            .map_err(|_| MediaError::LengthMismatch)?;
    Ok((ct_start, pt_len as usize + TAG_LEN))
}

/// Зашифровать plaintext в блоб. `file_key` и `nonce_prefix` передаёт caller —
/// так тесты и кросс-языковой контракт воспроизводимы; в проде их дают
/// `generate_file_key()` / `generate_nonce_prefix()`.
pub fn encrypt_blob(
    plaintext: &[u8],
    file_key: &[u8; 32],
    nonce_prefix: &[u8; 16],
    chunk_size: u32,
) -> Result<EncryptedBlob, MediaError> {
    if chunk_size == 0 {
        return Err(MediaError::InvalidChunkSize);
    }
    let total = plaintext.len() as u64;
    let chunk_count = total.div_ceil(chunk_size as u64);
    let cipher = XChaCha20Poly1305::new_from_slice(file_key).map_err(|_| MediaError::InvalidHeader)?;

    let mut ciphertext = Vec::with_capacity(total as usize + (chunk_count as usize) * TAG_LEN);
    for i in 0..chunk_count {
        let start = (i * chunk_size as u64) as usize;
        let pt_len = (chunk_size as usize).min(plaintext.len() - start);
        let (nonce, aad) = nonce_and_aad(nonce_prefix, i, total);
        let sealed = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &plaintext[start..start + pt_len],
                    aad: &aad,
                },
            )
            .map_err(|_| MediaError::AuthFailed(i))?;
        ciphertext.extend_from_slice(&sealed);
    }

    let digest = Sha256::digest(&ciphertext);
    let blob_id = BlobId::from_bytes(digest.into());

    let mut bytes = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    bytes.extend_from_slice(MAGIC);
    bytes.push(VERSION);
    bytes.extend_from_slice(&chunk_size.to_le_bytes());
    bytes.extend_from_slice(blob_id.as_bytes());
    bytes.extend_from_slice(nonce_prefix);
    bytes.extend_from_slice(&total.to_le_bytes());
    bytes.extend_from_slice(&ciphertext);

    Ok(EncryptedBlob {
        bytes,
        blob_id,
        file_key: *file_key,
        nonce_prefix: *nonce_prefix,
        chunk_size,
        total,
    })
}

/// Структурный разбор заголовка. Хэш не проверяет — для этого есть
/// [`verify_integrity`] (потоковый клиент может не иметь всего блоба).
pub fn parse_header(blob: &[u8]) -> Result<BlobHeader, MediaError> {
    if blob.len() < HEADER_LEN || &blob[..MAGIC.len()] != MAGIC {
        return Err(MediaError::InvalidHeader);
    }
    let version = blob[10];
    if version != VERSION {
        return Err(MediaError::UnsupportedVersion(version));
    }
    let chunk_size = u32::from_le_bytes(
        blob[11..15]
            .try_into()
            .map_err(|_| MediaError::InvalidHeader)?,
    );
    if chunk_size == 0 {
        return Err(MediaError::InvalidChunkSize);
    }
    let blob_id = BlobId::from_bytes(
        blob[15..47]
            .try_into()
            .map_err(|_| MediaError::InvalidHeader)?,
    );
    let nonce_prefix: [u8; 16] = blob[47..63]
        .try_into()
        .map_err(|_| MediaError::InvalidHeader)?;
    let total = u64::from_le_bytes(
        blob[63..71]
            .try_into()
            .map_err(|_| MediaError::InvalidHeader)?,
    );
    let header = BlobHeader {
        version,
        chunk_size,
        blob_id,
        nonce_prefix,
        total,
    };
    if blob.len() != header.expected_len()? {
        return Err(MediaError::LengthMismatch);
    }
    Ok(header)
}

/// Проверка `blob_id == SHA-256(ciphertext)` перед доверием к данным провайдера.
pub fn verify_integrity(blob: &[u8]) -> Result<BlobHeader, MediaError> {
    let header = parse_header(blob)?;
    let digest: [u8; 32] = Sha256::digest(&blob[HEADER_LEN..]).into();
    if digest != *header.blob_id.as_bytes() {
        return Err(MediaError::BlobIdMismatch);
    }
    Ok(header)
}

fn decrypt_chunk_with_header(
    blob: &[u8],
    header: &BlobHeader,
    file_key: &[u8; 32],
    i: u64,
) -> Result<Vec<u8>, MediaError> {
    let (offset, ct_len) = chunk_bounds(i, header)?;
    let chunk = blob
        .get(offset..offset + ct_len)
        .ok_or(MediaError::LengthMismatch)?;
    if ct_len < TAG_LEN {
        return Err(MediaError::AuthFailed(i));
    }
    let (sealed, tag) = chunk.split_at(ct_len - TAG_LEN);
    let cipher =
        XChaCha20Poly1305::new_from_slice(file_key).map_err(|_| MediaError::InvalidHeader)?;
    let (nonce, aad) = nonce_and_aad(&header.nonce_prefix, i, header.total);
    let mut sealed_with_tag = Vec::with_capacity(sealed.len() + TAG_LEN);
    sealed_with_tag.extend_from_slice(sealed);
    sealed_with_tag.extend_from_slice(tag);
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &sealed_with_tag,
                aad: &aad,
            },
        )
        .map_err(|_| MediaError::AuthFailed(i))
}

/// Расшифровать один чанк (для Range/стриминга). Полный хэш блоба не считается:
/// каждый чанк аутентифицирован Poly1305 с привязкой к `i` и `total`.
pub fn decrypt_chunk(blob: &[u8], file_key: &[u8; 32], i: u64) -> Result<Vec<u8>, MediaError> {
    let header = parse_header(blob)?;
    decrypt_chunk_with_header(blob, &header, file_key, i)
}

/// Полная расшифровка с проверкой `blob_id`.
pub fn decrypt_blob(blob: &[u8], file_key: &[u8; 32]) -> Result<Vec<u8>, MediaError> {
    let header = verify_integrity(blob)?;
    let mut out = Vec::with_capacity(header.total as usize);
    for i in 0..header.chunk_count() {
        out.extend_from_slice(&decrypt_chunk_with_header(blob, &header, file_key, i)?);
    }
    Ok(out)
}

/// Расшифровать полуоткрытый диапазон plaintext `[start, end)`.
/// Границы клампятся к `total`; диапазон целиком вне блоба даёт пустой результат.
pub fn decrypt_range(
    blob: &[u8],
    file_key: &[u8; 32],
    range: storage_api::Range,
) -> Result<Vec<u8>, MediaError> {
    let header = parse_header(blob)?;
    let total = header.total;
    let start = range.start.min(total);
    let end = range.end.unwrap_or(total).min(total);
    if start >= end {
        return Ok(Vec::new());
    }
    let first = start / header.chunk_size as u64;
    let last = (end - 1) / header.chunk_size as u64;
    let mut out = Vec::with_capacity((end - start) as usize);
    for i in first..=last {
        let pt = decrypt_chunk_with_header(blob, &header, file_key, i)?;
        let chunk_start = i * header.chunk_size as u64;
        let local_start = (start.saturating_sub(chunk_start)) as usize;
        let local_end = (end.min(chunk_start + pt.len() as u64) - chunk_start) as usize;
        if local_start < local_end {
            out.extend_from_slice(&pt[local_start..local_end]);
        }
    }
    Ok(out)
}
