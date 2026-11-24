//! Vault Sfera: протокол связывания приложений (ADR-006 §8, вариант C).
//!
//! Мессенджер показывает QR `vault://link-sfera?payload=<base64url>`.
//! Bundle подписан ключом аккаунта и содержит публичный ключ, сертификат
//! устройства, контакты с ключами и сферы. Приватный ключ аккаунта НЕ
//! копируется: Sfera получает только подписанный bundle и свой ключ устройства.
//!
//! Никаких секретов в URI: `payload` — подписанный публичный bundle, который
//! можно передать через QR/файл. Подпись отдельным доменом исключает
//! взаимозаменяемость со постом, профилем и сертификатом устройства.

use base64::Engine as _;
use percent_encoding::{percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use social_device::DeviceCert;
use social_model::post::{sign_with_domain, verify_with_domain};
use social_model::{Author, Fingerprint};

/// Домен подписи bundle: отличен от post/profile/device (§8).
pub const LINK_DOMAIN: &[u8] = b"sfera-link:v1\0";
pub const LINK_SCHEME: &str = "vault://link-sfera";

/// Контакт с ключом для переноса графа (без приватного ключа!).
///
/// Ключи шифрования приходят из книги ключей мессенджера (`peer_keys.json`):
/// X25519-публичный и ML-KEM-768 ek. Приватные ключи контакта не покидают его
/// устройство — Sfera получает только публичную половину (ADR-009 §4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkedContact {
    pub fp: Fingerprint,
    pub pub_key: String,
    #[serde(default)]
    pub label: String,
    /// X25519-публичный ключ контакта, hex (32 байта). Пусто — ключа нет.
    #[serde(default)]
    pub x25519_pub: String,
    /// ML-KEM-768 ek контакта, base64. Пусто — PQ-ключа нет.
    #[serde(default)]
    pub pq_ek: String,
    /// Адрес, под которым контакт лежит в книге мессенджера. По нему Sfera
    /// находит получателя, когда отпечаток не совпал (алиас/смена адреса).
    #[serde(default)]
    pub address: String,
}

/// Сфера (группа контактов) для переноса.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkedSphere {
    pub id: String,
    pub members: Vec<Fingerprint>,
}

/// Открытое содержимое bundle. Секретов нет: можно логировать и показывать QR.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkPayload {
    /// Публичный ключ аккаунта, которому доверяет мессенджер.
    pub account: Author,
    /// Сертификат устройства Sfera, подписанный тем же аккаунтом.
    pub device_cert: DeviceCert,
    /// Контакты с публичными ключами.
    #[serde(default)]
    pub contacts: Vec<LinkedContact>,
    /// Сферы.
    #[serde(default)]
    pub spheres: Vec<LinkedSphere>,
    /// Монотонный номер bundle: новый отзывает предыдущий.
    pub seq: u64,
}

/// Подписанный bundle для QR/файла.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkBundle {
    pub payload: LinkPayload,
    pub sig_hex: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkError {
    InvalidJson,
    InvalidBase64,
    BadSignature,
    WrongAccount,
    BadCertificate,
    ExpiredSeq,
}

impl LinkBundle {
    /// Создать bundle: подпись ключом аккаунта (`account_seed_hex`).
    pub fn create(
        account_seed_hex: &str,
        account: Author,
        device_cert: DeviceCert,
        contacts: Vec<LinkedContact>,
        spheres: Vec<LinkedSphere>,
        seq: u64,
    ) -> Result<Self, String> {
        if device_cert.verify(&account).is_err() {
            return Err("device certificate does not match account".into());
        }
        let payload = LinkPayload { account, device_cert, contacts, spheres, seq };
        let sig_hex = sign_with_domain(LINK_DOMAIN, account_seed_hex, &payload)?;
        Ok(Self { payload, sig_hex })
    }

