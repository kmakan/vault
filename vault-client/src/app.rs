use anyhow::Result;
use crossterm::event::{self, KeyCode, KeyEventKind};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};
use uuid::Uuid;

use crate::api::client::{ApiClient, Chat, Config};
use crate::api::email::{EmailClient, EmailConfig, EmailMessage};
use crate::crypto::CryptoClient;
use crate::ui::chat_list::ChatList;
use crate::ui::compose::Compose;
use crate::ui::email_view::EmailView;
use crate::ui::inbox::Inbox;
use crate::ui::message_view::MessageView;

#[derive(PartialEq)]
pub enum AppMode {
    ChatList,
    MessageView,
    Compose,
    Inbox,
    EmailView,
    Loading,
    Error,
}

pub struct App {
    pub mode: AppMode,
    pub chat_list: ChatList,
    pub message_view: MessageView,
    pub compose: Compose,
    pub inbox: Inbox,
    pub email_view: EmailView,
    pub api_client: ApiClient,
    pub email_client: Option<EmailClient>,
    pub crypto_client: CryptoClient,
    pub current_chat: Option<Chat>,
    pub current_email: Option<EmailMessage>,
    pub error_message: Option<String>,
    pub should_quit: bool,
    pub show_email_mode: bool,
}

impl App {
    pub fn new(config: Config) -> Self {
        let api_client = ApiClient::new(config);
        Self {
            mode: AppMode::Loading,
            chat_list: ChatList::new(),
            message_view: MessageView::new(),
            compose: Compose::new(),
            inbox: Inbox::new(),
            email_view: EmailView::new(),
            api_client,
            email_client: None,
            crypto_client: CryptoClient::new(),
            current_chat: None,
            current_email: None,
            error_message: None,
            should_quit: false,
            show_email_mode: false,
        }
    }

    pub fn connect_email(&mut self, email_config: EmailConfig) -> Result<()> {
        let client = EmailClient::new(email_config);
        self.email_client = Some(client);
        Ok(())
    }

    pub async fn connect_imap(&mut self, email: &str, password: &str, server: &str) -> Result<()> {
        let config = EmailConfig {
            imap_server: server.to_string(),
            email: email.to_string(),
            password: password.to_string(),
            ..Default::default()
        };

        let mut client = EmailClient::new(config);
        client.connect_imap().await?;
        self.email_client = Some(client);
        Ok(())
    }

    pub async fn load_inbox(&mut self) -> Result<()> {
        if let Some(client) = &mut self.email_client {
            let messages = client.fetch_messages().await?;
            self.inbox.set_messages(messages);
            self.mode = AppMode::Inbox;
        } else {
            self.error_message = Some("Not connected to email server".to_string());
            self.mode = AppMode::Error;
        }
        Ok(())
    }

    pub async fn open_email(&mut self, message: EmailMessage) -> Result<()> {
        if let Some(client) = &mut self.email_client {
            let body = client.fetch_message_body(&message.id).await?;
            let is_encrypted = self.crypto_client.is_encrypted(&body);

            let mut email_view = EmailView::new();
            email_view.set_message(message.clone(), Some(body.clone()));

            if is_encrypted {
                if let Ok(decrypted) = self.crypto_client.decrypt(&body) {
                    email_view.set_decrypted_body(decrypted);
                }
            }

            self.email_view = email_view;
            self.current_email = Some(message.clone());

            if let Some(client) = &mut self.email_client {
                let _ = client.mark_as_read(&message.id).await;
            }

            self.mode = AppMode::EmailView;
        }
        Ok(())
    }

    pub async fn send_email(&mut self, to: &str, subject: &str, body: &str) -> Result<()> {
        if let Some(client) = &self.email_client {
            client.send_email(to, subject, body).await?;
        } else {
            anyhow::bail!("Not connected to email server");
        }
        Ok(())
    }

    pub async fn initialize(&mut self) -> Result<()> {
        match self.api_client.health_check().await {
            Ok(true) => {
                self.load_chats().await?;
                self.mode = AppMode::ChatList;
            }
            Ok(false) => {
                self.error_message = Some("Server returned non-OK status".to_string());
                self.mode = AppMode::Error;
            }
            Err(e) => {
                self.error_message = Some(format!("Cannot connect to server: {}", e));
                self.mode = AppMode::Error;
            }
        }
        Ok(())
    }

    async fn load_chats(&mut self) -> Result<()> {
        match self.api_client.get_chats().await {
            Ok(chats) => {
                self.chat_list.set_chats(chats);
                Ok(())
            }
            Err(e) => {
                self.error_message = Some(format!("Failed to load chats: {}", e));
                self.mode = AppMode::Error;
                Ok(())
            }
        }
    }

    async fn load_messages(&mut self, chat_id: &Uuid) -> Result<()> {
        match self.api_client.get_messages(chat_id).await {
            Ok(messages) => {
                self.message_view.set_messages(messages);
                let visible_lines = 20; // approximate
                self.message_view.scroll_to_bottom(visible_lines);
                Ok(())
            }
            Err(e) => {
                self.error_message = Some(format!("Failed to load messages: {}", e));
                Ok(())
            }
        }
    }

    async fn send_message(&mut self) -> Result<()> {
        let content = self.compose.get_input().to_string();
        if content.is_empty() || self.current_chat.is_none() {
            return Ok(());
        }

        let chat_id = self.current_chat.as_ref().unwrap().id;
        match self.api_client.send_message(&chat_id, &content, None).await {
            Ok(_) => {
                self.compose.deactivate();
                self.load_messages(&chat_id).await?;
                self.mode = AppMode::MessageView;
            }
            Err(e) => {
                self.error_message = Some(format!("Failed to send message: {}", e));
            }
        }
        Ok(())
    }

