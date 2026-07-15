use ratatui::{
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::api::email::EmailMessage;

pub struct EmailView {
    pub message: Option<EmailMessage>,
    pub body: Option<String>,
    pub scroll: usize,
    pub encrypted: bool,
    pub decrypted_body: Option<String>,
}

impl EmailView {
    pub fn new() -> Self {
        Self {
            message: None,
            body: None,
            scroll: 0,
            encrypted: false,
            decrypted_body: None,
        }
    }

    pub fn set_message(&mut self, message: EmailMessage, body: Option<String>) {
        self.message = Some(message);
        self.body = body;
        self.scroll = 0;
        self.encrypted = false;
        self.decrypted_body = None;
    }

    pub fn set_decrypted_body(&mut self, decrypted: String) {
        self.decrypted_body = Some(decrypted);
        self.encrypted = true;
    }

    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }

    pub fn scroll_down(&mut self, visible_lines: usize) {
        let total_lines = self.total_lines();
        let max_scroll = total_lines.saturating_sub(visible_lines);
        if self.scroll < max_scroll {
            self.scroll += 1;
        }
    }

    pub fn scroll_to_bottom(&mut self, visible_lines: usize) {
        let total_lines = self.total_lines();
        self.scroll = total_lines.saturating_sub(visible_lines);
    }

    fn total_lines(&self) -> usize {
        let content = self.display_content();
        content.lines().count()
    }

    fn display_content(&self) -> String {
        let mut lines = Vec::new();

        if let Some(msg) = &self.message {
            lines.push(format!("From: {}", msg.from));
            lines.push(format!("To: {}", msg.to));
            lines.push(format!("Subject: {}", msg.subject));
            lines.push(format!("Date: {}", msg.date));
            lines.push("─".repeat(40));
            lines.push(String::new());

            if self.encrypted {
                if let Some(decrypted) = &self.decrypted_body {
                    lines.push("[Encrypted message - decrypted]".to_string());
                    lines.push(String::new());
                    lines.push(decrypted.clone());
                } else {
                    lines.push("[Encrypted message]".to_string());
                    lines.push(String::new());
                    lines.push(self.body.as_deref().unwrap_or("(no content)").to_string());
                }
            } else if let Some(body) = &self.body {
                lines.push(body.clone());
            } else {
                lines.push("(loading...)".to_string());
            }
        }

        lines.join("\n")
    }

    pub fn render(&self, f: &mut Frame, area: Rect) {
        let block = Block::default()
            .title("Email")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan));

        let content = self.display_content();

        let paragraph = Paragraph::new(content)
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((self.scroll as u16, 0));

        f.render_widget(paragraph, area);
    }
}
