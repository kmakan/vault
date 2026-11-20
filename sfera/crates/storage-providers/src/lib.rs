//! Vault Sfera: каталог пресетов хранилищ (ADR-006 §6.1).
//!
//! Механизм повторяет `mailProviders.js` мессенджера, но каталог и решение —
//! в Rust: UI только рисует список и поля. Google Drive намеренно отсутствует
//! в MVP-каталоге: OAuth-верификация экрана согласия дорогая, поэтому его
//! подключают последним, когда работают все основные провайдеры (решение
//! владельца 20.11.2026).

use storage_api::{AuthKind, StoreKind};

/// Один пресет. Все поля — данные, не код: новый провайдер = пресет +
/// адаптер + зелёный provider-conformance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoragePreset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: StoreKind,
    pub endpoint: Option<&'static str>,
    pub region: Option<&'static str>,
    pub bucket_template: Option<&'static str>,
    pub auth: AuthKind,
    pub public_link: bool,
    pub range: bool,
    pub max_file_mb: u32,
    pub hint: &'static str,
}

/// MVP-каталог по ADR-006 §6.1. Google Drive исключён сознательно.
pub static PRESETS: &[StoragePreset] = &[
    StoragePreset {
        id: "device",
        label: "Устройство",
        kind: StoreKind::Local,
        endpoint: None,
        region: None,
        bucket_template: None,
        auth: AuthKind::None,
        public_link: false,
        range: true,
        max_file_mb: 0,
        hint: "Папка на устройстве; работает офлайн, настройки не нужны",
    },
    StoragePreset {
        id: "nextcloud",
        label: "Nextcloud / ownCloud",
        kind: StoreKind::WebDav,
        endpoint: None,
        region: None,
        bucket_template: None,
        auth: AuthKind::Password,
        public_link: true,
        range: true,
        max_file_mb: 0,
        hint: "WebDAV: URL и логин/пароль, публичная ссылка по ссылке",
    },
    StoragePreset {
        id: "webdav",
        label: "Другой WebDAV",
        kind: StoreKind::WebDav,
        endpoint: None,
        region: None,
        bucket_template: None,
        auth: AuthKind::Password,
        public_link: false,
        range: true,
        max_file_mb: 0,
        hint: "Свой WebDAV: URL, логин, пароль — как свой IMAP/SMTP",
    },
    StoragePreset {
        id: "selectel",
        label: "Selectel / VK Cloud / MinIO",
        kind: StoreKind::S3,
        endpoint: Some("https://s3.mds.cloud"),
        region: Some("ru-central1"),
        bucket_template: Some("vault-{fp}"),
        auth: AuthKind::Keys,
        public_link: true,
        range: true,
        max_file_mb: 0,
        hint: "S3-совместимое хранилище: endpoint, регион, bucket, ключи",
    },
    StoragePreset {
        id: "yandex",
        label: "Яндекс Диск",
        kind: StoreKind::OAuth,
        endpoint: Some("https://webdav.yandex.ru"),
        region: None,
        bucket_template: Some("/vault/blobs"),
        auth: AuthKind::OAuth,
        public_link: true,
        range: true,
        max_file_mb: 0,
        hint: "OAuth: только кнопка входа; токены в OS keychain",
    },
    StoragePreset {
        id: "custom",
        label: "Другое",
        kind: StoreKind::Local,
        endpoint: None,
        region: None,
        bucket_template: None,
        auth: AuthKind::None,
        public_link: false,
        range: false,
        max_file_mb: 0,
        hint: "Все поля вручную; для неизвестного провайдера",
    },
];

/// Найти пресет по id.
pub fn preset(id: &str) -> Option<&'static StoragePreset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// Пользователь вставил ссылку/endpoint — подсветить подходящий пресет.
/// Решение в Rust, UI только рисует результат (§6.1).
pub fn detect_by_url(url: &str) -> Option<&'static StoragePreset> {
    let u = url.to_ascii_lowercase();
    if u.contains("webdav.yandex.ru") || u.contains("yandex.ru") {
        return preset("yandex");
    }
    if u.contains("nextcloud") || u.contains("owncloud") {
        return preset("nextcloud");
    }
    if u.contains("selectel") || u.contains("s3.mds.cloud") || u.contains("vk.cloud") {
        return preset("selectel");
    }
    if u.contains("minio") || u.contains("s3.") || u.contains("/s3") {
        return preset("selectel");
    }
    if u.contains("webdav") || u.contains("dav.") || u.starts_with("dav://") {
        return preset("webdav");
    }
    None
}

/// Какие поля показать UI для пресета. OAuth-провайдеры полей не показывают —
/// только кнопку входа (§6.1).
pub fn preset_fields(id: &str) -> &'static [&'static str] {
    match id {
        "device" => &[],
        "nextcloud" => &["url", "login", "password"],
        "webdav" => &["url", "login", "password"],
        "selectel" => &["endpoint", "region", "bucket", "access_key", "secret_key"],
        "yandex" => &[], // OAuth: только кнопка входа
        "custom" => &["url", "login", "secret", "bucket", "region"],
        _ => &[],
    }
}

/// Google Drive намеренно не в MVP: верификация OAuth-экрана согласия.
pub fn is_deferred(id: &str) -> bool {
    matches!(id, "google" | "gdrive" | "google_drive")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mvp_catalog_has_all_main_providers() {
        for id in ["device", "nextcloud", "webdav", "selectel", "yandex", "custom"] {
            assert!(preset(id).is_some(), "missing preset {id}");
        }
    }

    #[test]
    fn google_drive_is_not_in_mvp() {
        assert!(preset("google").is_none());
        assert!(preset("gdrive").is_none());
        assert!(is_deferred("google_drive"));
    }

    #[test]
    fn detect_by_url_returns_right_preset() {
        assert_eq!(detect_by_url("https://webdav.yandex.ru").unwrap().id, "yandex");
        assert_eq!(detect_by_url("https://cloud.example/nextcloud").unwrap().id, "nextcloud");
        assert_eq!(detect_by_url("https://s3.mds.cloud").unwrap().id, "selectel");
        assert_eq!(detect_by_url("https://minio.local:9000").unwrap().id, "selectel");
        assert_eq!(detect_by_url("https://dav.example.org").unwrap().id, "webdav");
        assert!(detect_by_url("https://example.com").is_none());
    }

    #[test]
    fn oauth_shows_no_manual_fields() {
        assert!(preset_fields("yandex").is_empty());
        assert!(!preset_fields("nextcloud").is_empty());
        assert!(!preset_fields("selectel").is_empty());
    }

    #[test]
    fn caps_are_honest() {
        let y = preset("yandex").unwrap();
        assert_eq!(y.kind, StoreKind::OAuth);
        assert_eq!(y.auth, AuthKind::OAuth);
        assert!(y.range, "Range нужен для стриминга (§5.1)");
        let s = preset("selectel").unwrap();
        assert_eq!(s.kind, StoreKind::S3);
        assert_eq!(s.auth, AuthKind::Keys);
    }
}
