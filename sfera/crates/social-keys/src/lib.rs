//! Vault Sfera: ключи шифрования Sfera (ADR-006 §7.6, ADR-009 §4).
//!
//! Sfera — отдельное приложение со СВОИМ ключом шифрования. Приватный ключ
//! мессенджера между приложениями не копируется: копия приватного ключа —
//! худший класс утечки (ADR-006 §8), а X25519-секрет мессенджера вообще нельзя
//! использовать как seed подписи (ADR-009 §1). Поэтому:
//!
//! - идентичность аккаунта — Ed25519-ключ подписи (`vault-core::account_signing`);
//! - шифрование профилей и адресных конвертов — СВОЙ X25519 + ML-KEM-768 ключ,
//!   который создаётся при первом запуске Sfera и лежит в её каталоге данных;
//! - из bundle связывания Sfera берёт только ПУБЛИЧНЫЕ ключи контактов.
//!
//! Файл `encryption.json` — приватные ключи, права 0600, атомарная запись
//! (временный файл + rename), чтобы обрыв записи не оставил половину ключа.

use base64::Engine as _;
use ml_kem::kem::KeyExport;
use serde::{Deserialize, Serialize};
use social_delivery::SenderKeyMaterial;
use social_model::Fingerprint;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Имя файла ключей шифрования Sfera в каталоге данных приложения.
pub const ENCRYPTION_FILE: &str = "encryption.json";

#[derive(Debug)]
pub enum KeyError {
    /// Не удалось прочитать/записать файл ключей.
    Io(String),
    /// Файл есть, но не разбирается или в нём не те ключи.
    Corrupt(String),
    /// Ключ неверной длины/формата.
    BadKey(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(m) => write!(f, "key file io: {m}"),
            Self::Corrupt(m) => write!(f, "key file corrupt: {m}"),
            Self::BadKey(m) => write!(f, "bad key: {m}"),
        }
    }
}

impl std::error::Error for KeyError {}

/// Форма файла `encryption.json`. Приватные поля помечены, чтобы случайный
/// `Debug`/лог не напечатал секрет.
#[derive(Clone, Serialize, Deserialize)]
struct StoredKeys {
    /// Версия формата: позволяет сменить раскладку без догадок.
    v: u32,
    /// X25519-приватный ключ, hex (32 байта).
    x25519_private_hex: String,
    /// ML-KEM-768 seed, hex (64 байта).
    pq_seed_hex: String,
}

impl fmt::Debug for StoredKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredKeys")
            .field("v", &self.v)
            .field("x25519_private_hex", &"<redacted>")
            .field("pq_seed_hex", &"<redacted>")
            .finish()
    }
}

/// Идентичность шифрования Sfera: свой X25519 + свой ML-KEM-768.
#[derive(Clone)]
pub struct EncryptionIdentity {
    x25519_private_hex: String,
    pq_seed_hex: String,
    /// X25519-публичный ключ, hex — он же отпечаток адресата в конвертах.
    x25519_public_hex: String,
    /// ML-KEM-768 ek, base64 — публикуется в bundle/профиле.
    pq_ek_b64: String,
}

impl fmt::Debug for EncryptionIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptionIdentity")
            .field("x25519_private_hex", &"<redacted>")
            .field("pq_seed_hex", &"<redacted>")
            .field("x25519_public_hex", &self.x25519_public_hex)
            .field("pq_ek_b64", &self.pq_ek_b64)
            .finish()
    }
}

impl EncryptionIdentity {
    /// Собрать идентичность из приватных частей. Публичные выводятся из них,
    /// а не хранятся отдельно: две копии одного ключа рано или поздно разойдутся.
    pub fn from_secrets(x25519_private_hex: &str, pq_seed_hex: &str) -> Result<Self, KeyError> {
        let secret_bytes = hex::decode(x25519_private_hex)
            .map_err(|_| KeyError::BadKey("x25519 private is not hex".into()))?;
        let secret: [u8; 32] = secret_bytes
            .try_into()
            .map_err(|_| KeyError::BadKey("x25519 private must be 32 bytes".into()))?;
        let secret = x25519_dalek::StaticSecret::from(secret);
        let public = x25519_dalek::PublicKey::from(&secret);

        let (_, ek) = vault_core::crypto_pq::pq_from_seed(pq_seed_hex)
            .ok_or_else(|| KeyError::BadKey("pq seed is not a valid ML-KEM seed".into()))?;
        // Тот же формат, что у `pq_generate`: байтовая кодировка модуля в base64.
        let pq_ek_b64 =
            base64::engine::general_purpose::STANDARD.encode(ek.to_bytes().as_slice());

        Ok(Self {
            x25519_private_hex: x25519_private_hex.to_string(),
            pq_seed_hex: pq_seed_hex.to_string(),
            x25519_public_hex: hex::encode(public.as_bytes()),
            pq_ek_b64,
        })
    }

