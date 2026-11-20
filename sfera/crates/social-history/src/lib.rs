//! Vault Sfera: выдача истории новому получателю (ADR-006 §7.5).
//!
//! Пакет ключей постов и медиа за период отправляется батчами (по 50) с
//! прогрессом в UI. Устройство владельца должно быть онлайн: иначе заявка
//! ждёт в outbox, а не «одобряется сервером». Повторная доставка батча не
//! выдаёт ключ дважды — дедуп по `(from, to, nonce)` через `ContactBook`.

use serde::{Deserialize, Serialize};
use social_model::Fingerprint;

/// Стандартный размер батча из ADR: 50 постов.
pub const DEFAULT_BATCH_SIZE: usize = 50;

/// Один ключ, который выдаётся получателю. `blob_id` — hex SHA-256 блоба,
/// `key_hex` — симметричный ключ в hex, `epoch` — эпоха аудитории.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryKey {
    pub blob_id: String,
    pub key_hex: String,
    pub epoch: u64,
}

/// Батч ключей. `nonce` стабилен для `(заявка, индекс батча)` — повторная
/// доставка того же батча не создаёт вторую выдачу.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryBatch {
    pub from: Fingerprint,
    pub to: Fingerprint,
    pub nonce: String,
    pub index: usize,
    pub total: usize,
    pub keys: Vec<HistoryKey>,
    /// `true` — последний батч; UI показывает 100%.
    #[serde(default)]
    pub final_batch: bool,
}

/// Прогресс выдачи для UI. Только числа — никаких ключей.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantProgress {
    pub sent_batches: usize,
    pub total_batches: usize,
    pub sent_keys: usize,
    pub total_keys: usize,
}

impl GrantProgress {
    pub fn done(&self) -> bool {
        self.total_batches > 0 && self.sent_batches == self.total_batches
    }
}

/// Разбить ключи на батчи. Детерминированный порядок: как передали, так и
/// выдаём — два устройства не расходятся в нумерации.
pub fn make_batches(
    from: Fingerprint,
    to: Fingerprint,
    request_nonce: &str,
    keys: Vec<HistoryKey>,
    batch_size: usize,
) -> Vec<HistoryBatch> {
    let batch_size = batch_size.max(1);
    let total = keys.len().div_ceil(batch_size);
    keys.chunks(batch_size)
        .enumerate()
        .map(|(index, chunk)| HistoryBatch {
            from: from.clone(),
            to: to.clone(),
            nonce: format!("{request_nonce}:{index}"),
            index,
            total,
            keys: chunk.to_vec(),
            final_batch: index + 1 == total,
        })
        .collect()
}

/// Принять батч: вернуть `true`, только если он новый. `ContactBook` хранит
/// nonce, поэтому повторная доставка не выдаёт ключ дважды.
pub fn accept_batch(
    book: &mut social_contacts::ContactBook,
    batch: &HistoryBatch,
) -> bool {
    book.mark_nonce(&batch.from, &batch.to, &batch.nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(byte: u8) -> Fingerprint {
        let mut key = [0u8; 32];
        key[0] = byte;
        Fingerprint::from_public_key_hex(&hex::encode(key)).unwrap()
    }

    fn keys(n: usize) -> Vec<HistoryKey> {
        (0..n)
            .map(|i| HistoryKey {
                blob_id: format!("{:064x}", i),
                key_hex: format!("{:064x}", i + 100),
                epoch: 1,
            })
            .collect()
    }

    #[test]
    fn default_batch_size_matches_adr() {
        assert_eq!(DEFAULT_BATCH_SIZE, 50);
    }

    #[test]
    fn batches_cover_all_keys_and_last_is_marked() {
        let batches = make_batches(fp(1), fp(2), "req-1", keys(120), DEFAULT_BATCH_SIZE);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].keys.len(), 50);
        assert_eq!(batches[2].keys.len(), 20);
        assert!(!batches[0].final_batch);
        assert!(batches[2].final_batch);
        let total: usize = batches.iter().map(|b| b.keys.len()).sum();
        assert_eq!(total, 120);
    }

    #[test]
    fn batch_nonces_are_stable_and_unique() {
        let a = make_batches(fp(1), fp(2), "req-1", keys(60), DEFAULT_BATCH_SIZE);
        let b = make_batches(fp(1), fp(2), "req-1", keys(60), DEFAULT_BATCH_SIZE);
        assert_eq!(a, b, "два устройства должны нумеровать батчи одинаково");
        assert_ne!(a[0].nonce, a[1].nonce);
    }

    #[test]
    fn duplicate_batch_is_not_granted_twice() {
        let mut book = social_contacts::ContactBook::new();
        let batches = make_batches(fp(1), fp(2), "req-1", keys(10), DEFAULT_BATCH_SIZE);
        assert!(accept_batch(&mut book, &batches[0]));
        assert!(!accept_batch(&mut book, &batches[0]), "повтор не выдаёт ключ");
    }

    #[test]
    fn progress_is_honest() {
        let p = GrantProgress { sent_batches: 2, total_batches: 3, sent_keys: 100, total_keys: 120 };
        assert!(!p.done());
        let p2 = GrantProgress { sent_batches: 3, total_batches: 3, sent_keys: 120, total_keys: 120 };
        assert!(p2.done());
    }
}
