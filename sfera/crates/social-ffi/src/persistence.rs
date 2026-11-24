//! Сохранение принятой книги профилей и манифестов аватаров (ADR-006 §7.6).
//!
//! JSON содержит публичные профили и file keys из E2E-конвертов, поэтому файл
//! защищён 0600 и пишется атомарно. При чтении подписи и соответствие манифеста
//! проверяются повторно; битая версия не превращается в пустую книгу молча.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use social_app::{AppError, SferaApp};
use social_library::AvatarManifest;
use social_profile::SignedProfile;

pub const FILE: &str = "received_profiles.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct Stored {
    v: u8,
    profiles: Vec<SignedProfile>,
    #[serde(default)]
    avatars: HashMap<String, AvatarManifest>,
}

fn path(keys_dir: &Path) -> PathBuf { keys_dir.join(FILE) }

fn read_at(keys_dir: &Path) -> Result<Option<Stored>, AppError> {
    let path = path(keys_dir);
    if !path.exists() { return Ok(None); }
    let stored: Stored = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| AppError::Canonical(e.to_string()))?,
    ).map_err(|e| AppError::Canonical(format!("received profiles: {e}")))?;
    if stored.v != 1 {
        return Err(AppError::Canonical("received profiles: unsupported version".into()));
    }
    for profile in &stored.profiles {
        if !social_profile::verify_profile(profile) {
            return Err(AppError::Canonical("stored profile signature is invalid".into()));
        }
        let manifest = stored.avatars.get(&social_profile::profile_id(profile));
        if let (Some(avatar), Some(manifest)) = (profile.profile.avatar.as_ref(), manifest) {
            if avatar.blob_id.to_hex() != manifest.blob_id {
                return Err(AppError::Canonical("stored avatar manifest does not match profile".into()));
            }
        }
        // Ссылка без манифеста безопасна (аватар недоступен), но манифест
        // без подписанной ссылки нельзя оставлять как будто он принадлежит профилю.
        if profile.profile.avatar.is_none() && manifest.is_some() {
            return Err(AppError::Canonical("stored avatar manifest has no signed avatar".into()));
        }
    }
    Ok(Some(stored))
}

/// Проверка перед заменой файла: повреждённая книга не затирается пустой.
pub fn validate_at(keys_dir: &Path) -> Result<(), AppError> {
    read_at(keys_dir).map(|_| ())
}

/// Восстановить книгу в app и вернуть манифесты в отдельное Rust-состояние.
/// Несоответствие манифеста подписанному аватару отклоняет весь файл.
pub fn load_at(
    keys_dir: &Path,
    app: &mut SferaApp,
) -> Result<HashMap<String, AvatarManifest>, AppError> {
    let Some(stored) = read_at(keys_dir)? else { return Ok(HashMap::new()); };
    for profile in stored.profiles {
        // Книга индексируется по fingerprint автора; profile_id — отдельный
        // ключ манифеста аватара, его нельзя использовать для поиска профиля.
        if app.profile_of(&profile.profile.author.fp).is_some() { continue; }
        app.receive_profile(profile)?;
    }
    Ok(stored.avatars)
}

/// Записать снимок книги и манифестов. Сначала tmp+sync, затем rename.
pub fn save_at(
    keys_dir: &Path,
    profiles: Vec<SignedProfile>,
    avatars: &HashMap<String, AvatarManifest>,
) -> Result<(), AppError> {
    std::fs::create_dir_all(keys_dir).map_err(|e| AppError::Canonical(e.to_string()))?;
    let path = path(keys_dir);
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_vec(&Stored { v: 1, profiles, avatars: avatars.clone() })
        .map_err(|e| AppError::Canonical(e.to_string()))?;
    let mut file = std::fs::File::create(&tmp).map_err(|e| AppError::Canonical(e.to_string()))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| AppError::Canonical(e.to_string()))?;
    }
    file.write_all(&body).map_err(|e| AppError::Canonical(e.to_string()))?;
    file.sync_all().map_err(|e| AppError::Canonical(e.to_string()))?;
    drop(file);
    std::fs::rename(tmp, path).map_err(|e| AppError::Canonical(e.to_string()))?;
    Ok(())
}
