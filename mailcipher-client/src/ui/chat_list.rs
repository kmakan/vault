use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState},
    Frame,
};

use crate::api::client::Chat;

pub struct ChatList {
    pub chats: Vec<Chat>,
    pub state: ListState,
}

impl ChatList {
    pub fn new() -> Self {
        Self {
            chats: Vec::new(),
            state: ListState::default(),
        }
    }

    pub fn set_chats(&mut self, chats: Vec<Chat>) {
        self.chats = chats;
        if !self.chats.is_empty() {
            self.state.select(Some(0));
        }
    }

    pub fn next(&mut self) {
        if self.chats.is_empty() {
            return;
        }
        let i = self.state.selected().map(|i| (i + 1) % self.chats.len()).unwrap_or(0);
        self.state.select(Some(i));
    }

    pub fn previous(&mut self) {
        if self.chats.is_empty() {
            return;
        }
        let i = self.state.selected().map(|i| {
            if i == 0 {
                self.chats.len() - 1
            } else {
                i - 1
            }
        }).unwrap_or(0);
        self.state.select(Some(i));
    }

    pub fn selected_chat(&self) -> Option<&Chat> {
        self.state.selected().and_then(|i| self.chats.get(i))
    }

    pub fn render(&mut self, f: &mut Frame, area: Rect) {
        let items: Vec<ListItem> = self
            .chats
            .iter()
            .enumerate()
            .map(|(i, chat)| {
                let style = if self.state.selected() == Some(i) {
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };

                let line = Line::from(vec![
                    Span::styled(
                        format!("Chat {}", &chat.id.to_string()[..8]),
                        style,
                    ),
                    Span::styled(
                        format!(" ({})", &chat.updated_at[..19]),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]);
                ListItem::new(line)
            })
            .collect();

        let block = Block::default()
            .title("Chats")
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
