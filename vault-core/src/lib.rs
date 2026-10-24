//! Vault общее крипто-ядро (единый источник истины).
//!
//! Вынесено из дублированных `vault-client/src/crypto/pq.rs` и
//! `vault-desktop/src-tauri/src/crypto_pq.rs` (production-часть была
//! побайтово идентична). Один крейт = одна копия PQ-крипто для всех
//! платформ (CLI/desktop/android). ADR-001/рул «правка не расходится».

/// Длина nonce XChaCha20Poly1305 (24 байта).
pub const NONCE_LEN: usize = 24;

pub mod crypto_pq;
/// Запись группы (`groups.json`) — одна форма для CLI и моста десктопа.
/// Раньше структуры были продублированы, и у ядра не было поля `fingerprint`:
/// участник, сменивший почту, был «своим» только для десктопа.
pub mod group_types;
/// Форма адреса и предикаты «эта запись моя» — одно правило для хранилища
/// ключей и для `vault-client` (он реэкспортирует этот модуль как
/// `vault::identity`). Здесь, а не в `vault-client`, потому что обратная
/// зависимость дала бы цикл.
pub mod identity;
pub mod key_store;
pub mod key_store_types;
/// Тумблеры возможностей: дефолт «пользователь не выбирал» — одно правило для
/// десктопа, Android и тестов (ADR-005).
pub mod settings;
/// План доставки (почта/релей) для сообщения и для сигналов звонка — одно
/// правило на оба случая.
pub mod transport;
pub use key_store_types::{KeyStoreMetadata, StoredKeyPair, StoredPeerKey};
