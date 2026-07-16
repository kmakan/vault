use console::Style;
use std::fmt;

/// Rich terminal output formatter for Whisper CLI
pub struct Output;

impl Output {
    // ── Banner ────────────────────────────────────────────────────
    pub fn banner() {
        let banner = r#"
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
  ⣿                                                            ⣿
  ⣿   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗            ⣿
  ⣿   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝            ⣿
  ⣿   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗            ⣿
  ⣿   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║            ⣿
  ⣿   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║            ⣿
  ⣿   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝            ⣿
  ⣿                   E2E Encrypted Messenger                    ⣿
  ⣿                                                            ⣿
  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿"#;

        println!("{}", Style::new().cyan().bold().apply_to(banner));
        println!(
            "  {} {}\n",
            Style::new().dim().apply_to("v0.1.0"),
            Style::new().dim().apply_to("| type /help for commands")
        );
    }

    // ── Success ───────────────────────────────────────────────────
    pub fn success(msg: &str) {
        println!("  {} {}", Style::new().green().bold().apply_to("✓"), msg);
    }

    // ── Error ─────────────────────────────────────────────────────
    pub fn error(msg: &str) {
        println!("  {} {}", Style::new().red().bold().apply_to("✗"), msg);
    }

    // ── Info ──────────────────────────────────────────────────────
    pub fn info(msg: &str) {
        println!("  {} {}", Style::new().cyan().apply_to("→"), msg);
    }

    // ── Warning ───────────────────────────────────────────────────
    pub fn warn(msg: &str) {
        println!("  {} {}", Style::new().yellow().apply_to("⚠"), msg);
    }

    // ── Chat message ──────────────────────────────────────────────
    pub fn chat_message(sender: &str, text: &str, is_self: bool) {
        let time = chrono::Local::now().format("%H:%M");
        if is_self {
            println!(
                "  {} {} {}",
                Style::new().dim().apply_to(time),
                Style::new().green().bold().apply_to(format!("{}:", sender)),
                text
            );
        } else {
            println!(
                "  {} {} {}",
                Style::new().dim().apply_to(time),
                Style::new().cyan().bold().apply_to(format!("{}:", sender)),
                text
            );
        }
    }

    // ── Encrypted message placeholder ─────────────────────────────
    pub fn encrypted_preview(cipher: &str) {
        let preview: String = cipher.chars().take(40).collect();
        println!(
            "  {} {} {}...",
            Style::new().dim().apply_to("🔒"),
            Style::new().magenta().apply_to("Encrypted:"),
            Style::new().dim().apply_to(preview)
        );
    }

    // ── Table row ─────────────────────────────────────────────────
    pub fn table_row(cols: &[&str], widths: &[usize]) {
        let mut line = "  ".to_string();
        for (col, w) in cols.iter().zip(widths.iter()) {
            line.push_str(&format!("{:<width$}  ", col, width = w));
        }
        println!("{}", line);
    }

    pub fn table_header(cols: &[&str], widths: &[usize]) {
        let styled: Vec<String> = cols
            .iter()
            .zip(widths.iter())
            .map(|(c, w)| format!("{:<width$}", Style::new().bold().apply_to(c), width = w))
            .collect();
        println!("  {}", styled.join("  "));
        let sep: String = widths
            .iter()
            .map(|w| "─".repeat(*w))
            .collect::<Vec<_>>()
            .join("──");
        println!("  {}", Style::new().dim().apply_to(sep));
    }

    // ── Status indicator ──────────────────────────────────────────
    pub fn status(online: bool, label: &str) {
        if online {
            println!(
                "  {} {}",
                Style::new().green().apply_to("●"),
                Style::new().dim().apply_to(label)
            );
        } else {
            println!(
                "  {} {}",
                Style::new().red().apply_to("○"),
                Style::new().dim().apply_to(label)
            );
        }
    }

    // ── Key fingerprint ───────────────────────────────────────────
    pub fn fingerprint(fp: &str) {
        println!(
            "  {} {}",
            Style::new().yellow().apply_to("🔐"),
            Style::new().dim().apply_to(fp)
        );
    }

    // ── Prompt line ───────────────────────────────────────────────
    pub fn prompt(chat: Option<&str>) -> String {
        match chat {
            Some(name) => format!("{} {} ", name, Style::new().dim().apply_to("›")),
            None => format!("{} ", Style::new().cyan().bold().apply_to("whisper ❯")),
        }
    }

    // ── Section divider ───────────────────────────────────────────
    pub fn divider() {
        println!("  {}", Style::new().dim().apply_to("─".repeat(50)));
    }

    // ── Multi-line block ──────────────────────────────────────────
    pub fn block(title: &str, lines: &[&str]) {
        println!("\n  {}", Style::new().bold().apply_to(title));
        Self::divider();
        for line in lines {
            println!("  {}", line);
        }
        println!();
    }
}

/// Format byte size to human-readable
pub fn format_size(bytes: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = 1024 * KB;
    const GB: usize = 1024 * MB;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

impl fmt::Display for Output {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Whisper CLI")
    }
}
