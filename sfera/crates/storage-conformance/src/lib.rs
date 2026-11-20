//! Семантика `BlobStore`, которой обязан удовлетворять ЛЮБОЙ адаптер
//! (local, WebDAV, S3, …). Новый провайдер = адаптер + прогон этой функции
//! (ADR-006 §6.1: «новый провайдер = пресет + адаптер, прошедший
//! provider-conformance»).

use std::io::Cursor;

use sha2::{Digest, Sha256};
use storage_api::{BlobId, BlobStore, Range, StorageError};
use tokio::io::AsyncReadExt;

fn id_of(bytes: &[u8]) -> BlobId {
    BlobId::from_bytes(Sha256::digest(bytes).into())
}

async fn read_all(
    store: &dyn BlobStore,
    loc: &storage_api::Locator,
    range: Option<Range>,
) -> Result<Vec<u8>, String> {
    let mut r = store.get(loc, range).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    r.read_to_end(&mut out).await.map_err(|e| e.to_string())?;
    Ok(out)
}

/// Прогнать полный набор проверок. Возвращает текст ошибки, чтобы вызывающий
/// тест упал с понятным сообщением, а не с «assert failed».
pub async fn run(store: &dyn BlobStore) -> Result<(), String> {
    let payload = b"Vault Sfera conformance: put, stat, range, overwrite, delete.".to_vec();
    let id = id_of(&payload);

    // put
    let loc = store
        .put(
            &id,
            Box::new(Cursor::new(payload.clone())),
            payload.len() as u64,
        )
        .await
        .map_err(|e| format!("put: {e}"))?;
    if loc.blob_id != id {
        return Err("put returned a different blob_id".into());
    }

    // get full
    let got = read_all(store, &loc, None).await.map_err(|e| format!("get: {e}"))?;
    if got != payload {
        return Err("get returned different bytes".into());
    }

    // stat
    let st = store.stat(&loc).await.map_err(|e| format!("stat: {e}"))?;
    if st.blob_id != id {
        return Err("stat blob_id mismatch".into());
    }
    if st.size != payload.len() as u64 {
        return Err(format!("stat size {} != {}", st.size, payload.len()));
    }

    // range (если провайдер его заявляет)
    if store.caps().range {
        let part = read_all(store, &loc, Some(Range::new(5, Some(10)).unwrap()))
            .await
            .map_err(|e| format!("range 5..10: {e}"))?;
        if part != payload[5..10] {
            return Err("range 5..10 returned wrong bytes".into());
        }
        let tail = read_all(store, &loc, Some(Range::new(10, None).unwrap()))
            .await
            .map_err(|e| format!("range 10..: {e}"))?;
        if tail != payload[10..] {
            return Err("range 10.. returned wrong bytes".into());
        }
        let clamped = read_all(store, &loc, Some(Range::new(5, Some(100_000)).unwrap()))
            .await
            .map_err(|e| format!("range clamp: {e}"))?;
        if clamped != payload[5..] {
            return Err("range past end was not clamped".into());
        }
    }

    // overwrite тем же id идемпотентен
    let loc2 = store
        .put(
            &id,
            Box::new(Cursor::new(payload.clone())),
            payload.len() as u64,
        )
        .await
        .map_err(|e| format!("put overwrite: {e}"))?;
    if loc2.blob_id != id {
        return Err("overwrite changed blob_id".into());
    }

    // delete
    store
        .delete(&loc)
        .await
        .map_err(|e| format!("delete: {e}"))?;
    match store.stat(&loc).await {
        Err(StorageError::NotFound) => {}
        other => return Err(format!("stat after delete must be NotFound, got {other:?}")),
    }

    Ok(())
}
