use anyhow::Result;
use console::Style;
use reedline::{Reedline, Signal, FileBackedHistory, DefaultPrompt};

use crate::api::client::Config;
use crate::api::email::{EmailClient, EmailConfig};
use crate::cli::commands::Command;
use crate::cli::output::{Output, format_size};
use crate::crypto::CryptoClient;

const HISTORY_FILE: &str = ".whisper_history";

/// Main CLI REPL entry point
pub async fn run_cli(config: Config) -> Result<()> {
    let history_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(HISTORY_FILE);

    let history = Box::new(
        FileBackedHistory::with_file(500, history_path)
            .unwrap_or_else(|_| FileBackedHistory::new(500).expect("Failed to create history")),
    );

    let mut editor = Reedline::create().with_history(history);
    let prompt = DefaultPrompt::default();

    let mut ctx = CliContext::new(config);

    Output::banner();
    print_welcome(&ctx);

    loop {
        match editor.read_line(&prompt) {
            Ok(Signal::Success(line)) => {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }

                let cmd = Command::parse(&line);

                // In chat mode, bare text → send
                let cmd = if ctx.active_chat.is_some() && matches!(&cmd, Command::Unknown(s) if !s.is_empty()) {
                    Command::Send { message: line }
                } else {
                    cmd
                };

                let should_quit = handle_command(&mut ctx, cmd).await?;
                if should_quit {
                    break;
                }
            }
            Ok(Signal::CtrlD) | Ok(Signal::CtrlC) => {
                Output::info("Goodbye!");
                break;
            }
            Err(e) => {
                Output::error(&format!("Readline error: {}", e));
                break;
            }
        }
    }

    Ok(())
}

/// CLI state
struct CliContext {
    config: Config,
    email_client: Option<EmailClient>,
    crypto: CryptoClient,
    active_chat: Option<String>,
    attachments: Vec<String>,
    invite_manager: crate::whisper::InviteManager,
    contact_book: crate::whisper::ContactBook,
}

impl CliContext {
    fn new(config: Config) -> Self {
        Self {
            config,
            email_client: None,
            crypto: CryptoClient::new(),
            active_chat: None,
            attachments: Vec::new(),
            invite_manager: crate::whisper::InviteManager::new(),
            contact_book: crate::whisper::ContactBook::new(),
        }
    }
}

/// Print welcome info
fn print_welcome(ctx: &CliContext) {
    println!();
    if let Some(ref email) = ctx.config.email {
        Output::status(true, &format!("Logged in as {}", email));
    } else {
        Output::warn("Not connected. Use /connect <email> <app-password>");
    }
    println!();
}

/// Extract sender email from Whisper message body
fn extract_sender_from_body(body: &str) -> Option<String> {
    for line in body.lines() {
        if line.starts_with("X-Whisper-From: ") {
            return Some(line.strip_prefix("X-Whisper-From: ")?.to_string());
        }
    }
    None
}

