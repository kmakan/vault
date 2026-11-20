//! Подпись поста Sfera — протокольное решение, поэтому в Rust.
//!
//! Подписывается канонический JSON (JCS) поста БЕЗ поля `sig`: иначе подпись
//! была бы «самозависимой». Домен (`sfera-post:v1\0`) отделяет подпись поста от
//! подписи канала мессенджера (`channel-post:v2\0`) — один и тот же ключ не
//! должен создавать взаимозаменяемые подписи для разных протоколов.
//!
//! Алгоритм — ed25519-dalek v2 с `verify_strict`, как в мессенджере
//! (`vault-desktop/src-tauri/src/channel_signing.rs`), не второй вариант.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::canonical::canonical_bytes;
use crate::{Author, Fingerprint};

/// Домен подписи поста Sfera. Не менять без мажорной версии формата.
pub const SIGN_DOMAIN: &[u8] = b"sfera-post:v1\0";

/// Тело поста для подписи. `sig` намеренно отсутствует — подпись считается по
/// этой форме, а потом кладётся рядом как поле `sig` конверта.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PostPayload {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub author: Author,
    pub ts: u64,
    pub body: String,
}

/// Байты, которые подписываются: произвольный домен ‖ канонический JSON.
///
/// Домен передаётся явно, чтобы пост (`sfera-post:v1\0`) и профиль
/// (`sfera-profile:v1\0`) не делили подписи: один и тот же ключ не должен
/// создавать взаимозаменяемые подписи для разных типов объектов.
pub fn signing_input_with_domain<T: serde::Serialize>(
    domain: &[u8],
    value: &T,
) -> Result<Vec<u8>, String> {
    let json = canonical_bytes(value)?;
    let mut buf = Vec::with_capacity(domain.len() + json.len());
    buf.extend_from_slice(domain);
    buf.extend_from_slice(&json);
    Ok(buf)
}

/// Байты подписи поста (домен `SIGN_DOMAIN`).
pub fn signing_input_value<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, String> {
    signing_input_with_domain(SIGN_DOMAIN, value)
}

/// Байты подписи простого `PostPayload` (совместимая обёртка).
pub fn signing_input(payload: &PostPayload) -> Result<Vec<u8>, String> {
    signing_input_value(payload)
}

/// Подписать значение в заданном домене.
pub fn sign_with_domain<T: serde::Serialize>(
    domain: &[u8],
    seed_hex: &str,
    value: &T,
) -> Result<String, String> {
    let seed = hex_to_32(seed_hex)?;
    let sk = SigningKey::from_bytes(&seed);
    let sig = sk.sign(&signing_input_with_domain(domain, value)?);
    Ok(hex::encode(sig.to_bytes()))
}

/// Подписать значение доменом поста.
pub fn sign_value<T: serde::Serialize>(seed_hex: &str, value: &T) -> Result<String, String> {
    sign_with_domain(SIGN_DOMAIN, seed_hex, value)
}

/// Подписать тело простого поста.
pub fn sign(seed_hex: &str, payload: &PostPayload) -> Result<String, String> {
    sign_value(seed_hex, payload)
}

/// Публичный ключ (hex) из приватного — для публикации в `Author.pub_key`.
pub fn public_key_hex(seed_hex: &str) -> Result<String, String> {
    let seed = hex_to_32(seed_hex)?;
    let sk = SigningKey::from_bytes(&seed);
    Ok(hex::encode(sk.verifying_key().to_bytes()))
}

