//! Vault Sfera: классификация медиа для хранилища (решение PM 20.11.2026).
//!
//! Пользователь может размещать фото, аудио, видео и просто файлы. Решение,
//! к какому типу относится объект, принимается в Rust: JS получает готовый
//! `MediaKind` и только рисует иконку/плейсхолдер. Никаких `mime.startsWith`
//! в интерфейсе (ADR-005/006: логика в Rust).
//!
//! Расширение файла — подсказка, не истина: MIME от отправителя может быть
//! подменён. Классификация используется только для UI и выбора способа
//! предпросмотра; безопасность содержимого решает `social-media` (AEAD).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Document,
}

/// Классификация по MIME. Неизвестное → `Document`: честный дефолт,
/// а не попытка угадать «картинку» по расширению.
pub fn classify(mime: &str) -> MediaKind {
    let m = mime.trim().to_ascii_lowercase();
    if m.starts_with("image/") {
        MediaKind::Image
    } else if m.starts_with("audio/") {
        MediaKind::Audio
    } else if m.starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::Document
    }
}

/// Можно ли показать встроенный предпросмотр. Видео/аудио требуют Range —
/// prerequisite из ADR-006 §5.1; документ показывается как файл.
pub fn inline_preview(kind: MediaKind) -> bool {
    matches!(kind, MediaKind::Image | MediaKind::Video | MediaKind::Audio)
}

/// Требуется ли Range для корректного воспроизведения.
pub fn needs_range(kind: MediaKind) -> bool {
    matches!(kind, MediaKind::Video | MediaKind::Audio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_four_kinds_are_classified() {
        assert_eq!(classify("image/jpeg"), MediaKind::Image);
        assert_eq!(classify("audio/opus"), MediaKind::Audio);
        assert_eq!(classify("video/mp4"), MediaKind::Video);
        assert_eq!(classify("application/pdf"), MediaKind::Document);
    }

    #[test]
    fn unknown_mime_is_honest_document() {
        assert_eq!(classify(""), MediaKind::Document);
        assert_eq!(classify("IMAGE/PNG"), MediaKind::Image, "регистр не важен");
        assert_eq!(classify("application/zip"), MediaKind::Document);
    }

    #[test]
    fn preview_and_range_rules() {
        assert!(inline_preview(MediaKind::Image));
        assert!(inline_preview(MediaKind::Video));
        assert!(!inline_preview(MediaKind::Document));
        assert!(needs_range(MediaKind::Video));
        assert!(needs_range(MediaKind::Audio));
        assert!(!needs_range(MediaKind::Image));
    }
}
