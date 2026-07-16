mod api;
mod app;
mod cli;
mod crypto;
mod ui;
mod vault;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::api::client::Config;

#[derive(Parser)]
#[command(
    name = "vault",
    about = "🔒 Vault — E2E Encrypted Messenger",
    version
)]
struct Cli {
    /// Run in modern CLI mode with slash commands
    #[arg(long, short = 'c')]
    cli: bool,

    /// Run in legacy TUI mode (full-screen terminal UI)
    #[arg(long, short = 't')]
    tui: bool,

    /// Email address to connect with
    #[arg(long, short = 'e')]
    email: Option<String>,

    /// IMAP server address
    #[arg(long, short = 's')]
    server: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let cli_args = Cli::parse();

    let mut config = Config::default();
    if let Some(email) = &cli_args.email {
        config.email = Some(email.clone());
    }
    if let Some(server) = &cli_args.server {
        config.server = Some(server.clone());
    }

    // Default to CLI mode unless --tui is explicitly passed
    if cli_args.tui {
        run_tui(config).await
    } else {
        cli::run_cli(config).await
    }
}

async fn run_tui(config: Config) -> Result<()> {
    use crossterm::{
        event::{Event, EventStream},
        execute,
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    };
    use futures_util::StreamExt;
    use ratatui::{backend::CrosstermBackend, Terminal};
    use std::io;

    use crate::app::App;

    let mut app = App::new(config);

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    app.initialize().await?;

    let mut events = EventStream::new();

    loop {
        terminal.draw(|f| app.render(f))?;

        if app.should_quit {
            break;
        }

        tokio::select! {
            event = events.next() => {
                if let Some(Ok(event)) = event {
                    if let Event::Key(key) = event {
                        app.handle_key_event(key).await?;
                    }
                }
            }
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    Ok(())
}