    /// Сгенерировать новую пару. `entropy` — 32 байта из ОС: ядро детерминировано
    /// и само случайность не берёт, её подаёт оболочка.
    pub fn generate(entropy: [u8; 32]) -> Result<Self, KeyError> {
        let secret = x25519_dalek::StaticSecret::from(entropy);
        let public = x25519_dalek::PublicKey::from(&secret);
        let pq = vault_core::crypto_pq::pq_generate();
        Ok(Self {
            x25519_private_hex: hex::encode(secret.to_bytes()),
            pq_seed_hex: pq.seed_hex,
            x25519_public_hex: hex::encode(public.as_bytes()),
            pq_ek_b64: pq.ek_b64,
        })
    }

    /// X25519-публичный ключ, hex. Он же адрес конверта (`SealedEnvelope::to`).
    pub fn x25519_public_hex(&self) -> &str {
        &self.x25519_public_hex
    }

    /// ML-KEM-768 ek, base64.
    pub fn pq_ek_b64(&self) -> &str {
        &self.pq_ek_b64
    }

    /// Отпечаток шифрования: X25519-публичный ключ в форме `Fingerprint`.
    /// Это НЕ идентичность аккаунта (та — Ed25519, ADR-009 §2), а адрес
    /// доставки конвертов.
    pub fn fingerprint(&self) -> Result<Fingerprint, KeyError> {
        Fingerprint::from_public_key_hex(&self.x25519_public_hex)
            .map_err(|e| KeyError::BadKey(format!("fingerprint: {e}")))
    }

    /// Приватный материал отправителя для `social_delivery::seal_payload`.
    pub fn sender_material(&self) -> SenderKeyMaterial {
        SenderKeyMaterial {
            x25519_private_hex: self.x25519_private_hex.clone(),
            pq_seed_hex: Some(self.pq_seed_hex.clone()),
        }
    }

    /// Приватный X25519-ключ, hex — только для `open_payload` на своей стороне.
    pub fn x25519_private_hex(&self) -> &str {
        &self.x25519_private_hex
    }

    /// ML-KEM seed, hex — только для `open_payload` на своей стороне.
    pub fn pq_seed_hex(&self) -> &str {
        &self.pq_seed_hex
    }
}

/// Путь к файлу ключей в каталоге данных.
pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir.join(ENCRYPTION_FILE)
}

/// Загрузить идентичность, создав её при первом запуске.
///
/// Идемпотентно: если файл есть и цел — возвращается он же, новый ключ НЕ
/// создаётся (иначе каждый запуск ломал бы ранее выданные конверты).
pub fn load_or_create_at(data_dir: &Path, entropy: [u8; 32]) -> Result<EncryptionIdentity, KeyError> {
    let path = path_in(data_dir);
    if path.exists() {
        return load_at(data_dir);
    }
    let identity = EncryptionIdentity::generate(entropy)?;
    save_at(data_dir, &identity)?;
    Ok(identity)
}

/// Прочитать существующий файл. Ошибка, если файла нет: молча создавать новый
/// ключ на месте «битого» нельзя — это потеря доступа к старым конвертам.
pub fn load_at(data_dir: &Path) -> Result<EncryptionIdentity, KeyError> {
    let path = path_in(data_dir);
    let raw = fs::read_to_string(&path)
        .map_err(|e| KeyError::Io(format!("{}: {e}", path.display())))?;
    let stored: StoredKeys = serde_json::from_str(&raw)
        .map_err(|e| KeyError::Corrupt(format!("{}: {e}", path.display())))?;
    if stored.v != 1 {
        return Err(KeyError::Corrupt(format!("unsupported version {}", stored.v)));
    }
    EncryptionIdentity::from_secrets(&stored.x25519_private_hex, &stored.pq_seed_hex)
}

/// Записать идентичность атомарно и с правами 0600.
pub fn save_at(data_dir: &Path, identity: &EncryptionIdentity) -> Result<(), KeyError> {
    fs::create_dir_all(data_dir)
        .map_err(|e| KeyError::Io(format!("{}: {e}", data_dir.display())))?;
    let path = path_in(data_dir);
    let stored = StoredKeys {
        v: 1,
        x25519_private_hex: identity.x25519_private_hex.clone(),
        pq_seed_hex: identity.pq_seed_hex.clone(),
    };
    let body = serde_json::to_string_pretty(&stored)
        .map_err(|e| KeyError::Io(format!("serialize: {e}")))?;

    // Атомарность: пишем во временный файл рядом и переименовываем. Обрыв
    // посреди записи не оставит половину ключа на месте целого.
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| KeyError::Io(format!("{}: {e}", tmp.display())))?;
        f.write_all(body.as_bytes())
            .map_err(|e| KeyError::Io(format!("{}: {e}", tmp.display())))?;
        f.sync_all()
            .map_err(|e| KeyError::Io(format!("{}: {e}", tmp.display())))?;
    }
    set_private_permissions(&tmp)?;
    fs::rename(&tmp, &path).map_err(|e| KeyError::Io(format!("{}: {e}", path.display())))?;
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), KeyError> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .map_err(|e| KeyError::Io(format!("{}: {e}", path.display())))?
        .permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)
        .map_err(|e| KeyError::Io(format!("{}: {e}", path.display())))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), KeyError> {
    // На не-Unix права файла так не задаются; каталог данных приложения и так
    // закрыт песочницей платформы.
    Ok(())
}
