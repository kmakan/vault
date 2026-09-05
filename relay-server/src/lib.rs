//! vault-relay library: модули, общие для сервера и CLI-генератора токенов.

pub mod rate;
pub mod store;
pub mod tokens;

pub use tokens::{issue, parse, Scope, ServerKeys, Token};