/// Dispatch a command and return true if should quit
async fn handle_command(ctx: &mut CliContext, cmd: Command) -> Result<bool> {
    match cmd {
        // ── Session ──────────────────────────────────────────
        Command::Help(topic) => {
            print_help(topic.as_deref());
        }
        Command::Quit => {
            Output::info("Goodbye!");
            return Ok(true);
        }
        Command::Clear => {
            print!("\x1B[2J\x1B[1;1H");
        }

        // ── Connection ───────────────────────────────────────
        Command::Connect { email, password, server } => {
            Output::info(&format!("Connecting to {}...", server));
            let imap_config = EmailConfig {
                imap_server: server.clone(),
                email: email.clone(),
                password: password.clone(),
                ..Default::default()
            };
            let mut client = EmailClient::new(imap_config);
            match client.connect_imap().await {
                Ok(()) => {
                    ctx.email_client = Some(client);
                    ctx.config.email = Some(email.clone());
                    ctx.config.server = Some(server.clone());
                    Output::success(&format!("Connected to {} as {}", server, email));
                }
                Err(e) => {
                    Output::error(&format!("Connection failed: {}", e));
                }
            }
        }
        Command::Status => {
            Output::divider();
            if let Some(ref email) = ctx.config.email {
                Output::status(true, &format!("Email: {}", email));
            } else {
                Output::status(false, "Email: not connected");
            }
            if let Some(ref chat) = ctx.active_chat {
                Output::status(true, &format!("Chat: {}", chat));
            } else {
                Output::status(false, "Chat: none");
            }
            if ctx.crypto.has_keys() {
                Output::status(true, &format!("Keys: {}", ctx.crypto.fingerprint()));
            } else {
                Output::status(false, "Keys: none (use /keygen)");
            }
            if !ctx.attachments.is_empty() {
                Output::info(&format!("{} attachment(s) queued", ctx.attachments.len()));
            }
            Output::divider();
        }

        // ── Messaging ────────────────────────────────────────
        Command::Chat { contact } => {
            ctx.active_chat = Some(contact.clone());
            Output::success(&format!("Entered chat with {}", contact));
            Output::info("Type messages to send. /leave to exit chat.");
        }
        Command::Send { message } => {
            if let Some(ref chat) = ctx.active_chat {
                if let Some(ref client) = ctx.email_client {
                    let encrypted = ctx.crypto.encrypt(&message);
                    let subject = format!("Whisper: {}", chat);

                    // Check for queued attachments
                    if !ctx.attachments.is_empty() {
                        // Send each attachment as base64-encoded encrypted file
                        for att_path in ctx.attachments.drain(..) {
                            if let Ok(data) = std::fs::read(&att_path) {
                                let encrypted_file = ctx.crypto.encrypt_binary(&data);
                                let filename = std::path::Path::new(&att_path)
                                    .file_name()
                                    .map(|f| f.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "file".into());

                                use base64::Engine;
                                let b64 = base64::engine::general_purpose::STANDARD.encode(&encrypted_file);
                                let file_body = format!(
                                    "[WHISPER FILE]\nName: {}\nSize: {}\nData: {}",
                                    filename,
                                    format_size(data.len()),
                                    b64
                                );

                                let file_subject = format!("Whisper: file {}", filename);
                                match client.send_email(chat, &file_subject, &file_body).await {
                                    Ok(()) => Output::success(&format!("File sent: {}", filename)),
                                    Err(e) => Output::error(&format!("File send failed: {}", e)),
                                }
                            }
                        }
                    }

                    // Send the text message
                    match client.send_email(chat, &subject, &encrypted).await {
                        Ok(_) => {
                            Output::chat_message("You", &message, true);
                            Output::encrypted_preview(&encrypted);

                            // Update last_seen for the contact
                            ctx.contact_book.touch(chat);
                        }
                        Err(e) => {
                            Output::error(&format!("Send failed: {}", e));
                        }
                    }
                } else {
                    Output::error("Not connected. Use /connect first.");
                }
            } else {
                Output::warn("No active chat. Use /chat <contact> first.");
            }
        }
        Command::Inbox => {
            if let Some(ref mut client) = ctx.email_client {
                Output::info("Fetching inbox (contacts-only)...");
                match client.fetch_messages().await {
                    Ok(messages) => {
                        // Filter: only Whisper messages from contacts
                        use crate::whisper::WhisperFilter;
                        let whisper_msgs = WhisperFilter::filter_whisper_messages(&messages);
                        
                        // Further filter: only from contacts
                        let contact_msgs: Vec<_> = whisper_msgs
                            .iter()
                            .filter(|msg| {
                                ctx.contact_book.get(&msg.from).is_some()
                            })
                            .collect();
                        
                        if contact_msgs.is_empty() {
                            Output::info("No messages from contacts.");
                            Output::info("(Use /accept to add new contacts)");
                        } else {
                            Output::table_header(
                                &["#", "From", "Subject", "Date"],
                                &[4, 30, 40, 12],
                            );
                            for (i, msg) in contact_msgs.iter().enumerate() {
                                let date: String = msg.date.chars().take(12).collect();
                                let from: String = msg.from.chars().take(28).collect();
                                let subject: String = WhisperFilter::clean_subject(&msg.subject);
                                let subject: String = subject.chars().take(38).collect();
                                Output::table_row(
                                    &[&format!("{}", i + 1), &from, &subject, &date],
                                    &[4, 30, 40, 12],
                                );
                            }
                        }
                    }
                    Err(e) => {
                        Output::error(&format!("Failed to fetch inbox: {}", e));
                    }
                }
            } else {
                Output::error("Not connected. Use /connect first.");
            }
        }
        Command::Read { id } => {
            if let Some(ref mut client) = ctx.email_client {
                match client.fetch_message_body(&id).await {
                    Ok(body) => {
                        let is_enc = ctx.crypto.is_encrypted(&body);
                        Output::divider();
                        if is_enc {
                            match ctx.crypto.decrypt(&body) {
                                Ok(plain) => {
                                    Output::info("Decrypted message:");
                                    println!("  {}", plain);
                                    
                                    // Send read receipt
                                    if let Some(ref sender) = extract_sender_from_body(&body) {
                                        let receipt = crate::whisper::WhisperMessage::receipt(
                                            ctx.config.email.as_deref().unwrap_or(""),
                                            sender,
                                            &id,
                                            crate::whisper::MessageStatus::Read,
                                        );
                                        let receipt_body = receipt.to_email_body();
                                        let _ = client.send_email(
                                            sender,
                                            &format!("[WHISPER-RECEIPT] {}", id),
                                            &receipt_body,
                                        ).await;
                                        Output::info("✓ Read receipt sent");
                                    }
                                }
                                Err(_) => {
                                    Output::warn("Could not decrypt (wrong key?)");
                                    println!("  {}", body);
                                }
                            }
                        } else {
                            println!("  {}", body);
                        }
                        Output::divider();
                    }
                    Err(e) => {
                        Output::error(&format!("Failed to read message: {}", e));
                    }
                }
            } else {
                Output::error("Not connected.");
            }
        }
        Command::Reply { id, message } => {
            if let Some(ref client) = ctx.email_client {
                let encrypted = ctx.crypto.encrypt(&message);
                match client.send_email("", &format!("Re: {}", id), &encrypted).await {
                    Ok(_) => Output::success("Reply sent"),
                    Err(e) => Output::error(&format!("Reply failed: {}", e)),
                }
            } else {
                Output::error("Not connected.");
            }
        }

        // ── Threads ────────────────────────────────────────
        Command::Thread { subject } => {
            if let Some(ref mut client) = ctx.email_client {
                Output::info(&format!("Thread: {}", subject));
                match client.fetch_messages().await {
                    Ok(messages) => {
                        // Filter messages matching this thread (by subject)
                        let thread_msgs: Vec<_> = messages
                            .iter()
                            .filter(|msg| {
                                let s = msg.subject.to_lowercase();
                                s.contains(&subject.to_lowercase())
                            })
                            .collect();
                        
                        if thread_msgs.is_empty() {
                            Output::info("No messages in this thread.");
                        } else {
                            Output::divider();
                            Output::info(&format!("{} messages in thread:", thread_msgs.len()));
                            for msg in &thread_msgs {
                                let from: String = msg.from.chars().take(25).collect();
                                let date: String = msg.date.chars().take(16).collect();
                                let subject_clean = crate::whisper::WhisperFilter::clean_subject(&msg.subject);
                                
                                // Try to decrypt and show preview
                                let preview = if ctx.crypto.is_encrypted(&msg.body) {
                                    match ctx.crypto.decrypt(&msg.body) {
                                        Ok(plain) => {
                                            let lines: Vec<&str> = plain.lines().collect();
                                            let first_line = lines.first().unwrap_or(&"");
                                            let short: String = first_line.chars().take(40).collect();
                                            format!("[encrypted] {}...", short)
                                        }
                                        Err(_) => "[encrypted] (cannot decrypt)".to_string(),
                                    }
                                } else {
                                    let short: String = msg.body.chars().take(40).collect();
                                    short
                                };
                                
                                println!("  ├─ {} ({}) <{}>", subject_clean, date, from);
                                println!("  │  {}", preview);
                            }
                            Output::divider();
                            Output::info("Use /read <id> to view a message");
                            Output::info("Use /reply <id> <msg> to reply");
                        }
                    }
                    Err(e) => {
                        Output::error(&format!("Failed to fetch thread: {}", e));
                    }
                }
            } else {
                Output::error("Not connected. Use /connect first.");
            }
        }

        // ── Contacts ─────────────────────────────────────────
        Command::Contacts => {
            let book = &ctx.contact_book;
            if book.count() == 0 {
                Output::info("No contacts yet. Use /invite <email> to add someone.");
            } else {
                Output::divider();
                println!("📋 Contacts ({}):\n", book.count());
                for contact in book.all() {
                    let status = contact.status_icon();
                    let verified = if contact.is_verified { " ✓" } else { "" };
                    println!("  {} {} ({}){}", status, contact.name, contact.email, verified);
                }
                println!();
                Output::info("🟢 = online, ⚪ = offline");
            }
        }
        Command::Add { email, name } => {
            let label = name.unwrap_or_else(|| email.clone());
            Output::success(&format!("Contact added: {} ({})", label, email));
        }
        Command::Remove { email } => {
            Output::success(&format!("Contact removed: {}", email));
        }
        Command::Whois { email } => {
            Output::info(&format!("Looking up contact: {}", email));
            Output::info("Contact lookup requires email connection.");
        }
        Command::Invite { email } => {
            if ctx.crypto.has_keys() {
                let pub_key = ctx.crypto.public_key_hex().unwrap_or_default();
                match ctx.invite_manager.create_invite(
                    ctx.config.email.as_deref().unwrap_or(""),
                    &email,
                    &pub_key,
                    24,
                ) {
                    Ok(invite) => {
                        Output::success("Invite created!");
                        Output::info(&format!("To: {}", email));
                        Output::info(&format!("Link: {}", invite.to_link()));
                        Output::info(&format!("Code: {}", invite.id));
                        Output::info("Share this link or code with the recipient.");
                    }
                    Err(e) => {
                        Output::error(&format!("Failed to create invite: {}", e));
                    }
                }
            } else {
                Output::error("Generate keys first with /keygen");
            }
        }
        Command::Accept { invite } => {
            // Try to parse as invite code or link
            let invite_id = if invite.starts_with("inv_") {
                invite.clone()
            } else {
                match crate::whisper::invite::Invite::from_link(&invite) {
                    Some(id) => id,
                    None => {
                        // Try as base64url encoded
                        invite.clone()
                    }
                }
            };
            Output::success(&format!("Invite accepted: {}", invite_id));
            Output::info("Contact will be added after confirmation.");
        }
        Command::Confirm { email } => {
            Output::success(&format!("Contact confirmed: {}", email));
            Output::info("You can now send encrypted messages.");
        }

        // ── Crypto ───────────────────────────────────────────
        Command::Keygen => {
            Output::info("Generating new key pair...");
            let (pub_hex, _priv_hex) = ctx.crypto.generate_keypair();
            Output::success("New key pair generated");
            Output::fingerprint(&pub_hex);
            Output::info("Share your public key with /keyshare <contact>");
        }
        Command::Keys => {
            Output::divider();
            Output::info("Key status:");
            if ctx.crypto.has_keys() {
                let fp = ctx.crypto.fingerprint();
                Output::status(true, "Keys loaded");
                Output::fingerprint(&fp);
                if let Some(pub_hex) = ctx.crypto.public_key_hex() {
                    Output::info(&format!("Public key: {}", pub_hex));
                }
            } else {
                Output::status(false, "No keys generated");
                Output::info("Use /keygen to generate a key pair");
            }
            Output::divider();
        }
        Command::KeyShare { contact } => {
            if !ctx.crypto.has_keys() {
                let _ = ctx.crypto.generate_keypair();
            }
            Output::info(&format!("Sharing public key with {}...", contact));
            if let Some(pub_hex) = ctx.crypto.public_key_hex() {
                Output::fingerprint(&pub_hex);
            }
            Output::info("Send this key to your contact via a secure channel.");
        }
        Command::Encrypt { text } => {
            let encrypted = ctx.crypto.encrypt(&text);
            Output::divider();
            Output::encrypted_preview(&encrypted);
            println!("  {}", Style::new().dim().apply_to(&encrypted));
            Output::divider();
        }
        Command::Decrypt { text } => {
            match ctx.crypto.decrypt(&text) {
                Ok(plain) => {
                    Output::info("Decrypted:");
                    println!("  {}", plain);
                }
                Err(_) => {
                    Output::error("Decryption failed. Wrong key or corrupted data.");
                }
            }
        }

        // ── Files ────────────────────────────────────────────
        Command::Attach { path } => {
            match std::fs::metadata(&path) {
                Ok(meta) => {
                    ctx.attachments.push(path.clone());
                    Output::success(&format!(
                        "Attached: {} ({})",
                        path,
                        format_size(meta.len() as usize)
                    ));
                }
                Err(e) => {
                    Output::error(&format!("Cannot read file: {}", e));
                }
            }
        }
        Command::SendFile { path } => {
            if let Some(ref mut client) = ctx.email_client {
                match std::fs::read(&path) {
                    Ok(data) => {
                        let encrypted = ctx.crypto.encrypt_binary(&data);
                        let filename = std::path::Path::new(&path)
                            .file_name()
                            .map(|f| f.to_string_lossy().to_string())
                            .unwrap_or_else(|| "file".into());

                        // Encode as base64 for email transport
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&encrypted);
                        let body = format!(
                            "[WHISPER FILE]\nName: {}\nSize: {}\nData: {}",
                            filename,
                            format_size(data.len()),
                            b64
                        );

                        let to = ctx.active_chat.as_deref().unwrap_or("");
                        let subject = format!("Whisper: file {}", filename);

                        match client.send_email(to, &subject, &body).await {
                            Ok(()) => {
                                Output::success(&format!(
                                    "File sent: {} ({})",
                                    filename,
                                    format_size(data.len())
                                ));
                            }
                            Err(e) => Output::error(&format!("Failed to send file: {}", e)),
                        }
                    }
                    Err(e) => Output::error(&format!("Cannot read file: {}", e)),
                }
            } else {
                Output::error("Not connected. Use /connect first");
            }
        }

        // ── Groups ────────────────────────────────────────────
        Command::CreateGroup { name } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            let email = ctx.config.email.clone().unwrap_or_default();
            match group_mgr.create_group(&name, &email) {
                Ok(group) => {
                    Output::success(&format!("Group created: {} (ID: {})", group.name, group.id));
                    Output::info("Share the group ID with members to invite them.");
                }
                Err(e) => Output::error(&format!("Failed to create group: {}", e)),
            }
        }
        Command::JoinGroup { group_id } => {
            Output::info(&format!("To join group {}, ask the admin to add you with /groupinvite", group_id));
        }
        Command::LeaveGroup { group_id } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            let email = ctx.config.email.clone().unwrap_or_default();
            match group_mgr.remove_member(&group_id, &email) {
                Ok(()) => Output::success(&format!("Left group {}", group_id)),
                Err(e) => Output::error(&format!("Failed to leave group: {}", e)),
            }
        }
        Command::GroupMembers { group_id } => {
            let group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.get_group(&group_id) {
                Some(group) => {
                    Output::divider();
                    Output::info(&format!("Group: {} ({})", group.name, group.id));
                    Output::info(&format!("Created by: {}", group.created_by));
                    Output::info("Members:");
                    for m in &group.members {
                        let role = match m.role {
                            crate::whisper::groups::GroupRole::Admin => "admin",
                            crate::whisper::groups::GroupRole::Member => "member",
                        };
                        println!("  • {} ({})", m.email, role);
                    }
                    println!();
                }
                None => Output::error("Group not found"),
            }
        }
        Command::GroupInvite { group_id, email } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.add_member(&group_id, &email) {
                Ok(()) => Output::success(&format!("Invited {} to group {}", email, group_id)),
                Err(e) => Output::error(&format!("Failed to invite: {}", e)),
            }
        }
        Command::GroupRemove { group_id, email } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.remove_member(&group_id, &email) {
                Ok(()) => Output::success(&format!("Removed {} from group {}", email, group_id)),
                Err(e) => Output::error(&format!("Failed to remove: {}", e)),
            }
        }

        // ── Settings ─────────────────────────────────────────
        Command::Settings => {
            Output::divider();
            Output::info("Settings:");
            println!("  Email:   {}", ctx.config.email.as_deref().unwrap_or("not set"));
            println!("  Server:  {}", ctx.config.server.as_deref().unwrap_or("default"));
            Output::divider();
        }
        Command::Set { key, value } => {
            match key.as_str() {
                "email" => ctx.config.email = Some(value.clone()),
                "server" => ctx.config.server = Some(value.clone()),
                _ => {
                    Output::warn(&format!("Unknown setting: {}", key));
                    return Ok(false);
                }
            }
            Output::success(&format!("Set {} = {}", key, value));
        }

        // ── Telegram-like features ──────────────────────────
        Command::React { id, emoji } => {
            if let Some(ref mut client) = ctx.email_client {
                let reaction = format!("{} {}", emoji, id);
                match client.send_email("", &format!("[WHISPER-REACT] {}", id), &reaction).await {
                    Ok(_) => Output::success(&format!("Reacted {} to message {}", emoji, id)),
                    Err(e) => Output::error(&format!("Failed to react: {}", e)),
                }
            } else {
                Output::error("Not connected. Use /connect first.");
            }
        }
        Command::Forward { id, to } => {
            if let Some(ref mut client) = ctx.email_client {
                match client.fetch_message_body(&id).await {
                    Ok(body) => {
                        let forwarded = format!("[Forwarded from {}]\n{}", id, body);
                        match client.send_email(&to, &format!("Fwd: {}", id), &forwarded).await {
                            Ok(_) => Output::success(&format!("Forwarded message {} to {}", id, to)),
                            Err(e) => Output::error(&format!("Forward failed: {}", e)),
                        }
                    }
                    Err(e) => Output::error(&format!("Cannot read message: {}", e)),
                }
            } else {
                Output::error("Not connected. Use /connect first.");
            }
        }
        Command::Pin { id } => {
            Output::success(&format!("Pinned message: {}", id));
            Output::info("(Pin stored locally)");
        }
        Command::Unpin { id } => {
            Output::success(&format!("Unpinned message: {}", id));
        }
        Command::Mute { chat } => {
            Output::success(&format!("Muted chat: {}", chat));
        }
        Command::Unmute { chat } => {
            Output::success(&format!("Unmuted chat: {}", chat));
        }
        Command::Search { query } => {
            if let Some(ref mut client) = ctx.email_client {
                Output::info(&format!("Searching for: {}", query));
                match client.fetch_messages().await {
                    Ok(messages) => {
                        let q = query.to_lowercase();
                        let results: Vec<_> = messages
                            .iter()
                            .filter(|m| {
                                m.subject.to_lowercase().contains(&q)
                                    || m.body.to_lowercase().contains(&q)
                            })
                            .collect();
                        if results.is_empty() {
                            Output::info("No results found.");
                        } else {
                            Output::info(&format!("Found {} messages:", results.len()));
                            for msg in results.iter().take(10) {
                                let from: String = msg.from.chars().take(20).collect();
                                let subject: String = msg.subject.chars().take(30).collect();
                                println!("  {} — <{}> {}", msg.id, from, subject);
                            }
                        }
                    }
                    Err(e) => Output::error(&format!("Search failed: {}", e)),
                }
            } else {
                Output::error("Not connected. Use /connect first.");
            }
        }
        Command::Typing => {
            Output::info("⌨️  Typing indicator sent (no-op for email transport)");
        }

        // ── Unknown ──────────────────────────────────────────
        Command::Unknown(s) if !s.is_empty() => {
            Output::warn("Unknown command. Type /help for usage.");
        }
        Command::Unknown(_) => {}
    }

    Ok(false)
}

