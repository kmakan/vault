//! Локальный адаптер: общая семантика + защита пути и подмены.

use std::io::Cursor;

use sha2::{Digest, Sha256};
use storage_api::{BlobId, BlobStore, Locator, Range, StorageError};
use storage_local::LocalStore;
use tokio::io::AsyncReadExt;

fn id_of(bytes: &[u8]) -> BlobId {
    BlobId::from_bytes(Sha256::digest(bytes).into())
}

#[tokio::test]
async fn passes_shared_conformance() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    storage_conformance::run(&store)
        .await
        .expect("local adapter must pass conformance");
}

#[tokio::test]
async fn rejects_checksum_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    let payload = b"real bytes".to_vec();
    let wrong = id_of(b"different bytes");
    let err = store
        .put(&wrong, Box::new(Cursor::new(payload.clone())), payload.len() as u64)
        .await
        .unwrap_err();
    assert_eq!(err, StorageError::ChecksumMismatch);
}

#[tokio::test]
async fn uri_is_ignored_so_path_traversal_is_inert() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    let payload = b"inside the root".to_vec();
    let id = id_of(&payload);
    let loc = store
        .put(&id, Box::new(Cursor::new(payload.clone())), payload.len() as u64)
        .await
        .unwrap();

    // Подделываем uri на системный файл: адаптер обязан взять путь из blob_id.
    let hostile = Locator {
        store_id: "local".into(),
        uri: "/etc/passwd".into(),
        blob_id: id,
    };
    let mut got = Vec::new();
    store
        .get(&hostile, None)
        .await
        .unwrap()
        .read_to_end(&mut got)
        .await
        .unwrap();
    assert_eq!(got, payload);
    assert!(loc.uri.ends_with(".blob"));
}

#[tokio::test]
async fn rejects_foreign_store_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    let loc = Locator {
        store_id: "webdav".into(),
        uri: "whatever".into(),
        blob_id: id_of(b"x"),
    };
    assert!(matches!(
        store.stat(&loc).await,
        Err(StorageError::InvalidLocator(_))
    ));
}

#[tokio::test]
async fn missing_blob_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    let loc = Locator {
        store_id: "local".into(),
        uri: "x".into(),
        blob_id: id_of(b"never stored"),
    };
    assert_eq!(store.stat(&loc).await.unwrap_err(), StorageError::NotFound);
    assert_eq!(store.delete(&loc).await.unwrap_err(), StorageError::NotFound);
}

#[tokio::test]
async fn range_past_end_is_clamped() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(dir.path()).unwrap();
    let payload = b"0123456789".to_vec();
    let id = id_of(&payload);
    let loc = store
        .put(&id, Box::new(Cursor::new(payload.clone())), payload.len() as u64)
        .await
        .unwrap();

    let mut got = Vec::new();
    store
        .get(&loc, Some(Range::new(7, Some(9999)).unwrap()))
        .await
        .unwrap()
        .read_to_end(&mut got)
        .await
        .unwrap();
    assert_eq!(got, b"789");
}
