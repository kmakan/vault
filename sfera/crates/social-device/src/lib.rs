//! Vault Sfera: сертификат устройства и связывание приложений (ADR-006 §8).
//!
//! Модель C: Sfera — отдельное приложение со своим ключом. Приватный ключ
//! мессенджера НЕ копируется. Вместо этого аккаунт подписывает сертификат
//! устройства, который разрешает этому устройству подписывать посты от имени
//! аккаунта. Отзыв = новый bundle без сертификата.
//!
//! Домен подписи отдельный (`sfera-device:v1\0`): сертификат нельзя
//! подделать подписью поста или профиля. Проверка идёт через тот же
//! `social_model::post::verify_with_domain`, то есть второй крипто-стек
//! не заводится.

use social_model::post::{sign_with_domain, verify_with_domain, public_key_hex};
use social_model::{Author, Fingerprint};

/// Отдельный домен подписи: сертификат ≠ пост ≠ профиль (§7.6 ADR-006).
pub const SIGN_DOMAIN: &[u8] = b"sfera-device:v1\0";

/// Что подписывает ключ аккаунта. `device_pub_key` — публичный ключ
/// устройства Sfera (hex, 32 байта), `account_fp` — владелец сертификата.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceCertPayload {
    pub account_fp: Fingerprint,
    pub device_pub_key: String,
    /// Монотонный счётчик: новый сертификат того же устройства должен
    /// перезаписывать старый, а не сосуществовать с ним.
    pub seq: u64,
    /// `true` — сертификат отозван; проверка должна отклонять его.
    #[serde(default)]
    pub revoked: bool,
}

/// Подписанный сертификат устройства.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceCert {
    pub payload: DeviceCertPayload,
    /// Подпись ключом АККАУНТА (не устройства).
    pub sig_hex: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertError {
    BadDeviceKey,
    Revoked,
    WrongAccount,
}

impl DeviceCert {
    /// Выдать сертификат: подпись ключом аккаунта (`account_seed_hex`).
    pub fn issue(
        account_seed_hex: &str,
        account_fp: Fingerprint,
        device_pub_key: impl Into<String>,
        seq: u64,
    ) -> Result<Self, String> {
        let device_pub_key = device_pub_key.into();
        // Проверяем форму ключа устройства на выдаче: подписывать мусор
        // бессмысленно, а получатель всё равно отвергнет сертификат.
        Fingerprint::from_public_key_hex(&device_pub_key)
            .map_err(|e| format!("bad device key: {e}"))?;
        let payload = DeviceCertPayload {
            account_fp,
            device_pub_key,
            seq,
            revoked: false,
        };
        let sig_hex = sign_with_domain(SIGN_DOMAIN, account_seed_hex, &payload)?;
        Ok(Self { payload, sig_hex })
    }

    /// Проверить цепочку: подпись ключом аккаунта, совпадение fp, форма
    /// ключа устройства, отсутствие отзыва.
    pub fn verify(&self, account: &Author) -> Result<(), CertError> {
        if self.payload.revoked {
            return Err(CertError::Revoked);
        }
        if !account.fp.same(&self.payload.account_fp) {
            return Err(CertError::WrongAccount);
        }
        if Fingerprint::from_public_key_hex(&self.payload.device_pub_key).is_err() {
            return Err(CertError::BadDeviceKey);
        }
        if !verify_with_domain(SIGN_DOMAIN, &self.payload, account, &self.sig_hex) {
            return Err(CertError::WrongAccount);
        }
        Ok(())
    }

    /// Отозвать: подпись пересчитывается ключом аккаунта, старый сертификат
    /// остаётся в истории, но проверяться не будет.
    pub fn revoke(&mut self, account_seed_hex: &str) -> Result<(), String> {
        self.payload.revoked = true;
        self.sig_hex = sign_with_domain(SIGN_DOMAIN, account_seed_hex, &self.payload)?;
        Ok(())
    }

    /// Публичный ключ устройства, которым тот подписывает посты.
    pub fn device_pub_key(&self) -> &str {
        &self.payload.device_pub_key
    }
}

/// Собрать `Author` для ключа устройства: fp выводится из того же pub_key,
/// поэтому получатель не может подменить идентификатор устройства.
pub fn device_author(cert: &DeviceCert) -> Result<Author, String> {
    Author::from_public_key_hex(cert.device_pub_key())
}

/// Публичный ключ аккаунта из seed — для проверки сертификата на устройстве
/// без приватного ключа аккаунта.
pub fn account_public_key(account_seed_hex: &str) -> Result<String, String> {
    public_key_hex(account_seed_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "0100000000000000000000000000000000000000000000000000000000000000";
    const DEVICE: &str = "0200000000000000000000000000000000000000000000000000000000000000";
    const OTHER: &str = "0300000000000000000000000000000000000000000000000000000000000000";

    fn account() -> Author {
        Author::from_public_key_hex(&account_public_key(ACCOUNT).unwrap()).unwrap()
    }

    #[test]
    fn issued_cert_verifies() {
        let cert = DeviceCert::issue(ACCOUNT, account().fp, DEVICE, 1).unwrap();
        assert!(cert.verify(&account()).is_ok());
        assert_eq!(cert.device_pub_key(), DEVICE);
    }

    #[test]
    fn other_account_cannot_verify() {
        let cert = DeviceCert::issue(ACCOUNT, account().fp, DEVICE, 1).unwrap();
        let other = Author::from_public_key_hex(OTHER).unwrap();
        assert_eq!(cert.verify(&other), Err(CertError::WrongAccount));
    }

    #[test]
    fn revoked_cert_is_rejected() {
        let mut cert = DeviceCert::issue(ACCOUNT, account().fp, DEVICE, 1).unwrap();
        cert.revoke(ACCOUNT).unwrap();
        assert_eq!(cert.verify(&account()), Err(CertError::Revoked));
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let mut cert = DeviceCert::issue(ACCOUNT, account().fp, DEVICE, 1).unwrap();
        cert.payload.seq = 2;
        assert_eq!(cert.verify(&account()), Err(CertError::WrongAccount));
    }

    #[test]
    fn device_author_comes_from_cert_key() {
        let cert = DeviceCert::issue(ACCOUNT, account().fp, DEVICE, 1).unwrap();
        let author = device_author(&cert).unwrap();
        assert_eq!(author.pub_key, DEVICE);
        assert!(author.fp.same(&Fingerprint::from_public_key_hex(DEVICE).unwrap()));
    }
}