    /// Проверить bundle без приватного ключа: подпись аккаунта + цепочка
    /// сертификата устройства + монотонный seq.
    pub fn verify(&self, expected_seq: u64) -> Result<(), LinkError> {
        if self.payload.seq <= expected_seq {
            return Err(LinkError::ExpiredSeq);
        }
        if !verify_with_domain(LINK_DOMAIN, &self.payload, &self.payload.account, &self.sig_hex) {
            return Err(LinkError::BadSignature);
        }
        if !self.payload.account.fp.same(&self.payload.device_cert.payload.account_fp) {
            return Err(LinkError::WrongAccount);
        }
        self.payload.device_cert
            .verify(&self.payload.account)
            .map_err(|_| LinkError::BadCertificate)
    }
}

/// Закодировать bundle в QR-ссылку `vault://link-sfera?payload=<base64url>`.
pub fn to_uri(bundle: &LinkBundle) -> Result<String, LinkError> {
    let json = serde_json::to_vec(bundle).map_err(|_| LinkError::InvalidJson)?;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    let enc = percent_encode(b64.as_bytes(), NON_ALPHANUMERIC).to_string();
    Ok(format!("{LINK_SCHEME}?payload={enc}"))
}

/// Разобрать QR-ссылку обратно в bundle.
pub fn from_uri(uri: &str) -> Result<LinkBundle, LinkError> {
    let rest = uri.strip_prefix(LINK_SCHEME).ok_or(LinkError::InvalidBase64)?;
    let rest = rest.strip_prefix("?payload=").ok_or(LinkError::InvalidBase64)?;
    let decoded = percent_encoding::percent_decode_str(rest).decode_utf8_lossy();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(decoded.as_bytes())
        .map_err(|_| LinkError::InvalidBase64)?;
    serde_json::from_slice(&bytes).map_err(|_| LinkError::InvalidJson)
}

#[cfg(test)]
mod tests {
    use super::*;
    use social_device::DeviceCert;

    const ACCOUNT: &str = "0100000000000000000000000000000000000000000000000000000000000000";
    const DEVICE: &str = "0200000000000000000000000000000000000000000000000000000000000000";
    const CONTACT: &str = "0300000000000000000000000000000000000000000000000000000000000000";

    fn account() -> Author {
        Author::from_public_key_hex(&social_device::account_public_key(ACCOUNT).unwrap()).unwrap()
    }

    fn bundle(seq: u64) -> LinkBundle {
        let cert = DeviceCert::issue(ACCOUNT, account().fp, DEVICE, 1).unwrap();
        let contact = LinkedContact {
            fp: Fingerprint::from_public_key_hex(CONTACT).unwrap(),
            pub_key: CONTACT.into(),
            label: "Анна".into(),
            x25519_pub: CONTACT.into(),
            pq_ek: "pq-ek".into(),
            address: "anna@example.org".into(),
        };
        LinkBundle::create(
            ACCOUNT, account(), cert, vec![contact.clone()],
            vec![LinkedSphere { id: "family".into(), members: vec![contact.fp.clone()] }],
            seq,
        ).unwrap()
    }

    #[test]
    fn uri_roundtrip_and_verify() {
        let b = bundle(1);
        let uri = to_uri(&b).unwrap();
        assert!(uri.starts_with(LINK_SCHEME));
        let back = from_uri(&uri).unwrap();
        assert_eq!(back, b);
        assert!(back.verify(0).is_ok());
    }

    #[test]
    fn tampered_uri_is_rejected() {
        let uri = to_uri(&bundle(1)).unwrap();
        let tampered = format!("{uri}x");
        assert!(from_uri(&tampered).is_err());
    }

    #[test]
    fn old_seq_is_rejected() {
        let b = bundle(1);
        assert_eq!(b.verify(1), Err(LinkError::ExpiredSeq));
    }

    #[test]
    fn wrong_account_in_bundle_is_rejected() {
        let mut b = bundle(1);
        b.payload.account = Author::from_public_key_hex(CONTACT).unwrap();
        assert!(b.verify(0).is_err());
    }

    #[test]
    fn no_private_key_in_uri() {
        let uri = to_uri(&bundle(1)).unwrap();
        assert!(!uri.contains(ACCOUNT), "seed аккаунта не должен попадать в QR");
        assert!(!uri.contains("private"));
    }
}
