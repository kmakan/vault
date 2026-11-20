//! Vault Sfera: формат зашифрованного append-only репозитория (ADR-006 §7.4).
//!
//! MVP может жить без репозитория, но формат блока и подпись устройства
//! закладываются сразу, чтобы потом не переделывать манифест.
//!
//! Инварианты:
//! - блок ссылается на хеш предыдущего (`prev`), поэтому цепочка не рвётся
//!   молча: подмена/удаление блока ломает проверку;
//! - подпись — ключом УСТРОЙСТВА (не аккаунта), проверяется через сертификат;
//! - `head` — последний блок; новый клиент читает цепочку от head назад;
//! - содержимое блока — уже зашифрованный конверт, репозиторий его не читает.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use social_device::{device_author, DeviceCert};
use social_model::post::{sign_with_domain, verify_with_domain};
use social_model::Author;

/// Домен подписи блока: отдельный от поста/профиля/сертификата/связывания.
pub const SIGN_DOMAIN: &[u8] = b"sfera-repo:v1\0";

/// Что лежит в блоке. `ciphertext` — уже зашифрованный конверт (E2E),
/// репозиторий его не расшифровывает и не интерпретирует.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoBlockPayload {
    /// Хеш предыдущего блока (hex). `None` — первый блок.
    pub prev: Option<String>,
    /// Монотонный номер: 0, 1, 2… Порядок не зависит от часов устройства.
    pub seq: u64,
    /// Тип записи: `post`, `profile`, `sphere`, `contact`.
    pub kind: String,
    /// Зашифрованное содержимое (base64/armored), как его отдаёт E2E-слой.
    pub ciphertext: String,
    /// Метка времени создания блока (не доверенная, только для UI).
    pub ts: u64,
}

/// Подписанный блок репозитория.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoBlock {
    pub payload: RepoBlockPayload,
    /// Публичный ключ устройства, которым подписан блок.
    pub device_pub_key: String,
    pub sig_hex: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoError {
    BadSignature,
    BrokenChain,
    WrongSeq,
    BadDeviceKey,
}

impl RepoBlock {
    /// Хеш блока — то, на что ссылается следующий (`prev`).
    pub fn hash(&self) -> String {
        let json = serde_json::to_vec(self).unwrap_or_default();
        hex::encode(Sha256::digest(&json))
    }

    /// Создать блок, подписав его ключом устройства.
    pub fn create(
        device_seed_hex: &str,
        device_pub_key: impl Into<String>,
        prev: Option<String>,
        seq: u64,
        kind: impl Into<String>,
        ciphertext: impl Into<String>,
        ts: u64,
    ) -> Result<Self, String> {
        let device_pub_key = device_pub_key.into();
        Author::from_public_key_hex(&device_pub_key)
            .map_err(|e| format!("bad device key: {e}"))?;
        let payload = RepoBlockPayload {
            prev,
            seq,
            kind: kind.into(),
            ciphertext: ciphertext.into(),
            ts,
        };
        let sig_hex = sign_with_domain(SIGN_DOMAIN, device_seed_hex, &payload)?;
        Ok(Self { payload, device_pub_key, sig_hex })
    }

    /// Проверить один блок: подпись устройства и форму ключа.
    pub fn verify(&self) -> Result<(), RepoError> {
        let author = Author::from_public_key_hex(&self.device_pub_key)
            .map_err(|_| RepoError::BadDeviceKey)?;
        if !verify_with_domain(SIGN_DOMAIN, &self.payload, &author, &self.sig_hex) {
            return Err(RepoError::BadSignature);
        }
        Ok(())
    }
}

/// Цепочка блоков от первого к последнему. `head` — последний блок.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoChain {
    pub blocks: Vec<RepoBlock>,
}

impl RepoChain {
    pub fn new() -> Self {
        Self::default()
    }

    /// Последний блок — то, что клиент читает первым при синхронизации.
    pub fn head(&self) -> Option<&RepoBlock> {
        self.blocks.last()
    }

    pub fn head_hash(&self) -> Option<String> {
        self.head().map(|b| b.hash())
    }

