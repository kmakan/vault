#![allow(dead_code)] // Infrastructure code — used in later phases
mod api;
mod cli;
mod crypto;
mod listen;
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

    /// Headless bot listener: poll INBOX + relay, NDJSON events on stdout,
    /// NDJSON commands on stdin (see src/listen.rs). Requires -e, VAULT_PASSWORD.
    #[arg(long)]
    listen: bool,

    /// Poll interval for --listen (seconds, min 5)
    #[arg(long, default_value = "15")]
    listen_interval: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        // Логи — в stderr. В --listen-режиме stdout это NDJSON-канал моста:
        // перемешивать с ним текст нельзя (браузер событий и диагностика
        // должны быть разведены по потокам, как у всех unix-фильтров).
        .with_writer(std::io::stderr)
        .init();

    let cli_args = Cli::parse();

    let mut config = Config::default();
    if let Some(email) = &cli_args.email {
        config.email = Some(email.clone());
    }
    if let Some(server) = &cli_args.server {
        config.server = Some(server.clone());
    }

    if cli_args.listen {
        return listen::run(config, cli_args.listen_interval).await;
    }

    // Serverless era: the REPL is the only frontend. The legacy ratatui TUI
    // (vault --tui) depended on the removed REST backend and was deleted
    let _ = cli_args.cli;
    cli::run_cli(config).await
}
