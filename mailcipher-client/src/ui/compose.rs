use ratatui::{
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub struct Compose {
    pub input: String,
    pub cursor_pos: usize,
    pub active: bool,
}

impl Compose {
    pub fn new() -> Self {
        Self {
            input: String::new(),
            cursor_pos: 0,
            active: false,
        }
    }

    pub fn activate(&mut self) {
        self.active = true;
        self.input.clear();
        self.cursor_pos = 0;
    }

    pub fn deactivate(&mut self) {
        self.active = false;
        self.input.clear();
        self.cursor_pos = 0;
    }

    pub fn insert_char(&mut self, c: char) {
        self.input.insert(self.cursor_pos, c);
        self.cursor_pos += 1;
    }

    pub fn delete_char(&mut self) {
        if self.cursor_pos > 0 {
            self.cursor_pos -= 1;
            self.input.remove(self.cursor_pos);
        }
    }

    pub fn move_cursor_left(&mut self) {
        self.cursor_pos = self.cursor_pos.saturating_sub(1);
    }

    pub fn move_cursor_right(&mut self) {
        if self.cursor_pos < self.input.len() {
            self.cursor_pos += 1;
        }
    }

    pub fn get_input(&self) -> &str {
        &self.input
    }

    pub fn clear(&mut self) {
        self.input.clear();
        self.cursor_pos = 0;
    }

    pub fn render(&self, f: &mut Frame, area: Rect) {
        let block = Block::default()
            .title(if self.active {
                "Compose (Enter to send, Esc to cancel)"
            } else {
                "Compose (c to start)"
            })
            .borders(Borders::ALL)
            .border_style(Style::default().fg(if self.active {
                Color::Green
            } else {
                Color::Cyan
            }));

        let display = if self.input.is_empty() && !self.active {
            Line::from(Span::styled(
                "Press 'c' to compose a message",
                Style::default().fg(Color::DarkGray),
            ))
        } else {
            Line::from(vec![
                Span::styled(&self.input, Style::default().fg(Color::White)),
                Span::styled(" ", Style::default()), // cursor placeholder
            ])
        };

        let paragraph = Paragraph::new(display).block(block);
        f.render_widget(paragraph, area);
    }
}