    /// Добавить блок: проверка подписи, непрерывности `prev` и `seq`.
    pub fn append(&mut self, block: RepoBlock) -> Result<(), RepoError> {
        block.verify()?;
        let expected_prev = self.head_hash();
        if block.payload.prev != expected_prev {
            return Err(RepoError::BrokenChain);
        }
        let expected_seq = self.blocks.len() as u64;
        if block.payload.seq != expected_seq {
            return Err(RepoError::WrongSeq);
        }
        self.blocks.push(block);
        Ok(())
    }

    /// Проверить всю цепочку целиком (новый клиент после загрузки с диска).
    pub fn verify_all(&self) -> Result<(), RepoError> {
        let mut prev: Option<String> = None;
        for (i, block) in self.blocks.iter().enumerate() {
            block.verify()?;
            if block.payload.prev != prev {
                return Err(RepoError::BrokenChain);
            }
            if block.payload.seq != i as u64 {
                return Err(RepoError::WrongSeq);
            }
            prev = Some(block.hash());
        }
        Ok(())
    }

    /// Проверить, что цепочка выпущена устройством с валидным сертификатом.
    pub fn verify_device(&self, cert: &DeviceCert, account: &Author) -> Result<(), RepoError> {
        cert.verify(account).map_err(|_| RepoError::BadDeviceKey)?;
        let expected = device_author(cert).map_err(|_| RepoError::BadDeviceKey)?;
        for block in &self.blocks {
            if block.device_pub_key != expected.pub_key {
                return Err(RepoError::BadDeviceKey);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use social_device::DeviceCert;

    const ACCOUNT: &str = "0100000000000000000000000000000000000000000000000000000000000000";
    const DEVICE: &str = "0200000000000000000000000000000000000000000000000000000000000000";
    const OTHER_DEVICE: &str = "0300000000000000000000000000000000000000000000000000000000000000";

    fn account() -> Author {
        Author::from_public_key_hex(&social_device::account_public_key(ACCOUNT).unwrap()).unwrap()
    }

    fn device_pub(seed: &str) -> String {
        social_device::account_public_key(seed).unwrap()
    }

    fn block(prev: Option<String>, seq: u64, seed: &str) -> RepoBlock {
        RepoBlock::create(seed, device_pub(seed), prev, seq, "post", format!("CT{seq}"), 100 + seq).unwrap()
    }

    #[test]
    fn chain_appends_and_verifies() {
        let mut chain = RepoChain::new();
        chain.append(block(None, 0, DEVICE)).unwrap();
        let h0 = chain.head_hash().unwrap();
        chain.append(block(Some(h0), 1, DEVICE)).unwrap();
        assert_eq!(chain.blocks.len(), 2);
        assert!(chain.verify_all().is_ok());
    }

    #[test]
    fn broken_prev_is_rejected() {
        let mut chain = RepoChain::new();
        chain.append(block(None, 0, DEVICE)).unwrap();
        let err = chain.append(block(Some("deadbeef".into()), 1, DEVICE)).unwrap_err();
        assert_eq!(err, RepoError::BrokenChain);
    }

    #[test]
    fn wrong_seq_is_rejected() {
        let mut chain = RepoChain::new();
        let err = chain.append(block(None, 5, DEVICE)).unwrap_err();
        assert_eq!(err, RepoError::WrongSeq);
    }

    #[test]
    fn tampered_ciphertext_breaks_signature() {
        let mut chain = RepoChain::new();
        let mut b = block(None, 0, DEVICE);
        b.payload.ciphertext = "EVIL".into();
        assert_eq!(chain.append(b).unwrap_err(), RepoError::BadSignature);
    }

    #[test]
    fn chain_from_other_device_fails_cert_check() {
        let mut chain = RepoChain::new();
        chain.append(block(None, 0, OTHER_DEVICE)).unwrap();
        let cert = DeviceCert::issue(ACCOUNT, account().fp, &device_pub(DEVICE), 1).unwrap();
        assert_eq!(chain.verify_device(&cert, &account()).unwrap_err(), RepoError::BadDeviceKey);
    }

    #[test]
    fn chain_from_certified_device_passes() {
        let mut chain = RepoChain::new();
        chain.append(block(None, 0, DEVICE)).unwrap();
        let cert = DeviceCert::issue(ACCOUNT, account().fp, &device_pub(DEVICE), 1).unwrap();
        assert!(chain.verify_device(&cert, &account()).is_ok());
    }
}
