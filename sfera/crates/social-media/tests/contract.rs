//! Контрактная фикстура: Rust и JS обязаны понять один и тот же блоб.
//! Фикстура детерминирована и зафиксирована в tests/fixtures/blob-contract.json.

use sha2::{Digest, Sha256};
use social_media::{
    decrypt_blob, decrypt_thumbnail, parse_header, thumb_key, AAD_DOMAIN, HEADER_LEN, MAGIC,
    THUMB_INFO, VERSION,
};

fn fixture() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/blob-contract.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    hex::decode(s).unwrap()
}

#[test]
fn rust_opens_fixture_blob() {
    let fx = fixture();
    let blob = hex(fx["blob_hex"].as_str().unwrap());
    let key: [u8; 32] = hex(fx["file_key_hex"].as_str().unwrap())
        .try_into()
        .unwrap();
    let plaintext = hex(fx["plaintext_hex"].as_str().unwrap());

    assert_eq!(&blob[..10], MAGIC);
    assert_eq!(blob[10], VERSION);
    assert_eq!(blob[15..47], hex(fx["blob_id_hex"].as_str().unwrap())[..]);
    assert_eq!(blob.len() > HEADER_LEN, true);

    let header = parse_header(&blob).unwrap();
    assert_eq!(header.chunk_size, fx["chunk_size"].as_u64().unwrap() as u32);
    assert_eq!(hex(fx["nonce_prefix_hex"].as_str().unwrap()), header.nonce_prefix);
    assert_eq!(hex(fx["aad_domain_hex"].as_str().unwrap()), AAD_DOMAIN);

    assert_eq!(decrypt_blob(&blob, &key).unwrap(), plaintext);
}

#[test]
fn fixture_blob_id_is_sha256_of_ciphertext() {
    let fx = fixture();
    let blob = hex(fx["blob_hex"].as_str().unwrap());
    let digest: [u8; 32] = Sha256::digest(&blob[HEADER_LEN..]).into();
    assert_eq!(hex(fx["blob_id_hex"].as_str().unwrap()), digest);
}

#[test]
fn fixture_thumb_key_and_thumbnail_match() {
    let fx = fixture();
    let key: [u8; 32] = hex(fx["file_key_hex"].as_str().unwrap())
        .try_into()
        .unwrap();
    let thumb = &fx["thumb"];
    assert_eq!(hex(thumb["thumb_info_hex"].as_str().unwrap()), THUMB_INFO);
    assert_eq!(thumb_key(&key), hex(thumb["thumb_key_hex"].as_str().unwrap()).as_slice());

    let blob = hex(thumb["blob_hex"].as_str().unwrap());
    assert_eq!(
        decrypt_thumbnail(&blob, &key).unwrap(),
        hex(thumb["plaintext_hex"].as_str().unwrap())
    );
}
