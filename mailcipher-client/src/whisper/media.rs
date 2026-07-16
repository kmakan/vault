use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Supported image format
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ImageFormat {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
    Unknown(String),
}

impl ImageFormat {
    /// Detect format from file extension
    pub fn from_path(path: &std::path::Path) -> Self {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .as_deref()
        {
            Some("jpg") | Some("jpeg") => Self::Jpeg,
            Some("png") => Self::Png,
            Some("gif") => Self::Gif,
            Some("webp") => Self::Webp,
            Some("bmp") => Self::Bmp,
            Some(other) => Self::Unknown(other.to_string()),
            None => Self::Unknown("".into()),
        }
    }

    pub fn mime(&self) -> &str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Bmp => "image/bmp",
            Self::Unknown(_) => "application/octet-stream",
        }
    }

    pub fn is_image(&self) -> bool {
        !matches!(self, Self::Unknown(_))
    }
}

/// Thumbnail size presets
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ThumbnailSize {
    /// 128×128 — message list preview
    Small,
    /// 256×256 — chat preview
    Medium,
    /// 512×512 — gallery preview
    Large,
}

impl ThumbnailSize {
    pub fn dimensions(&self) -> (u32, u32) {
        match self {
            Self::Small => (128, 128),
            Self::Medium => (256, 256),
            Self::Large => (512, 512),
        }
    }

    /// Size label for filename suffix
    pub fn suffix(&self) -> &str {
        match self {
            Self::Small => "s",
            Self::Medium => "m",
            Self::Large => "l",
        }
    }
}

/// A generated thumbnail record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thumbnail {
    /// Original file path or message ID
    pub source_id: String,
    /// Size variant
    pub size: ThumbnailSize,
    /// Original dimensions
    pub original_width: u32,
    pub original_height: u32,
    /// Thumbnail dimensions
    pub thumb_width: u32,
    pub thumb_height: u32,
    /// Path to thumbnail file on disk
    pub thumb_path: PathBuf,
    /// File size of the thumbnail (bytes)
    pub thumb_size: u64,
    /// MIME type
    pub mime_type: String,
    /// Format
    pub format: ImageFormat,
}

/// Info about a media file for thumbnail generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    /// File path
    pub path: PathBuf,
    /// File size
    pub size: u64,
    /// MIME type (detected or provided)
    pub mime_type: String,
    /// Image dimensions if known
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Whether this file supports thumbnailing
    pub is_thumbnailable: bool,
}

impl MediaInfo {
    /// Create a MediaInfo from a file path, detecting properties
    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let metadata = fs::metadata(path)
            .with_context(|| format!("Cannot read file: {}", path.display()))?;

        let format = ImageFormat::from_path(path);
        let mime_type = format.mime().to_string();
        let is_thumbnailable = format.is_image() && metadata.len() > 0;

        Ok(Self {
            path: path.to_path_buf(),
            size: metadata.len(),
            mime_type,
            width: None,
            height: None,
            is_thumbnailable,
        })
    }

    /// Create MediaInfo with known dimensions
    pub fn with_dimensions(path: &std::path::Path, w: u32, h: u32) -> Result<Self> {
        let mut info = Self::from_file(path)?;
        info.width = Some(w);
        info.height = Some(h);
        Ok(info)
    }
}

/// Manages thumbnail generation and storage
pub struct ThumbnailManager {
    /// Base directory for thumbnail storage
    storage_dir: PathBuf,
    /// Generated thumbnails indexed by source_id + size
    thumbnails: HashMap<String, Thumbnail>,
    /// Max thumbnail size in bytes
    max_thumb_bytes: usize,
}

