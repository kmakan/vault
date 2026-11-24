//! Свойства формата VAULTBLOB1: чанки, AAD, Range, хэш, миниатюры.

use sha2::{Digest, Sha256};
use social_media::{
    cipher_range_for, decrypt_blob, decrypt_chunk, decrypt_chunk_from, decrypt_range,
    decrypt_thumbnail, encrypt_blob, encrypt_thumbnail, parse_header, parse_header_prefix,
    thumb_key, verify_integrity, EncryptedBlob, MediaError, HEADER_LEN, MAGIC, TAG_LEN, VERSION,
};
use storage_api::Range;

const KEY: [u8; 32] = [0x11; 32];
const KEY2: [u8; 32] = [0x33; 32];
const PREFIX: [u8; 16] = [0x22; 16];
const PREFIX2: [u8; 16] = [0x44; 16];

fn enc(pt: &[u8], chunk_size: u32) -> EncryptedBlob {
    encrypt_blob(pt, &KEY, &PREFIX, chunk_size).unwrap()
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

#[test]
fn header_layout_is_exact() {
    let blob = enc(&pattern(19), 8);
    assert_eq!(&blob.bytes[..10], MAGIC);
    assert_eq!(blob.bytes[10], VERSION);
    assert_eq!(&blob.bytes[15..47], blob.blob_id.as_bytes());
    assert_eq!(&blob.bytes[47..63], &PREFIX);
    let h = parse_header(&blob.bytes).unwrap();
    assert_eq!(h.chunk_size, 8);
    assert_eq!(h.total, 19);
    // ceil(19/8) = 3 чанка; 19 + 3*16 = 67 байт шифротекста + 71 заголовок.
    assert_eq!(h.chunk_count(), 3);
    assert_eq!(blob.bytes.len(), HEADER_LEN + 19 + 3 * TAG_LEN);
    assert_eq!(h.expected_len().unwrap(), blob.bytes.len());
}

#[test]
fn roundtrip_across_chunk_boundaries() {
    for &len in &[0usize, 1, 7, 8, 9, 16, 17, 63, 64, 65, 257] {
        let pt = pattern(len);
        let blob = enc(&pt, 8);
        assert_eq!(
            decrypt_blob(&blob.bytes, &KEY).unwrap(),
            pt,
            "roundtrip failed for len={len}"
        );
        assert!(verify_integrity(&blob.bytes).is_ok());
    }
}

#[test]
fn blob_id_is_sha256_of_ciphertext_and_hides_equality() {
    let pt = pattern(32);
    let a = enc(&pt, 8);
    let b = encrypt_blob(&pt, &KEY2, &PREFIX2, 8).unwrap();
    let digest: [u8; 32] = Sha256::digest(&a.bytes[HEADER_LEN..]).into();
    assert_eq!(digest, *a.blob_id.as_bytes());
    assert_ne!(a.blob_id, b.blob_id, "одинаковые файлы не должны сливаться");
    assert_eq!(
        decrypt_blob(&b.bytes, &KEY2).unwrap(),
        pt,
        "второй блоб расшифровывается своим ключом"
    );
    assert!(decrypt_blob(&b.bytes, &KEY).is_err());
}

#[test]
fn tampered_chunk_fails_only_that_chunk() {
    let mut blob = enc(&pattern(24), 8); // 3 чанка
    let first = HEADER_LEN;
    // Чанк 0 занимает 8 + TAG_LEN байт; портим 5-й байт чанка 1.
    blob.bytes[first + 8 + TAG_LEN + 5] ^= 0x01;

    assert_eq!(
        decrypt_chunk(&blob.bytes, &KEY, 0).unwrap(),
        pattern(24)[0..8]
    );
    assert_eq!(
        decrypt_chunk(&blob.bytes, &KEY, 2).unwrap(),
        pattern(24)[16..24]
    );
    assert!(matches!(
        decrypt_chunk(&blob.bytes, &KEY, 1),
        Err(MediaError::AuthFailed(1))
    ));
    assert!(decrypt_blob(&blob.bytes, &KEY).is_err());
    // blob_id тоже не сходится: провайдер подменил байты.
    assert!(matches!(
        verify_integrity(&blob.bytes),
        Err(MediaError::BlobIdMismatch)
    ));
}

#[test]
fn chunk_swap_is_detected_by_aad_index() {
    let mut blob = enc(&pattern(16), 8); // 2 чанка по 8 + 16 тегов
    let first = HEADER_LEN;
    let second = first + 8 + TAG_LEN;
    let len = 8 + TAG_LEN;
    let left = blob.bytes[first..first + len].to_vec();
    let right = blob.bytes[second..second + len].to_vec();
    blob.bytes[first..first + len].copy_from_slice(&right);
    blob.bytes[second..second + len].copy_from_slice(&left);

    // Ключ и nonce_prefix те же, но индекс в AAD изменился -> Poly1305 не сходится.
    assert!(matches!(
        decrypt_chunk(&blob.bytes, &KEY, 0),
        Err(MediaError::AuthFailed(0))
    ));
    assert!(matches!(
        decrypt_chunk(&blob.bytes, &KEY, 1),
        Err(MediaError::AuthFailed(1))
    ));
}

#[test]
fn range_decrypt_matches_plaintext_slice() {
    let pt = pattern(100);
    let blob = enc(&pt, 16);
    let cases: &[(u64, Option<u64>)] = &[
        (0, Some(1)),
        (0, Some(16)),
        (0, Some(17)),
        (5, Some(30)),
        (15, Some(48)),
        (16, Some(17)),
        (80, Some(101)),
        (90, Some(1000)),
        (10, Some(10)),
        (200, None),
    ];
    for &(start, end) in cases {
        let e = end.unwrap_or(pt.len() as u64).min(pt.len() as u64);
        let s = start.min(e);
        let expected = &pt[s as usize..e as usize];
        let got = decrypt_range(&blob.bytes, &KEY, Range::new(start, end).unwrap()).unwrap();
        assert_eq!(got, expected, "range {start}..{end:?}");
    }
}

#[test]
fn malformed_headers_are_rejected() {
    let blob = enc(&pattern(8), 8);

    assert!(matches!(parse_header(&[]), Err(MediaError::InvalidHeader)));
    assert!(matches!(
        parse_header(&blob.bytes[..5]),
        Err(MediaError::InvalidHeader)
    ));
    let mut bad_magic = blob.bytes.clone();
    bad_magic[0] ^= 0xff;
    assert!(matches!(
        parse_header(&bad_magic),
        Err(MediaError::InvalidHeader)
    ));

    let mut bad_ver = blob.bytes.clone();
    bad_ver[10] = 2;
    assert!(matches!(
        parse_header(&bad_ver),
        Err(MediaError::UnsupportedVersion(2))
    ));

    let mut zero_chunk = blob.bytes.clone();
    zero_chunk[11..15].copy_from_slice(&0u32.to_le_bytes());
    assert!(matches!(
        parse_header(&zero_chunk),
        Err(MediaError::InvalidChunkSize)
    ));

    assert!(matches!(
        parse_header(&blob.bytes[..blob.bytes.len() - 1]),
        Err(MediaError::LengthMismatch)
    ));
    let mut extra = blob.bytes.clone();
    extra.push(0);
    assert!(matches!(
        parse_header(&extra),
        Err(MediaError::LengthMismatch)
    ));

    let mut bad_id = blob.bytes.clone();
    bad_id[15] ^= 0xff;
    assert!(parse_header(&bad_id).is_ok(), "хэш не часть структуры");
    assert!(matches!(
        verify_integrity(&bad_id),
        Err(MediaError::BlobIdMismatch)
    ));
}

#[test]
fn empty_plaintext_produces_header_only() {
    let blob = enc(&[], 8);
    assert_eq!(blob.bytes.len(), HEADER_LEN);
    let digest: [u8; 32] = Sha256::digest(&blob.bytes[HEADER_LEN..]).into();
    assert_eq!(*blob.blob_id.as_bytes(), digest);
    assert!(decrypt_blob(&blob.bytes, &KEY).unwrap().is_empty());
    assert!(decrypt_range(&blob.bytes, &KEY, Range::new(0, None).unwrap())
        .unwrap()
        .is_empty());
}

#[test]
fn prefix_parse_and_chunk_slice_match_full_decryption() {
    let pt = pattern(25); // 4 чанка по 8 байт: 8, 8, 8, 1
    let blob = enc(&pt, 8);
    // Префикс доступен без всего блоба и совпадает с полным разбором.
    assert_eq!(parse_header_prefix(&blob.bytes[..HEADER_LEN]).unwrap(), parse_header(&blob.bytes).unwrap());
    // Короткий префикс — ошибка, а не паника.
    assert_eq!(parse_header_prefix(&blob.bytes[..HEADER_LEN - 1]).unwrap_err(), MediaError::InvalidHeader);

    // Диапазон через границу чанков: читаем только нужный срез шифротекста.
    let header = parse_header_prefix(&blob.bytes[..HEADER_LEN]).unwrap();
    let cipher = cipher_range_for(&header, 5, 19).unwrap();
    let slice = &blob.bytes[cipher.start..cipher.end];
    assert!(cipher.end - cipher.start < blob.bytes.len(), "читаем меньше целого блоба");
    let mut out = Vec::new();
    for i in 0..=2 {
        out.extend_from_slice(&decrypt_chunk_from(slice, cipher.start as u64, &header, &KEY, i).unwrap());
    }
    // Срезаем ровно запрошенный plaintext [5,19).
    out.drain(..5);
    out.truncate(19 - 5);
    assert_eq!(out, decrypt_range(&blob.bytes, &KEY, Range::new(5, Some(19)).unwrap()).unwrap());
    assert_eq!(out, pt[5..19]);
}

#[test]
fn debug_does_not_leak_file_key() {
    let blob = enc(&pattern(8), 8);
    let rendered = format!("{blob:?}");
    assert!(rendered.contains("<redacted>"));
    assert!(
        !rendered.contains(&hex::encode(KEY)),
        "file_key must never appear in Debug output"
    );
}

#[test]
fn thumbnail_key_is_derived_and_separate() {
    let k = thumb_key(&KEY);
    assert_eq!(k, thumb_key(&KEY));
    assert_ne!(k, KEY);
    assert_ne!(k, thumb_key(&KEY2));

    let thumb = encrypt_thumbnail(b"preview-bytes", &KEY).unwrap();
    assert_eq!(decrypt_thumbnail(&thumb.bytes, &KEY).unwrap(), b"preview-bytes");
    assert!(decrypt_blob(&thumb.bytes, &KEY).is_err(), "ключ файла не подходит");
    assert!(decrypt_blob(&thumb.bytes, &k).is_ok(), "выведенный ключ подходит");
}
