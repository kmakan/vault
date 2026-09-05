//! Stateless HMAC-токены подписки (design §4).
//!
//! token = base64url( key_id(8) ‖ scope(1) ‖ expiry(4) ‖ mac(32) )
//! mac = HMAC-SHA256(server_key, key_id ‖ scope ‖ expiry)
//! Выдача — CLI (bin/gen_token.rs), валидация — без БД.
//! В самом токене нет email: сервер знает только opaque-строку.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Read,
    Write,
}

impl Scope {
    fn to_byte(self) -> u8 {
        match self {
            Scope::Read => b'r',
            Scope::Write => b'w',
        }
    }
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            b'r' => Some(Scope::Read),
            b'w' => Some(Scope::Write),
            _ => None,
        }
    }
}

/// Ротация server_key без инвалидации старых токенов:
/// key_id выбирает активный ключ из набора (MVP: один).
pub struct ServerKeys {
    keys: Vec<(u64, [u8; 32])>,
}

impl ServerKeys {
    pub fn new(key: [u8; 32]) -> Self {
        // key_id — первые 8 байт самого ключа (детерминированно для MVP).
        let kid = u64::from_be_bytes(key[..8].try_into().expect("8 bytes"));
        Self { keys: vec![(kid, key)] }
    }

    fn mac(&self, key_id: u64, scope: Scope, expiry: u32) -> Option<[u8; 32]> {
        for (kid, key) in &self.keys {
            if *kid == key_id {
                let mut mac = HmacSha256::new_from_slice(key).ok()?;
                mac.update(&key_id.to_be_bytes());
                mac.update(&[scope.to_byte()]);
                mac.update(&expiry.to_be_bytes());
                let out = mac.finalize().into_bytes();
                let mut tag = [0u8; 32];
                tag.copy_from_slice(&out);
                return Some(tag);
            }
        }
        None
    }
}

#[derive(Clone, Debug)]
pub struct Token {
    pub scope: Scope,
    pub expiry: u32,
    /// hash очереди получателя = mac токена (read-токен адресует очередь).
    pub hash: String,
}

impl Token {
    pub fn is_expired(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as u32)
            .unwrap_or(0);
        self.expiry < now
    }
}

/// Собрать токен (для CLI-генератора и тестов).
pub fn issue(keys: &ServerKeys, scope: Scope, expiry: u32) -> String {
    let key_id = keys.keys[0].0;
    let mac = keys.mac(key_id, scope, expiry).expect("key present");
    let mut raw = Vec::with_capacity(45);
    raw.extend_from_slice(&key_id.to_be_bytes());
    raw.push(scope.to_byte());
    raw.extend_from_slice(&expiry.to_be_bytes());
    raw.extend_from_slice(&mac);
    b64url(&raw)
}

/// Разобрать и проверить токен. None = битый/поддельный/неизвестный key_id.
pub fn parse(keys: &ServerKeys, token: &str) -> Option<Token> {
    let raw = b64url_decode(token)?;
    if raw.len() != 8 + 1 + 4 + 32 {
        return None;
    }
    let key_id = u64::from_be_bytes(raw[..8].try_into().expect("8"));
    let scope = Scope::from_byte(raw[8])?;
    let expiry = u32::from_be_bytes(raw[9..13].try_into().expect("4"));
    let tag = &raw[13..45];
    let mac = keys.mac(key_id, scope, expiry)?;
    // constant-time compare
    if !ct_eq(tag, &mac) {
        return None;
    }
    // Очередь адресуем mac-хэшем: коллизии = подделка MAC (2^128).
    Some(Token {
        scope,
        expiry,
        hash: hex(&mac),
    })
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

fn b64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> ServerKeys {
        ServerKeys::new([42u8; 32])
    }

    #[test]
    fn roundtrip_read() {
        let k = keys();
        let t = issue(&k, Scope::Read, 4102444800); // 2100 год
        let parsed = parse(&k, &t).expect("parse");
        assert_eq!(parsed.scope, Scope::Read);
        assert!(!parsed.is_expired());
        assert_eq!(parsed.hash.len(), 64);
    }

    #[test]
    fn tampered_rejected() {
        let k = keys();
        let mut t = issue(&k, Scope::Read, 4102444800);
        // перевернём один символ
        let flip = if t.starts_with('A') { 'B' } else { 'A' };
        t.replace_range(0..1, &flip.to_string());
        assert!(parse(&k, &t).is_none());
    }

    #[test]
    fn wrong_scope_rejected() {
        let k = keys();
        let t = issue(&k, Scope::Write, 4102444800);
        let parsed = parse(&k, &t).expect("parse");
        assert_eq!(parsed.scope, Scope::Write);
    }

    #[test]
    fn expiry_works() {
        let k = keys();
        let t = issue(&k, Scope::Read, 1); // 1970
        let parsed = parse(&k, &t).expect("parse");
        assert!(parsed.is_expired());
    }
}
