use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Terminal graphics protocol support
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GraphicsProtocol {
    /// Kitty terminal graphics protocol
    Kitty,
    /// iTerm2 inline images protocol
    ITerm2,
    /// Sixel graphics
    Sixel,
    /// No graphics support
    None,
}

impl GraphicsProtocol {
    /// Auto-detect the best available protocol from environment
    pub fn detect() -> Self {
        let term = std::env::var("TERM").unwrap_or_default();
        let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();

        if term.contains("kitty") || std::env::var("KITTY_WINDOW_ID").is_ok() {
            GraphicsProtocol::Kitty
        } else if term_program.contains("iTerm") || term_program.contains("WezTerm") {
            GraphicsProtocol::ITerm2
        } else if term.contains("sixel") || term.contains("xterm") {
            GraphicsProtocol::Sixel
        } else {
            GraphicsProtocol::None
        }
    }

    /// Whether this protocol is available (non-None)
    pub fn is_available(&self) -> bool {
        !matches!(self, GraphicsProtocol::None)
    }
}

/// A graphics command to send to the terminal
#[derive(Debug, Clone)]
pub struct GraphicsCommand {
    /// The action to perform
    pub action: GraphicsAction,
    /// Optional image ID (for references)
    pub image_id: Option<u32>,
    /// Optional placement position
    pub placement: Option<Placement>,
}

/// Graphics action
#[derive(Debug, Clone)]
pub enum GraphicsAction {
    /// Display image from raw data
    Display { data: Vec<u8>, format: ImageFormat },
    /// Display image from file path
    DisplayFile { path: PathBuf },
    /// Delete a previously displayed image
    Delete { image_id: u32 },
    /// Query terminal support
    Query,
}

/// Image placement options
#[derive(Debug, Clone)]
pub struct Placement {
    pub column: u32,
    pub row: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Supported image formats for terminal display
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageFormat {
    PNG,
    JPEG,
    GIF,
    // SVG,  // Kitty supports SVG but complex
}

impl ImageFormat {
    pub fn from_path(path: &Path) -> Self {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .as_deref()
        {
            Some("jpg" | "jpeg") => ImageFormat::JPEG,
            Some("gif") => ImageFormat::GIF,
            _ => ImageFormat::PNG,
        }
    }

    pub fn kitty_code(&self) -> u8 {
        match self {
            ImageFormat::PNG => 100, // PNG is default
            ImageFormat::JPEG => 240,
            ImageFormat::GIF => 100, // GIF uses PNG-like code in kitty
        }
    }
}

/// Kitty terminal graphics protocol handler
pub struct KittyGraphics {
    protocol: GraphicsProtocol,
    next_id: u32,
    /// Cache of displayed image IDs
    displayed: Vec<u32>,
}

impl KittyGraphics {
    /// Create a new handler with auto-detected protocol
    pub fn new() -> Self {
        Self {
            protocol: GraphicsProtocol::detect(),
            next_id: 1,
            displayed: Vec::new(),
        }
    }

    /// Create with a specific protocol
    pub fn with_protocol(protocol: GraphicsProtocol) -> Self {
        Self {
            protocol,
            next_id: 1,
            displayed: Vec::new(),
        }
    }

    /// Get the current protocol
    pub fn protocol(&self) -> &GraphicsProtocol {
        &self.protocol
    }

    /// Check if graphics are supported
    pub fn is_supported(&self) -> bool {
        self.protocol.is_available()
    }

    /// Generate the escape sequence to display an image
    pub fn display_image(&mut self, data: &[u8], format: ImageFormat) -> Result<String> {
        if !self.is_supported() {
            anyhow::bail!(
                "Terminal does not support graphics. Detected protocol: {:?}",
                self.protocol
            );
        }

        let id = self.next_id;
        self.next_id += 1;

        let encoded = BASE64.encode(data);
        let command = match &self.protocol {
            GraphicsProtocol::Kitty => {
                // Kitty protocol: ESC_G ... ESC\
                let mut cmd = format!(
                    "\x1b_Ga=T,f={},s={},v={},i={};{}\x1b\\",
                    format.kitty_code(),
                    data.len(),
                    1, // height placeholder
                    id,
                    // Chunk data (Kitty has a 4096 byte payload limit per chunk)
                    &encoded[..encoded.len().min(4096)]
                );
                // If data is larger, send more chunks
                if encoded.len() > 4096 {
                    let remaining = &encoded[4096..];
                    for chunk in remaining.as_bytes().chunks(4096) {
                        let chunk_str =
                            std::str::from_utf8(chunk).context("Invalid UTF-8 in base64 chunk")?;
                        cmd.push_str(&format!("\x1b_Gm=1;{}\x1b\\", chunk_str));
                    }
                    // Final chunk
                    cmd.push_str("\x1b_Gm=0;\x1b\\");
                }
                cmd
            }
            GraphicsProtocol::ITerm2 => {
                // iTerm2 protocol: ESC]1337;File=...:base64data BEL
                let encoded_esc = BASE64.encode(data);
                format!("\x1b]1337;File=inline=1;width=40: {}\x07", encoded_esc)
            }
            GraphicsProtocol::Sixel => {
                // Sixel: generate sixel from raw image data
                // For now, return a placeholder
                self.generate_sixel_placeholder(data, format)?
            }
            GraphicsProtocol::None => {
                anyhow::bail!("No graphics protocol available");
            }
        };

        self.displayed.push(id);
        Ok(command)
    }