    pub async fn handle_key_event(&mut self, key: event::KeyEvent) -> Result<()> {
        if key.kind != KeyEventKind::Press {
            return Ok(());
        }

        match self.mode {
            AppMode::ChatList => match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    self.should_quit = true;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.chat_list.next();
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.chat_list.previous();
                }
                KeyCode::Enter => {
                    if let Some(chat) = self.chat_list.selected_chat().cloned() {
                        self.current_chat = Some(chat.clone());
                        self.load_messages(&chat.id).await?;
                        self.mode = AppMode::MessageView;
                    }
                }
                KeyCode::Char('r') => {
                    self.load_chats().await?;
                }
                KeyCode::Char('i') => {
                    if self.email_client.is_some() {
                        self.load_inbox().await?;
                    } else {
                        self.error_message =
                            Some("Press 'e' to connect to email server first".to_string());
                        self.mode = AppMode::Error;
                    }
                }
                _ => {}
            },
            AppMode::MessageView => match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    self.mode = AppMode::ChatList;
                    self.current_chat = None;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.message_view.scroll_down(20);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.message_view.scroll_up();
                }
                KeyCode::Char('G') => {
                    self.message_view.scroll_to_bottom(20);
                }
                KeyCode::Char('g') => {
                    self.message_view.scroll = 0;
                }
                KeyCode::Char('c') => {
                    self.compose.activate();
                    self.mode = AppMode::Compose;
                }
                KeyCode::Char('r') => {
                    let chat_id = self.current_chat.as_ref().map(|c| c.id);
                    if let Some(chat_id) = chat_id {
                        self.load_messages(&chat_id).await?;
                    }
                }
                _ => {}
            },
            AppMode::Compose => match key.code {
                KeyCode::Esc => {
                    self.compose.deactivate();
                    self.mode = AppMode::MessageView;
                }
                KeyCode::Enter => {
                    self.send_message().await?;
                }
                KeyCode::Char(c) => {
                    self.compose.insert_char(c);
                }
                KeyCode::Backspace => {
                    self.compose.delete_char();
                }
                KeyCode::Left => {
                    self.compose.move_cursor_left();
                }
                KeyCode::Right => {
                    self.compose.move_cursor_right();
                }
                _ => {}
            },
            AppMode::Inbox => match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    self.mode = AppMode::ChatList;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.inbox.next();
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.inbox.previous();
                }
                KeyCode::Enter => {
                    if let Some(message) = self.inbox.selected_message().cloned() {
                        self.open_email(message).await?;
                    }
                }
                KeyCode::Char('r') => {
                    self.load_inbox().await?;
                }
                _ => {}
            },
            AppMode::EmailView => match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    self.mode = AppMode::Inbox;
                    self.current_email = None;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.email_view.scroll_down(20);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.email_view.scroll_up();
                }
                KeyCode::Char('G') => {
                    self.email_view.scroll_to_bottom(20);
                }
                KeyCode::Char('g') => {
                    self.email_view.scroll = 0;
                }
                _ => {}
            },
            AppMode::Error => match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    self.should_quit = true;
                }
                KeyCode::Enter => {
                    self.error_message = None;
                    self.mode = AppMode::ChatList;
                }
                _ => {}
            },
            AppMode::Loading => {}
        }

        Ok(())
    }

    pub fn render(&mut self, f: &mut Frame) {
        match self.mode {
            AppMode::Loading => {
                let loading = Paragraph::new("Connecting to server...")
                    .style(Style::default().fg(Color::Yellow));
                f.render_widget(loading, f.area());
            }
            AppMode::Error => {
                let error_msg = self.error_message.as_deref().unwrap_or("Unknown error");
                let error = Paragraph::new(vec![
                    Line::from(Span::styled(
                        "Error",
                        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                    )),
                    Line::from(""),
                    Line::from(Span::styled(error_msg, Style::default().fg(Color::Red))),
                    Line::from(""),
                    Line::from(Span::styled(
                        "Press Enter to continue, q to quit",
                        Style::default().fg(Color::DarkGray),
                    )),
                ])
                .block(
                    Block::default()
                        .title("Error")
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Red)),
                );
                f.render_widget(error, f.area());
            }
            AppMode::Inbox => {
                let chunks = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
                    .split(f.area());

                self.inbox.render(f, chunks[0]);

                if let Some(msg) = self.inbox.selected_message() {
                    let preview = Paragraph::new(vec![
                        Line::from(Span::styled(
                            format!("From: {}", msg.from),
                            Style::default().fg(Color::White),
                        )),
                        Line::from(Span::styled(
                            format!("Subject: {}", msg.subject),
                            Style::default().fg(Color::White),
                        )),
                        Line::from(""),
                        Line::from(Span::styled(
                            "Press Enter to view full email",
                            Style::default().fg(Color::DarkGray),
                        )),
                    ])
                    .block(
                        Block::default()
                            .title("Preview")
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(Color::Cyan)),
                    );
                    f.render_widget(preview, chunks[1]);
                }
            }
            AppMode::EmailView => {
                self.email_view.render(f, f.area());
            }
            _ => {
                let chunks = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
                    .split(f.area());

                self.chat_list.render(f, chunks[0]);

                let right_chunks = Layout::default()
                    .direction(Direction::Vertical)
                    .constraints([Constraint::Min(5), Constraint::Length(3)])
                    .split(chunks[1]);

                self.message_view.render(f, right_chunks[0]);
                self.compose.render(f, right_chunks[1]);
            }
        }
    }
}
