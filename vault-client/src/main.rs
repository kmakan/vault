#![allow(dead_code)] // Infrastructure code — used in later phases
mod api;
mod cli;
mod crypto;
mod storage;
mod vault;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::api::client::Config;

#[derive(Parser)]
#[command(name = "vault", about = "🔒 Vault — E2E Encrypted Messenger", version)]
struct Cli {
    /// Run in modern CLI mode with slash commands (default; flag kept for compatibility)
    #[arg(long, short = 'c')]
    cli: bool,

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

    // Serverless era: the REPL is the only frontend. The legacy ratatui TUI
    // (vault --tui) depended on the removed REST backend and was deleted
    // 16.08.2026 together with it.
    let _ = cli_args.cli;
    cli::run_cli(config).await
}