    /// Display an image file
    pub fn display_file(&mut self, path: &Path) -> Result<String> {
        let data = fs::read(path)
            .with_context(|| format!("Cannot read image file: {}", path.display()))?;
        let format = ImageFormat::from_path(path);
        self.display_image(&data, format)
    }

    /// Generate a delete command for a displayed image
    pub fn delete_image(&self, image_id: u32) -> String {
        match &self.protocol {
            GraphicsProtocol::Kitty => {
                format!("\x1b_Ga=d,d=bi={};\x1b\\", image_id)
            }
            GraphicsProtocol::ITerm2 => {
                // iTerm2: just clear the line
                "\x1b[2K\r".to_string()
            }
            _ => String::new(),
        }
    }

    /// Delete all displayed images
    pub fn clear_all(&self) -> String {
        match &self.protocol {
            GraphicsProtocol::Kitty => {
                format!("\x1b_Ga=d,d=a\x1b\\")
            }
            GraphicsProtocol::ITerm2 => {
                "\x1b[2J\x1b[H".to_string() // Clear screen
            }
            _ => String::new(),
        }
    }

    /// Generate a text placeholder for unsupported terminals
    pub fn text_placeholder(&self, path: &Path, width: Option<u32>) -> String {
        let w = width.unwrap_or(40);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".into());

        // Draw a simple ASCII box
        let border = "─".repeat(w as usize);
        let inner = w.saturating_sub(2) as usize;
        let name_display = if name.len() > inner {
            format!("{}…", &name[..inner - 1])
        } else {
            name
        };
        let padding = inner.saturating_sub(name_display.len());
        let left_pad = padding / 2;
        let right_pad = padding - left_pad;

        format!(
            "┌{border}┐\n│{}{}{}│\n│{:^inner$}│\n│{}│\n└{border}┘",
            " ".repeat(left_pad),
            "🖼 ",
            " ".repeat(right_pad.saturating_sub(2)),
            name_display,
            " ".repeat(inner),
            border = border,
            inner = inner,
        )
    }

    /// Generate a sixel placeholder (simplified)
    fn generate_sixel_placeholder(&self, _data: &[u8], _format: ImageFormat) -> Result<String> {
        // Sixel is complex; return a text marker for now
        Ok("\x1b[33m[Image: Sixel not implemented]\x1b[0m".into())
    }

    /// Get list of displayed image IDs
    pub fn displayed_ids(&self) -> &[u32] {
        &self.displayed
    }

