//! Миниатюра изображения: маленький JPEG для галереи и ленты (ADR-006 §5.1).
//!
//! Решение «нужна ли миниатюра» и её размеры — здесь, в Rust. UI только
//! показывает готовые байты. Ошибка декодирования не роняет загрузку: файл
//! сохраняется как есть, миниатюры просто не будет.

use std::io::Cursor;

use image::{ImageReader, Limits};

/// Максимальная сторона миниатюры в пикселях.
pub const MAX_THUMB_SIDE: u32 = 512;
/// Качество JPEG: достаточно для превью, файл остаётся маленьким.
pub const JPEG_QUALITY: u8 = 80;
/// Потолок исходника: защита от «бомбы» декомпрессии.
const MAX_SOURCE_SIDE: u32 = 12_000;
/// Потолок памяти на декодирование.
const MAX_ALLOC: u64 = 96 * 1024 * 1024;

/// Миниатюра имеет смысл только для изображений; остальное — как есть.
pub fn is_thumbnailable(mime: &str) -> bool {
    mime.trim().to_ascii_lowercase().starts_with("image/")
}

/// Уменьшить изображение и закодировать в JPEG. `None` — формат не поддержан
/// или файл битый; это не ошибка загрузки.
pub fn make_thumbnail(plaintext: &[u8], mime: &str) -> Option<Vec<u8>> {
    if !is_thumbnailable(mime) || plaintext.is_empty() {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(plaintext))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_SIDE);
    limits.max_image_height = Some(MAX_SOURCE_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);

    let image = reader.decode().ok()?;
    let thumb = image.thumbnail(MAX_THUMB_SIDE, MAX_THUMB_SIDE);
    // Прозрачность в миниатюре теряется (JPEG); полный файл хранит её.
    let rgb = thumb.to_rgb8();
    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder.encode_image(&rgb).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([20, 40, 60]));
        let mut out = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    #[test]
    fn thumbnail_is_jpeg_and_fits_side_limit() {
        let src = png(1200, 800);
        let thumb = make_thumbnail(&src, "image/png").expect("thumbnail");
        assert_eq!(&thumb[..2], &[0xFF, 0xD8], "JPEG magic");
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert!(decoded.width() <= MAX_THUMB_SIDE);
        assert!(decoded.height() <= MAX_THUMB_SIDE);
        assert!(thumb.len() < src.len(), "миниатюра должна быть меньше исходника");
    }

    #[test]
    fn non_image_has_no_thumbnail() {
        assert!(make_thumbnail(b"not an image", "application/pdf").is_none());
        assert!(make_thumbnail(b"", "image/png").is_none());
        assert!(make_thumbnail(b"broken", "image/png").is_none());
    }

    #[test]
    fn mime_check_is_case_insensitive() {
        assert!(is_thumbnailable("IMAGE/JPEG"));
        assert!(!is_thumbnailable("video/mp4"));
    }
}