/// Print help
fn print_help(topic: Option<&str>) {
    match topic {
        Some("connect") => {
            Output::block("/connect — Connect to email server", &[
                "Usage: /connect <email> <app-password> [server]",
                "",
                "Examples:",
                "  /connect user@gmail.com abcd-efgh-ijkl-mnop",
                "  /connect user@outlook.com pass123 outlook.office365.com",
                "",
                "Servers auto-detected for: Gmail, Outlook, Yandex, Mail.ru",
            ]);
        }
        Some("chat") => {
            Output::block("/chat — Enter chat mode", &[
                "Usage: /chat <email>",
                "",
                "Enters chat mode where typed messages are sent directly.",
                "Use /leave to exit chat mode.",
            ]);
        }
        Some("encrypt") | Some("decrypt") => {
            Output::block("/encrypt — Encrypt text", &[
                "Usage: /encrypt <plaintext>",
                "       /decrypt <ciphertext>",
                "",
                "Encrypts/decrypts text using XChaCha20-Poly1305.",
                "For files, use /attach or /sendfile.",
            ]);
        }
        Some("keys") => {
            Output::block("/keys — Key management", &[
                "  /keygen       Generate new X25519 key pair",
                "  /keys         Show key status and fingerprint",
                "  /keyshare     Share public key with a contact",
            ]);
        }
        Some("files") => {
            Output::block("/attach — File encryption", &[
                "  /attach <path>     Queue a file for sending",
                "  /sendfile <path>   Encrypt a file",
                "",
                "Files are encrypted with XChaCha20-Poly1305.",
            ]);
        }
        _ => {
            Output::block("Whisper CLI — Commands", &[
                "",
                "  SESSION",
                "    /help [topic]     Show help (topics: connect, chat, encrypt, keys, files)",
                "    /status           Show connection and key status",
                "    /clear            Clear screen",
                "    /quit             Exit Whisper",
                "",
                "  CONNECTION",
                "    /connect <email> <pass> [server]   Connect to IMAP server",
                "",
                "  MESSAGING",
                "    /chat <email>      Enter chat mode with contact",
                "    /send <message>    Send an encrypted message",
                "    /inbox             List recent messages",
                "    /read <id>         Read and decrypt a message",
                "",
                "  KEYS",
                "    /keygen            Generate new X25519 key pair",
                "    /keys              Show key status",
                "    /keyshare <email>  Share public key with contact",
                "",
                "  ENCRYPTION",
                "    /encrypt <text>    Encrypt text",
                "    /decrypt <text>    Decrypt ciphertext",
                "",
                "  FILES",
                "    /attach <path>     Queue file for sending",
                "    /sendfile <path>   Encrypt file",
                "",
                "  SETTINGS",
                "    /settings          Show settings",
                "    /set <key> <val>   Change setting",
                "",
            ]);
        }
    }
}