impl ThumbnailManager {
    /// Create a new manager with default storage (~/.whisper/thumbs/)
    pub fn new() -> Self {
        let storage_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".whisper")
            .join("thumbs");
        Self::with_dir(storage_dir)
    }

    /// Create a manager with custom storage directory
    pub fn with_dir(storage_dir: PathBuf) -> Self {
        Self {
            storage_dir,
            thumbnails: HashMap::new(),
            max_thumb_bytes: 50 * 1024, // 50 KB max per thumbnail
        }
    }

    /// Generate a thumbnail key from source ID and size
    fn thumb_key(source_id: &str, size: ThumbnailSize) -> String {
        format!("{}:{}", source_id, size.suffix())
    }

    /// Generate a thumbnail path on disk
    fn thumb_path(&self, source_id: &str, size: ThumbnailSize) -> PathBuf {
        self.storage_dir
            .join(format!("{}_{}.bin", source_id, size.suffix()))
    }

    /// Get thumbnail info if it exists
    pub fn get_thumbnail(&self, source_id: &str, size: ThumbnailSize) -> Option<&Thumbnail> {
        let key = Self::thumb_key(source_id, size);
        self.thumbnails.get(&key)
    }

    /// Generate a thumbnail for an image file.
    ///
    /// This creates a simulated thumbnail by:
    /// 1. Reading the original file header to detect format
    /// 2. Creating a "thumbnail" placeholder that represents the downscaled image
    /// 3. Storing the metadata
    ///
    /// In production, this would use an image processing library (image-rs)
    /// to actually resize the image.
    pub fn generate_thumbnail(
        &mut self,
        info: &MediaInfo,
        size: ThumbnailSize,
    ) -> Result<Thumbnail> {
        if !info.is_thumbnailable {
            anyhow::bail!(
                "Cannot generate thumbnail for non-image file: {}",
                info.path.display()
            );
        }

        let format = ImageFormat::from_path(&info.path);
        let (thumb_w, thumb_h) = size.dimensions();
        let source_id = info
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        // Read original bytes (for a real implementation, this would decode + resize)
        let original_bytes = fs::read(&info.path)
            .with_context(|| format!("Cannot read: {}", info.path.display()))?;

        // Create thumbnail data (in production: decode → resize → encode)
        // For now, store a header + downsampled representation
        let thumb_data = self.create_thumbnail_data(&original_bytes, &format, thumb_w, thumb_h)?;

        // Ensure storage directory exists
        fs::create_dir_all(&self.storage_dir)
            .with_context(|| format!("Cannot create: {}", self.storage_dir.display()))?;

        let thumb_path = self.thumb_path(source_id, size);
        fs::write(&thumb_path, &thumb_data)
            .with_context(|| format!("Cannot write thumbnail: {}", thumb_path.display()))?;

        let thumb = Thumbnail {
            source_id: source_id.to_string(),
            size,
            original_width: info.width.unwrap_or(0),
            original_height: info.height.unwrap_or(0),
            thumb_width: thumb_w,
            thumb_height: thumb_h,
            thumb_path: thumb_path.clone(),
            thumb_size: thumb_data.len() as u64,
            mime_type: format.mime().to_string(),
            format,
        };

        let key = Self::thumb_key(source_id, size);
        self.thumbnails.insert(key, thumb.clone());

        Ok(thumb)
    }

    /// Create thumbnail data from original bytes.
    ///
    /// In production: decode → resize → re-encode as JPEG.
    /// Here: store a compact header + compressed representation.
    fn create_thumbnail_data(
        &self,
        original: &[u8],
        format: &ImageFormat,
        w: u32,
        h: u32,
    ) -> Result<Vec<u8>> {
        let mut data = Vec::new();

        // Magic: "WMTH" (Whisper THumbnail)
        data.extend_from_slice(b"WMTH");
        // Format byte
        data.push(match format {
            ImageFormat::Jpeg => 0x01,
            ImageFormat::Png => 0x02,
            ImageFormat::Gif => 0x03,
            ImageFormat::Webp => 0x04,
            ImageFormat::Bmp => 0x05,
            ImageFormat::Unknown(_) => 0xFF,
        });
        // Dimensions (2 bytes each, little-endian)
        data.extend_from_slice(&(w as u16).to_le_bytes());
        data.extend_from_slice(&(h as u16).to_le_bytes());
        // Original size (8 bytes)
        data.extend_from_slice(&(original.len() as u64).to_le_bytes());

        // Include a hash of the original for integrity
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        original.hash(&mut hasher);
        let hash = hasher.finish();
        data.extend_from_slice(&hash.to_le_bytes());

        // Pad with a portion of original data (simulating thumbnail content)
        // Take min(1KB, original) for compact representation
        let sample_len = original.len().min(1024);
        if sample_len > 0 {
            // Take from middle of file (after headers)
            let offset = (original.len() / 4).min(original.len() - sample_len);
            data.extend_from_slice(&original[offset..offset + sample_len]);
        }

        Ok(data)
    }

    /// Parse a thumbnail file to extract metadata
    pub fn parse_thumbnail_header(path: &std::path::Path) -> Result<ThumbnailHeader> {
        let data = fs::read(path)
            .with_context(|| format!("Cannot read thumbnail: {}", path.display()))?;

        if data.len() < 18 {
            anyhow::bail!("Thumbnail file too small");
        }

        if &data[0..4] != b"WMTH" {
            anyhow::bail!("Invalid thumbnail magic (expected WMTH)");
        }

        let format_byte = data[4];
        let w = u16::from_le_bytes([data[5], data[6]]) as u32;
        let h = u16::from_le_bytes([data[7], data[8]]) as u32;
        let orig_size = u64::from_le_bytes([
            data[9], data[10], data[11], data[12], data[13], data[14], data[15], data[16],
        ]);
        let hash = u64::from_le_bytes([
            data[17], data[18], data[19], data[20], data[21], data[22], data[23], data[24],
        ]);

        Ok(ThumbnailHeader {
            format: match format_byte {
                0x01 => ImageFormat::Jpeg,
                0x02 => ImageFormat::Png,
                0x03 => ImageFormat::Gif,
                0x04 => ImageFormat::Webp,
                0x05 => ImageFormat::Bmp,
                _ => ImageFormat::Unknown("unknown".into()),
            },
            width: w,
            height: h,
            original_size: orig_size,
            content_hash: hash,
        })
    }

    /// Delete a thumbnail
    pub fn delete_thumbnail(
        &mut self,
        source_id: &str,
        size: ThumbnailSize,
    ) -> Result<bool> {
        let key = Self::thumb_key(source_id, size);
        if let Some(thumb) = self.thumbnails.remove(&key) {
            if thumb.thumb_path.exists() {
                fs::remove_file(&thumb.thumb_path)?;
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Delete all thumbnails for a source
    pub fn delete_all_for_source(&mut self, source_id: &str) -> Result<usize> {
        let keys: Vec<String> = self
            .thumbnails
            .keys()
            .filter(|k| k.starts_with(&format!("{}:", source_id)))
            .cloned()
            .collect();

        let count = keys.len();
        for key in &keys {
            if let Some(thumb) = self.thumbnails.remove(key) {
                if thumb.thumb_path.exists() {
                    fs::remove_file(&thumb.thumb_path)?;
                }
            }
        }
        Ok(count)
    }

    /// List all thumbnails for a source
    pub fn list_for_source(&self, source_id: &str) -> Vec<&Thumbnail> {
        let prefix = format!("{}:", source_id);
        self.thumbnails
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .filter_map(|k| self.thumbnails.get(k))
            .collect()
    }

    /// Get total storage used by thumbnails
    pub fn storage_used(&self) -> u64 {
        self.thumbnails.values().map(|t| t.thumb_size).sum()
    }

    /// Clean up thumbnails exceeding max size
    pub fn cleanup(&mut self) -> Result<usize> {
        let max = self.max_thumb_bytes;
        let to_remove: Vec<String> = self
            .thumbnails
            .iter()
            .filter(|(_, t)| t.thumb_size as usize > max)
            .map(|(k, _)| k.clone())
            .collect();

        let count = to_remove.len();
        for key in to_remove {
            if let Some(thumb) = self.thumbnails.remove(&key) {
                if thumb.thumb_path.exists() {
                    fs::remove_file(&thumb.thumb_path)?;
                }
            }
        }
        Ok(count)
    }
}

/// Parsed header of a Whisper thumbnail
#[derive(Debug)]
pub struct ThumbnailHeader {
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
    pub original_size: u64,
    pub content_hash: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    fn write_test_image(dir: &std::path::Path, name: &str, data: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(data).unwrap();
        path
    }

    fn make_png_bytes() -> Vec<u8> {
        // Minimal PNG header + IHDR + IDAT
        let mut data = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG magic
        data.extend_from_slice(&[0x00; 64]); // padding to simulate PNG data
        data
    }

    fn make_jpeg_bytes() -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0]; // JPEG SOI
        data.extend_from_slice(&[0x00; 64]);
        data
    }

    #[test]
    fn test_format_detection() {
        assert_eq!(
            ImageFormat::from_path(std::path::Path::new("test.jpg")),
            ImageFormat::Jpeg
        );
        assert_eq!(
            ImageFormat::from_path(std::path::Path::new("test.PNG")),
            ImageFormat::Png
        );
        assert_eq!(
            ImageFormat::from_path(std::path::Path::new("test.gif")),
            ImageFormat::Gif
        );
        assert_eq!(
            ImageFormat::from_path(std::path::Path::new("test.webp")),
            ImageFormat::Webp
        );
        assert_eq!(
            ImageFormat::from_path(std::path::Path::new("test.bmp")),
            ImageFormat::Bmp
        );
        assert!(matches!(
            ImageFormat::from_path(std::path::Path::new("test.tiff")),
            ImageFormat::Unknown(_)
        ));
    }

    #[test]
    fn test_format_mime() {
        assert_eq!(ImageFormat::Jpeg.mime(), "image/jpeg");
        assert_eq!(ImageFormat::Png.mime(), "image/png");
        assert_eq!(ImageFormat::Gif.mime(), "image/gif");
        assert_eq!(
            ImageFormat::Unknown("xyz".into()).mime(),
            "application/octet-stream"
        );
    }

    #[test]
    fn test_format_is_image() {
        assert!(ImageFormat::Jpeg.is_image());
        assert!(ImageFormat::Png.is_image());
        assert!(!ImageFormat::Unknown("xyz".into()).is_image());
    }

    #[test]
    fn test_thumbnail_size_dimensions() {
        assert_eq!(ThumbnailSize::Small.dimensions(), (128, 128));
        assert_eq!(ThumbnailSize::Medium.dimensions(), (256, 256));
        assert_eq!(ThumbnailSize::Large.dimensions(), (512, 512));
    }

    #[test]
    fn test_thumbnail_size_suffix() {
        assert_eq!(ThumbnailSize::Small.suffix(), "s");
        assert_eq!(ThumbnailSize::Medium.suffix(), "m");
        assert_eq!(ThumbnailSize::Large.suffix(), "l");
    }

    #[test]
    fn test_media_info_from_file() {
        let (_dir, path) = temp_dir();
        let img = write_test_image(&path, "photo.png", &make_png_bytes());
        let info = MediaInfo::from_file(&img).unwrap();
        assert_eq!(info.mime_type, "image/png");
        assert!(info.is_thumbnailable);
        assert!(info.size > 0);
    }

    #[test]
    fn test_media_info_with_dimensions() {
        let (_dir, path) = temp_dir();
        let img = write_test_image(&path, "photo.jpg", &make_jpeg_bytes());
        let info = MediaInfo::with_dimensions(&img, 1920, 1080).unwrap();
        assert_eq!(info.width, Some(1920));
        assert_eq!(info.height, Some(1080));
    }

    #[test]
    fn test_generate_thumbnail_png() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_png_bytes();
        let img = write_test_image(&path, "photo.png", &img_data);
        let info = MediaInfo::with_dimensions(&img, 1920, 1080).unwrap();

        let thumb = mgr.generate_thumbnail(&info, ThumbnailSize::Small).unwrap();
        assert_eq!(thumb.thumb_width, 128);
        assert_eq!(thumb.thumb_height, 128);
        assert_eq!(thumb.format, ImageFormat::Png);
        assert!(thumb.thumb_size > 0);
        assert!(thumb.thumb_path.exists());
    }

    #[test]
    fn test_generate_thumbnail_jpeg() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_jpeg_bytes();
        let img = write_test_image(&path, "photo.jpg", &img_data);
        let info = MediaInfo::with_dimensions(&img, 800, 600).unwrap();

        let thumb = mgr
            .generate_thumbnail(&info, ThumbnailSize::Medium)
            .unwrap();
        assert_eq!(thumb.thumb_width, 256);
        assert_eq!(thumb.thumb_height, 256);
        assert_eq!(thumb.format, ImageFormat::Jpeg);
    }

    #[test]
    fn test_get_thumbnail() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_png_bytes();
        let img = write_test_image(&path, "photo.png", &img_data);
        let info = MediaInfo::from_file(&img).unwrap();

        assert!(mgr.get_thumbnail("photo", ThumbnailSize::Small).is_none());
        mgr.generate_thumbnail(&info, ThumbnailSize::Small).unwrap();
        assert!(mgr.get_thumbnail("photo", ThumbnailSize::Small).is_some());
        assert!(mgr.get_thumbnail("photo", ThumbnailSize::Large).is_none());
    }

    #[test]
    fn test_multiple_sizes() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_png_bytes();
        let img = write_test_image(&path, "photo.png", &img_data);
        let info = MediaInfo::from_file(&img).unwrap();

        mgr.generate_thumbnail(&info, ThumbnailSize::Small).unwrap();
        mgr.generate_thumbnail(&info, ThumbnailSize::Medium).unwrap();
        mgr.generate_thumbnail(&info, ThumbnailSize::Large).unwrap();

        let list = mgr.list_for_source("photo");
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn test_delete_thumbnail() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_jpeg_bytes();
        let img = write_test_image(&path, "img.jpg", &img_data);
        let info = MediaInfo::from_file(&img).unwrap();
        mgr.generate_thumbnail(&info, ThumbnailSize::Small).unwrap();

        assert!(mgr.get_thumbnail("img", ThumbnailSize::Small).is_some());
        mgr.delete_thumbnail("img", ThumbnailSize::Small).unwrap();
        assert!(mgr.get_thumbnail("img", ThumbnailSize::Small).is_none());
    }

    #[test]
    fn test_delete_all_for_source() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_png_bytes();
        let img = write_test_image(&path, "photo.png", &img_data);
        let info = MediaInfo::from_file(&img).unwrap();

        mgr.generate_thumbnail(&info, ThumbnailSize::Small).unwrap();
        mgr.generate_thumbnail(&info, ThumbnailSize::Medium).unwrap();

        let deleted = mgr.delete_all_for_source("photo").unwrap();
        assert_eq!(deleted, 2);
        assert!(mgr.list_for_source("photo").is_empty());
    }

    #[test]
    fn test_parse_thumbnail_header() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let img_data = make_png_bytes();
        let img = write_test_image(&path, "photo.png", &img_data);
        let info = MediaInfo::with_dimensions(&img, 1920, 1080).unwrap();
        let thumb = mgr.generate_thumbnail(&info, ThumbnailSize::Medium).unwrap();

        let header = ThumbnailManager::parse_thumbnail_header(&thumb.thumb_path).unwrap();
        assert_eq!(header.format, ImageFormat::Png);
        assert_eq!(header.width, 256);
        assert_eq!(header.height, 256);
        assert_eq!(header.original_size, img_data.len() as u64);
    }

    #[test]
    fn test_parse_invalid_thumbnail() {
        let (_dir, path) = temp_dir();
        let bad_path = path.join("bad.bin");
        fs::write(&bad_path, b"not a thumbnail").unwrap();

        let result = ThumbnailManager::parse_thumbnail_header(&bad_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_storage_used() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        assert_eq!(mgr.storage_used(), 0);

        let img_data = make_png_bytes();
        let img = write_test_image(&path, "photo.png", &img_data);
        let info = MediaInfo::from_file(&img).unwrap();
        let thumb = mgr.generate_thumbnail(&info, ThumbnailSize::Small).unwrap();

        assert_eq!(mgr.storage_used(), thumb.thumb_size);
    }

    #[test]
    fn test_non_image_rejected() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let txt_path = write_test_image(&path, "doc.txt", b"hello world");
        let info = MediaInfo::from_file(&txt_path).unwrap();
        assert!(!info.is_thumbnailable);

        let result = mgr.generate_thumbnail(&info, ThumbnailSize::Small);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_file_rejected() {
        let (_dir, path) = temp_dir();
        let thumb_dir = path.join("thumbs");
        let mut mgr = ThumbnailManager::with_dir(thumb_dir);

        let empty_path = write_test_image(&path, "empty.png", b"");
        let info = MediaInfo::from_file(&empty_path).unwrap();
        assert!(!info.is_thumbnailable);
    }
}
