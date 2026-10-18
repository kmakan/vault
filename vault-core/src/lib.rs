//! Vault общее крипто-ядро (единый источник истины).
//!
//! Вынесено из дублированных `vault-client/src/crypto/pq.rs` и
//! `vault-desktop/src-tauri/src/crypto_pq.rs` (production-часть была
//! побайтово идентична). Один крейт = одна копия PQ-крипто для всех
//! платформ (CLI/desktop/android). ADR-001/рул «правка не расходится».

/// Длина nonce XChaCha20Poly1305 (24 байта).
pub const NONCE_LEN: usize = 24;

pub mod crypto_pq;
