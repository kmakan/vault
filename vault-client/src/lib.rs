#![allow(dead_code)] // Infrastructure code — used in later phases

//! Vault client library — reusable modules shared between the CLI binary
//! and integration tests (email e2e, crypto roundtrips).

pub mod api;
pub mod crypto;
pub mod storage;
pub mod vault;