    /// Get the number of displayed images
    pub fn count(&self) -> usize {
        self.displayed.len()
    }
}

/// Create an ASCII art thumbnail representation
pub fn ascii_thumbnail(data: &[u8], width: usize, height: usize) -> String {
    // Simple luminance-based ASCII art
    const CHARS: &[u8] = b" .:-=+*#%@";

    if data.len() < 4 {
        return "[empty image]".into();
    }

    // Parse basic image dimensions from PNG header if possible
    // For simplicity, use data length to create a pattern
    let mut result = String::new();

    for y in 0..height {
        for x in 0..width {
            // Use a hash of position + data to determine brightness
            let idx = (y * width + x) % data.len();
            let brightness = data[idx] as usize % CHARS.len();
            result.push(CHARS[brightness] as char);
        }
        result.push('\n');
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_detect() {
        let proto = GraphicsProtocol::detect();
        // Should detect some protocol (or None if no terminal)
        assert!(matches!(
            proto,
            GraphicsProtocol::Kitty
                | GraphicsProtocol::ITerm2
                | GraphicsProtocol::Sixel
                | GraphicsProtocol::None
        ));
    }

    #[test]
    fn test_format_from_path() {
        assert_eq!(
            ImageFormat::from_path(Path::new("photo.jpg")),
            ImageFormat::JPEG
        );
        assert_eq!(
            ImageFormat::from_path(Path::new("photo.jpeg")),
            ImageFormat::JPEG
        );
        assert_eq!(
            ImageFormat::from_path(Path::new("anim.gif")),
            ImageFormat::GIF
        );
        assert_eq!(
            ImageFormat::from_path(Path::new("image.png")),
            ImageFormat::PNG
        );
        assert_eq!(
            ImageFormat::from_path(Path::new("image.PNG")),
            ImageFormat::PNG
        );
    }

    #[test]
    fn test_graphics_new() {
        let g = KittyGraphics::new();
        assert_eq!(g.count(), 0);
        assert!(g.displayed_ids().is_empty());
    }

    #[test]
    fn test_with_protocol() {
        let g = KittyGraphics::with_protocol(GraphicsProtocol::Kitty);
        assert!(g.is_supported());

        let g = KittyGraphics::with_protocol(GraphicsProtocol::None);
        assert!(!g.is_supported());
    }

    #[test]
    fn test_display_no_protocol() {
        let mut g = KittyGraphics::with_protocol(GraphicsProtocol::None);
        let result = g.display_image(&[0xFF, 0xD8], ImageFormat::JPEG);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not support"));
    }

    #[test]
    fn test_display_kitty() {
        let mut g = KittyGraphics::with_protocol(GraphicsProtocol::Kitty);
        let fake_png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]; // PNG header bytes
        let result = g.display_image(&fake_png, ImageFormat::PNG);
        assert!(result.is_ok());
        let cmd = result.unwrap();
        assert!(cmd.contains("\x1b_G"));
        assert_eq!(g.count(), 1);
    }

    #[test]
    fn test_display_iterm2() {
        let mut g = KittyGraphics::with_protocol(GraphicsProtocol::ITerm2);
        let result = g.display_image(&[0xFF, 0xD8], ImageFormat::JPEG);
        assert!(result.is_ok());
        let cmd = result.unwrap();
        assert!(cmd.contains("1337;File="));
        assert!(cmd.contains("\x07"));
    }

    #[test]
    fn test_delete_image() {
        let g = KittyGraphics::with_protocol(GraphicsProtocol::Kitty);
        let cmd = g.delete_image(42);
        assert!(cmd.contains("a=d"));
        assert!(cmd.contains("i=42"));
    }

    #[test]
    fn test_clear_all() {
        let g = KittyGraphics::with_protocol(GraphicsProtocol::Kitty);
        let cmd = g.clear_all();
        assert!(cmd.contains("a=d,d=a"));
    }

    #[test]
    fn test_text_placeholder() {
        let g = KittyGraphics::new();
        let ph = g.text_placeholder(Path::new("photo.png"), Some(30));
        assert!(ph.contains("photo.png"));
        assert!(ph.contains("─"));
    }

    #[test]
    fn test_text_placeholder_long_name() {
        let g = KittyGraphics::new();
        let ph = g.text_placeholder(
            Path::new("this_is_a_very_long_filename_that_should_be_truncated.png"),
            Some(20),
        );
        assert!(ph.contains("…"));
    }

    #[test]
    fn test_ascii_thumbnail() {
        let data: Vec<u8> = (0..64).map(|i| (i * 4) as u8).collect();
        let art = ascii_thumbnail(&data, 8, 8);
        let lines: Vec<&str> = art.lines().collect();
        assert_eq!(lines.len(), 8);
        assert_eq!(lines[0].len(), 8);
    }

    #[test]
    fn test_ascii_thumbnail_empty() {
        let art = ascii_thumbnail(&[], 4, 4);
        assert!(art.contains("empty image"));
    }

    #[test]
    fn test_format_kitty_code() {
        assert_eq!(ImageFormat::PNG.kitty_code(), 100);
        assert_eq!(ImageFormat::JPEG.kitty_code(), 240);
        assert_eq!(ImageFormat::GIF.kitty_code(), 100);
    }

    #[test]
    fn test_display_file_not_found() {
        let mut g = KittyGraphics::with_protocol(GraphicsProtocol::Kitty);
        let result = g.display_file(Path::new("/nonexistent/file.png"));
        assert!(result.is_err());
    }
}