/// Проверка подписи и согласованности автора.
///
/// Порядок важен (каждое условие — отдельная проверка в тестах):
/// 1. `sig` — ровно 64 байта hex, иначе отказ (не «любая подпись»).
/// 2. `author.pub_key` — 32 байта hex, иначе отказ.
/// 3. `author.fp` = отпечаток из `author.pub_key`: нельзя подписаться одним
///    ключом, а назваться другим fingerprint.
/// 4. Подпись проверяется `verify_strict` по каноническому JSON.payload.
pub fn verify_with_domain<T: serde::Serialize>(
    domain: &[u8],
    value: &T,
    author: &Author,
    sig_hex: &str,
) -> bool {
    let sig_raw = match hex::decode(sig_hex.trim()) {
        Ok(v) => v,
        Err(_) => return false,
    };
    if sig_raw.len() != 64 {
        return false;
    }
    let Ok(sig) = Signature::from_slice(&sig_raw) else {
        return false;
    };

    let pk_raw = match hex::decode(author.pub_key.trim()) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Ok(pk) = <[u8; 32]>::try_from(pk_raw.as_slice()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };

    // fp обязан выводиться из того же pub_key, которым проверяется подпись.
    let derived_fp = match Fingerprint::from_public_key_hex(&author.pub_key) {
        Ok(fp) => fp,
        Err(_) => return false,
    };
    if !author.fp.same(&derived_fp) {
        return false;
    }

    let Ok(input) = signing_input_with_domain(domain, value) else {
        return false;
    };
    vk.verify_strict(&input, &sig).is_ok()
}

/// Проверка подписи значением домена поста.
pub fn verify_value<T: serde::Serialize>(value: &T, author: &Author, sig_hex: &str) -> bool {
    verify_with_domain(SIGN_DOMAIN, value, author, sig_hex)
}

/// Проверка подписи простого поста (совместимая обёртка).
pub fn verify(payload: &PostPayload, sig_hex: &str) -> bool {
    verify_value(payload, &payload.author, sig_hex)
}

fn hex_to_32(s: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(s.trim()).map_err(|e| format!("invalid hex seed: {e}"))?;
    <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| "seed must be 32 bytes".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Fingerprint, FORMAT_VERSION};

    const SEED_A: &str = "0100000000000000000000000000000000000000000000000000000000000000";
    const SEED_B: &str = "0200000000000000000000000000000000000000000000000000000000000000";

    fn payload(body: &str) -> PostPayload {
        let pub_key = public_key_hex(SEED_A).unwrap();
        PostPayload {
            v: FORMAT_VERSION,
            kind: "social_post".to_string(),
            author: Author::from_public_key_hex(&pub_key).unwrap(),
            ts: 1795000000,
            body: body.to_string(),
        }
    }

    #[test]
    fn sign_then_verify() {
        let p = payload("привет");
        let sig = sign(SEED_A, &p).unwrap();
        assert!(verify(&p, &sig));
    }

    #[test]
    fn tampered_body_is_rejected() {
        let p = payload("привет");
        let sig = sign(SEED_A, &p).unwrap();
        let mut evil = p.clone();
        evil.body = "привет!".to_string();
        assert!(!verify(&evil, &sig));
    }

    #[test]
    fn tampered_timestamp_is_rejected() {
        let p = payload("привет");
        let sig = sign(SEED_A, &p).unwrap();
        let mut evil = p.clone();
        evil.ts += 1;
        assert!(!verify(&evil, &sig));
    }

    #[test]
    fn other_key_cannot_verify() {
        let p = payload("привет");
        let sig_b = sign(SEED_B, &p).unwrap();
        assert!(!verify(&p, &sig_b));
    }

    #[test]
    fn mismatched_author_fingerprint_is_rejected() {
        // Подписались ключом A, а author.fp подменили на B.
        let p = payload("привет");
        let sig = sign(SEED_A, &p).unwrap();
        let mut evil = p.clone();
        evil.author.fp = Fingerprint::from_public_key_hex(&public_key_hex(SEED_B).unwrap()).unwrap();
        assert!(!verify(&evil, &sig));
    }

    #[test]
    fn bad_signature_length_is_rejected() {
        let p = payload("привет");
        assert!(!verify(&p, "deadbeef"));
        assert!(!verify(&p, "zzzz"));
    }

    #[test]
    fn domain_separation_is_in_signing_input() {
        // Подпись не должна совпасть с «голым» JCS — домен реально участвует.
        let p = payload("привет");
        let input = signing_input(&p).unwrap();
        let json = canonical_bytes(&p).unwrap();
        assert!(input.starts_with(SIGN_DOMAIN));
        assert_eq!(&input[SIGN_DOMAIN.len()..], json.as_slice());
    }
}
