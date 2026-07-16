use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState},
    Frame,
};

use crate::api::email::EmailMessage;

pub struct Inbox {
    pub messages: Vec<EmailMessage>,
    pub state: ListState,
}

impl Inbox {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            state: ListState::default(),
        }
    }

    pub fn set_messages(&mut self, messages: Vec<EmailMessage>) {
        self.messages = messages;
        if !self.messages.is_empty() {
            self.state.select(Some(0));
        }
    }

    pub fn next(&mut self) {
        if self.messages.is_empty() {
            return;
        }
        let i = self
            .state
            .selected()
            .map(|i| (i + 1) % self.messages.len())
            .unwrap_or(0);
        self.state.select(Some(i));
    }

    pub fn previous(&mut self) {
        if self.messages.is_empty() {
            return;
        }
        let i = self
            .state
            .selected()
            .map(|i| {
                if i == 0 {
                    self.messages.len() - 1
                } else {
                    i - 1
                }
            })
            .unwrap_or(0);
        self.state.select(Some(i));
    }

    pub fn selected_message(&self) -> Option<&EmailMessage> {
        self.state.selected().and_then(|i| self.messages.get(i))
    }

    pub fn render(&mut self, f: &mut Frame, area: Rect) {
        let items: Vec<ListItem> = self
            .messages
            .iter()
            .enumerate()
            .map(|(i, msg)| {
                let style = if self.state.selected() == Some(i) {
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD)
                } else if msg.is_read {
                    Style::default().fg(Color::DarkGray)
                } else {
                    Style::default().fg(Color::White)
                };

                let prefix = if msg.is_read { " " } else { "●" };

                let line = Line::from(vec![
                    Span::styled(format!("{} ", prefix), style),
                    Span::styled(truncate(&msg.from, 20), style),
                    Span::styled(" ", Style::default()),
                    Span::styled(truncate(&msg.subject, 30), style),
                    Span::styled(
                        format!(" ({})", &msg.date[..10.min(msg.date.len())]),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]);
                ListItem::new(line)
            })
            .collect();

        let block = Block::default()
            .title("Inbox")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan));

        let list = List::new(items).block(block).highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        );

        f.render_stateful_widget(list, area, &mut self.state);
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}
