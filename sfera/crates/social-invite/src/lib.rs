//! Vault Sfera: отзываемые capability-приглашения (ADR-006 §4.1).
//!
//! Ссылка-приглашение содержит fingerprint и публичный ключ владельца,
//! но НЕ приватный ключ и не пароль. Её можно отозвать и перевыпустить:
//! отзыв = удаление секрета из локального реестра, а не «ожидание сервера».
//!
//! `code` — неугадываемый токен (SHA-256 от случайного seed, пришедшего
//! извне). Ядро не генерирует случайность само: время и entropy приходят
//! аргументом, поэтому поведение детерминировано и тестируемо.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use social_model::Fingerprint;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invite {
    pub code: String,
    pub owner_fp: Fingerprint,
    pub owner_pub_key: String,
    /// `0` — бессрочное; иначе unix-время окончания (приходит аргументом).
    pub expires_at: u64,
    pub revoked: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InviteBook {
    invites: Vec<Invite>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InviteError {
    Revoked,
    Expired,
    Unknown,
}

impl Invite {
    /// Создать приглашение из внешнего seed. `code` — hex SHA-256(seed).
    pub fn new(
        seed: &[u8],
        owner_fp: Fingerprint,
        owner_pub_key: impl Into<String>,
        expires_at: u64,
    ) -> Result<Self, String> {
        let pub_key = owner_pub_key.into();
        // fp обязан выводиться из того же публичного ключа: нельзя
        // пригласить от чужого имени, подменив идентификатор.
        let derived = Fingerprint::from_public_key_hex(&pub_key)
            .map_err(|e| format!("bad owner key: {e}"))?;
        if !derived.same(&owner_fp) {
            return Err("fingerprint does not match public key".into());
        }
        Ok(Self {
            code: hex::encode(Sha256::digest(seed)),
            owner_fp,
            owner_pub_key: pub_key,
            expires_at,
            revoked: false,
        })
    }

    pub fn valid(&self, now: u64) -> Result<(), InviteError> {
        if self.revoked {
            return Err(InviteError::Revoked);
        }
        if self.expires_at > 0 && now >= self.expires_at {
            return Err(InviteError::Expired);
        }
        Ok(())
    }
}

impl InviteBook {
    pub fn issue(&mut self, invite: Invite) -> String {
        let code = invite.code.clone();
        self.invites.push(invite);
        code
    }

    /// Найти валидное приглашение по коду. Время приходит аргументом.
    pub fn valid_invite(&self, code: &str, now: u64) -> Result<&Invite, InviteError> {
        let invite = self
            .invites
            .iter()
            .find(|i| i.code == code)
            .ok_or(InviteError::Unknown)?;
        invite.valid(now)?;
        Ok(invite)
    }

    /// Отозвать: код остаётся в истории, но больше не проходит проверку.
    pub fn revoke(&mut self, code: &str) -> bool {
        match self.invites.iter_mut().find(|i| i.code == code) {
            Some(invite) => {
                invite.revoked = true;
                true
            }
            None => false,
        }
    }

    pub fn active_count(&self, now: u64) -> usize {
        self.invites
            .iter()
            .filter(|i| i.valid(now).is_ok())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0200000000000000000000000000000000000000000000000000000000000000";

    fn owner() -> Fingerprint {
        Fingerprint::from_public_key_hex(KEY).unwrap()
    }

    fn invite(expires: u64) -> Invite {
        Invite::new(b"random-seed", owner(), KEY, expires).unwrap()
    }

    #[test]
    fn invite_is_valid_until_revoked() {
        let mut book = InviteBook::default();
        let code = book.issue(invite(0));
        assert!(book.valid_invite(&code, 100).is_ok());
        assert!(book.revoke(&code));
        assert_eq!(book.valid_invite(&code, 100).unwrap_err(), InviteError::Revoked);
    }

    #[test]
    fn expired_invite_is_rejected() {
        let mut book = InviteBook::default();
        let code = book.issue(invite(200));
        assert!(book.valid_invite(&code, 199).is_ok());
        assert_eq!(book.valid_invite(&code, 200).unwrap_err(), InviteError::Expired);
    }

    #[test]
    fn unknown_code_is_typed_error() {
        let book = InviteBook::default();
        assert_eq!(book.valid_invite("nope", 0).unwrap_err(), InviteError::Unknown);
    }

    #[test]
    fn fingerprint_must_match_key() {
        let other = Fingerprint::from_public_key_hex(
            "0300000000000000000000000000000000000000000000000000000000000000",
        ).unwrap();
        assert!(Invite::new(b"seed", other, KEY, 0).is_err());
    }

    #[test]
    fn active_count_excludes_revoked_and_expired() {
        let mut book = InviteBook::default();
        let a = book.issue(invite(0));
        let b = book.issue(invite(50));
        assert_eq!(book.active_count(10), 2);
        book.revoke(&a);
        assert_eq!(book.active_count(10), 1);
        assert_eq!(book.active_count(100), 0);
        assert_eq!(b.len(), 64, "code — hex SHA-256");
    }
}
