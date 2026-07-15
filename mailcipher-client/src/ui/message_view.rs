use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::api::client::Message;

pub struct MessageView {
    pub messages: Vec<Message>,
    pub scroll: usize,
}

impl MessageView {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            scroll: 0,
        }
    }

    pub fn set_messages(&mut self, messages: Vec<Message>) {
        self.messages = messages;
        self.scroll = 0;
    }

    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }

    pub fn scroll_down(&mut self, visible_lines: usize) {
        let max_scroll = self.messages.len().saturating_sub(visible_lines);
        if self.scroll < max_scroll {
            self.scroll += 1;
        }
    }

    pub fn scroll_to_bottom(&mut self, visible_lines: usize) {
        self.scroll = self.messages.len().saturating_sub(visible_lines);
    }

    pub fn render(&self, f: &mut Frame, area: Rect) {
        let block = Block::default()
            .title("Messages")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan));

        if self.messages.is_empty() {
            let empty = Paragraph::new("No messages yet. Press 'c' to compose.")
                .block(block)
                .style(Style::default().fg(Color::DarkGray));
            f.render_widget(empty, area);
            return;
        }

        let lines: Vec<Line> = self
            .messages
            .iter()
            .map(|msg| {
                let time = &msg.created_at[..19];
                let content = msg.subject.as_deref().unwrap_or("(no subject)");

                Line::from(vec![
                    Span::styled(
                        format!("[{}] ", time),
                        Style::default().fg(Color::DarkGray),
                    ),
                    Span::styled(
                        content,
                        Style::default().fg(Color::White),
                    ),
                ])
            })
            .collect();

        let paragraph = Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((self.scroll as u16, 0));

        f.render_widget(paragraph, area);
    }
}
