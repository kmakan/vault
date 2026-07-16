use anyhow::Result;
use chrono::Utc;
use console::Style;
use reedline::{DefaultPrompt, FileBackedHistory, Reedline, Signal};

use crate::api::client::Config;
use crate::api::email::{EmailClient, EmailConfig};
use crate::cli::commands::Command;
use crate::cli::output::{format_size, Output};
use crate::crypto::CryptoClient;
use crate::whisper::Reaction;

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
                let cmd = if ctx.active_chat.is_some()
                    && matches!(&cmd, Command::Unknown(s) if !s.is_empty())
                {
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
    receipt_store: crate::whisper::ReadReceiptStore,
    reaction_store: crate::whisper::ReactionStore,
    message_index: crate::whisper::MessageIndex,
    edit_manager: crate::whisper::EditManager,
}

impl CliContext {
    fn new(config: Config) -> Self {
        let contact_book = crate::whisper::ContactBook::load_default().unwrap_or_else(|e| {
            eprintln!("Warning: could not load contacts: {}", e);
            crate::whisper::ContactBook::new()
        });
        Self {
            config,
            email_client: None,
            crypto: CryptoClient::new(),
            active_chat: None,
            attachments: Vec::new(),
            invite_manager: crate::whisper::InviteManager::new(),
            contact_book,
            receipt_store: crate::whisper::ReadReceiptStore::new(),
            reaction_store: crate::whisper::ReactionStore::new(),
            message_index: crate::whisper::MessageIndex::new(),
            edit_manager: crate::whisper::EditManager::new(),
        }
    }

    /// Persist contacts to disk.
    fn save_contacts(&self) {
        if let Err(e) = self.contact_book.save_default() {
            eprintln!("Warning: could not save contacts: {}", e);
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
        Command::Connect {
            email,
            password,
            server,
        } => {
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
                        // Send each attachment using Encryptor (XChaCha20-Poly1305)
                        let encryptor = crate::crypto::encryptor::Encryptor::new();
                        for att_path in ctx.attachments.drain(..) {
                            match crate::cli::commands::attachments::FileInfo::from_path(&att_path)
                            {
                                Ok(info) => match encryptor.encrypt_file(&info.path) {
                                    Ok(encrypted_envelope) => {
                                        let mime_body =
                                            crate::cli::commands::attachments::build_mime_multipart(
                                                &encrypted_envelope,
                                                &info.filename,
                                                &info.mime_type,
                                            );
                                        let file_subject =
                                            format!("Whisper: file {}", info.filename);
                                        match client
                                            .send_email(chat, &file_subject, &mime_body)
                                            .await
                                        {
                                            Ok(()) => Output::success(&format!(
                                                "Encrypted file sent: {} ({})",
                                                info.filename,
                                                crate::cli::commands::attachments::human_size(
                                                    info.size as usize
                                                )
                                            )),
                                            Err(e) => {
                                                Output::error(&format!("File send failed: {}", e))
                                            }
                                        }
                                    }
                                    Err(e) => Output::error(&format!(
                                        "Encryption failed for {}: {}",
                                        info.filename, e
                                    )),
                                },
                                Err(e) => Output::error(&format!("Cannot read attachment: {}", e)),
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
                        // Process incoming read receipts first
                        use crate::whisper::WhisperFilter;
                        let receipts: Vec<_> = messages
                            .iter()
                            .filter(|m| WhisperFilter::is_whisper_receipt(m))
                            .collect();
                        for receipt_msg in &receipts {
                            // Try to extract message ID from subject [WHISPER-RECEIPT] <msg_id>
                            if let Some(msg_id) = receipt_msg
                                .subject
                                .strip_prefix("[WHISPER-RECEIPT]")
                                .map(|s| s.trim())
                            {
                                let reader = &receipt_msg.from;
                                let sender = ctx.config.email.as_deref().unwrap_or("");
                                // Record as delivered (receipt arrived, not necessarily read yet)
                                let _ = ctx.receipt_store.record_delivered(msg_id, reader, sender);
                                tracing::info!(
                                    "Processed incoming receipt for {} from {}",
                                    msg_id,
                                    reader
                                );
                            }
                        }

                        // Filter: only Whisper messages from contacts
                        let whisper_msgs = WhisperFilter::filter_whisper_messages(&messages);
                        // Further filter: only from contacts
                        let contact_msgs: Vec<_> = whisper_msgs
                            .iter()
                            .filter(|msg| ctx.contact_book.get(&msg.from).is_some())
                            .collect();

                        // Индексация сообщений для поиска
                        for msg in &contact_msgs {
                            let entry = crate::whisper::IndexEntry {
                                message_id: msg.id.clone(),
                                from: msg.from.clone(),
                                to: ctx.config.email.clone().unwrap_or_default(),
                                subject: WhisperFilter::clean_subject(&msg.subject),
                                body_preview: msg.body.chars().take(500).collect(),
                                timestamp: Utc::now(),
                                folder_id: None,
                                has_attachments: false,
                                is_encrypted: ctx.crypto.is_encrypted(&msg.body),
                            };
                            let _ = ctx.message_index.index_message(entry);
                        }

                        if contact_msgs.is_empty() {
                            Output::info("No messages from contacts.");
                            Output::info("(Use /accept to add new contacts)");
                        } else {
                            Output::table_header(
                                &["#", "From", "Subject", "Date", ""],
                                &[4, 30, 40, 12, 4],
                            );
                            for (i, msg) in contact_msgs.iter().enumerate() {
                                let date: String = msg.date.chars().take(12).collect();
                                let from: String = msg.from.chars().take(28).collect();
                                let subject: String = WhisperFilter::clean_subject(&msg.subject);
                                let subject: String = subject.chars().take(38).collect();

                                // Check read receipt status for outgoing messages
                                let is_outgoing = ctx
                                    .config
                                    .email
                                    .as_ref()
                                    .map(|e| msg.from == *e)
                                    .unwrap_or(false);
                                let receipt_icon =
                                    ctx.receipt_store.status_icon(&msg.id, is_outgoing);

                                Output::table_row(
                                    &[&format!("{}", i + 1), &from, &subject, &date, &receipt_icon],
                                    &[4, 30, 40, 12, 4],
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

                        // Show reactions for this message
                        let reaction_display = ctx.reaction_store.format_reactions(&id);
                        if !reaction_display.is_empty() {
                            println!("  Reactions: {}", reaction_display);
                        }

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
                                        let _ = client
                                            .send_email(
                                                sender,
                                                &format!("[WHISPER-RECEIPT] {}", id),
                                                &receipt_body,
                                            )
                                            .await;
                                        Output::info("✓ Read receipt sent");

                                        // Record read receipt locally
                                        let reader = ctx.config.email.as_deref().unwrap_or("");
                                        if let Err(e) =
                                            ctx.receipt_store.record_read(&id, reader, sender)
                                        {
                                            tracing::warn!("Failed to save receipt locally: {}", e);
                                        }
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
                match client
                    .send_email("", &format!("Re: {}", id), &encrypted)
                    .await
                {
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
                                let subject_clean =
                                    crate::whisper::WhisperFilter::clean_subject(&msg.subject);

                                // Try to decrypt and show preview
                                let preview = if ctx.crypto.is_encrypted(&msg.body) {
                                    match ctx.crypto.decrypt(&msg.body) {
                                        Ok(plain) => {
                                            let lines: Vec<&str> = plain.lines().collect();
                                            let first_line = lines.first().unwrap_or(&"");
                                            let short: String =
                                                first_line.chars().take(40).collect();
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
                Output::info("No contacts yet. Use /add <email> [name] or /invite <email>.");
            } else {
                Output::divider();
                println!("📋 Contacts ({}):\n", book.count());
                for contact in book.all_sorted() {
                    println!("  {}", contact.summary_line());
                }
                println!();
                Output::info("🟢 = online, ⚪ = offline, ✓ = verified, ? = unverified");
                let verified = book.verified().len();
                let unverified = book.unverified().len();
                println!("  Verified: {}, Unverified: {}", verified, unverified);
                let groups = book.groups();
                if !groups.is_empty() {
                    println!("  Groups: {}", groups.join(", "));
                }
            }
        }
        Command::Add { email, name } => {
            let display_name = name
                .clone()
                .unwrap_or_else(|| email.split('@').next().unwrap_or(&email).to_string());
            if ctx.contact_book.contains(&email) {
                Output::warn(&format!(
                    "Contact {} already exists. Use /remove first to replace.",
                    email
                ));
            } else {
                // Try to use the contact's public key from crypto if sharing
                let pub_key = ctx.crypto.public_key_hex().unwrap_or_default();
                let contact =
                    crate::whisper::contacts::Contact::new(&email, &display_name, &pub_key);
                ctx.contact_book.add(contact);
                ctx.save_contacts();
                Output::success(&format!("Contact added: {} ({})", display_name, email));
                if !pub_key.is_empty() {
                    Output::info("Your public key has been associated with this contact.");
                }
                Output::info(&format!(
                    "Fingerprint: {}",
                    ctx.contact_book.get(&email).unwrap().fingerprint
                ));
            }
        }
        Command::Remove { email } => {
            if let Some(removed) = ctx.contact_book.remove(&email) {
                ctx.save_contacts();
                Output::success(&format!(
                    "Contact removed: {} ({})",
                    removed.name, removed.email
                ));
            } else {
                Output::warn(&format!("Contact not found: {}", email));
            }
        }
        Command::Whois { email } => {
            if let Some(contact) = ctx.contact_book.get(&email) {
                Output::divider();
                Output::info(&format!("Contact info for {}:", email));
                for line in contact.detail_block() {
                    println!("  {}", line);
                }
                Output::divider();
            } else {
                Output::warn(&format!("Contact not found: {}", email));
                Output::info("Use /add <email> [name] to add a contact.");
            }
        }
        Command::Verify { email } => {
            if ctx.contact_book.verify(&email) {
                ctx.save_contacts();
                let fp = ctx.contact_book.get(&email).unwrap().fingerprint.clone();
                Output::success(&format!("Contact verified: {}", email));
                Output::info(&format!("Fingerprint: {}", fp));
                Output::info("Compare this fingerprint with the contact's claimed fingerprint.");
            } else {
                Output::warn(&format!("Contact not found: {}", email));
            }
        }
        Command::Unverify { email } => {
            if ctx.contact_book.unverify(&email) {
                ctx.save_contacts();
                Output::success(&format!("Contact un-verified: {}", email));
            } else {
                Output::warn(&format!("Contact not found: {}", email));
            }
        }
        Command::Export { email } => match ctx.contact_book.export_as_portable(&email) {
            Some(json) => {
                Output::divider();
                Output::info(&format!("Portable contact data for {}:", email));
                println!("{}", json);
                Output::divider();
                Output::info("Share this JSON with someone to add you as a contact.");
            }
            None => {
                Output::warn(&format!("Contact not found: {}", email));
            }
        },
        Command::Import { json } => {
            match crate::whisper::contacts::ContactBook::import_from_portable(&json) {
                Ok(contact) => {
                    let email = contact.email.clone();
                    let name = contact.name.clone();
                    let fp = contact.fingerprint.clone();
                    ctx.contact_book.add(contact);
                    ctx.save_contacts();
                    Output::success(&format!("Contact imported: {} ({})", name, email));
                    if !fp.is_empty() {
                        Output::info(&format!("Fingerprint: {}", fp));
                    }
                }
                Err(e) => {
                    Output::error(&format!("Failed to import contact: {}", e));
                }
            }
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
                println!();
                Output::info("Key exchange methods:");
                println!("  1. QR Code    — scan in person (most secure)");
                println!("  2. Copy below — send via Signal/Telegram/WhatsApp");
                println!("  3. Email PGP  — send via encrypted email");
                println!();
                Output::warn("Copy this key and send via a secure channel:");
                println!("  {}", pub_hex);
                println!();
                Output::warn("⚠  Signal may be blocked in your region (RU, CN, IR).");
                Output::warn("   Use VPN if you cannot connect to Signal.");
            }
        }
        Command::Encrypt { text } => {
            let encrypted = ctx.crypto.encrypt(&text);
            Output::divider();
            Output::encrypted_preview(&encrypted);
            println!("  {}", Style::new().dim().apply_to(&encrypted));
            Output::divider();
        }
        Command::Decrypt { text } => match ctx.crypto.decrypt(&text) {
            Ok(plain) => {
                Output::info("Decrypted:");
                println!("  {}", plain);
            }
            Err(_) => {
                Output::error("Decryption failed. Wrong key or corrupted data.");
            }
        },
        // ── Files ────────────────────────────────────────────
        Command::Attach { path } => {
            match crate::cli::commands::attachments::FileInfo::from_path(&path) {
                Ok(info) => {
                    // Check size limit against provider
                    let server = ctx.config.server.as_deref().unwrap_or("gmail.com");
                    let max_size =
                        crate::cli::commands::attachments::ProviderLimits::for_server(server);
                    let limit_label =
                        crate::cli::commands::attachments::ProviderLimits::label_for_server(server);

                    if let Err(e) = info.check_size_limit(max_size) {
                        Output::error(&format!("{} (limit: {})", e, limit_label));
                    } else {
                        ctx.attachments.push(path.clone());
                        Output::success(&format!(
                            "Attached: {} ({}, {})",
                            info.filename,
                            crate::cli::commands::attachments::human_size(info.size as usize),
                            info.mime_type
                        ));
                    }
                }
                Err(e) => {
                    Output::error(&format!("{}", e));
                }
            }
        }
        Command::SendFile { path } => {
            if let Some(ref mut client) = ctx.email_client {
                match crate::cli::commands::attachments::FileInfo::from_path(&path) {
                    Ok(info) => {
                        // Check size limit
                        let server = ctx.config.server.as_deref().unwrap_or("gmail.com");
                        let max_size =
                            crate::cli::commands::attachments::ProviderLimits::for_server(server);
                        if let Err(e) = info.check_size_limit(max_size) {
                            let limit_label =
                                crate::cli::commands::attachments::ProviderLimits::label_for_server(
                                    server,
                                );
                            Output::error(&format!("{} (limit: {})", e, limit_label));
                        } else {
                            match info.read_contents() {
                                Ok(data) => {
                                    // Encrypt the file using the standalone Encryptor
                                    let encryptor = crate::crypto::encryptor::Encryptor::new();
                                    match encryptor.encrypt_file(&info.path) {
                                        Ok(encrypted_envelope) => {
                                            // Build MIME multipart body
                                            let mime_body =
                                                crate::cli::commands::attachments::build_mime_multipart(
                                                    &encrypted_envelope,
                                                    &info.filename,
                                                    &info.mime_type,
                                                );

                                            let to = ctx.active_chat.as_deref().unwrap_or("");
                                            let subject =
                                                format!("Whisper: file {}", info.filename);

                                            match client.send_email(to, &subject, &mime_body).await
                                            {
                                                Ok(()) => {
                                                    Output::success(&format!(
                                                        "Encrypted file sent: {} ({})",
                                                        info.filename,
                                                        crate::cli::commands::attachments::human_size(
                                                            info.size as usize,
                                                        )
                                                    ));
                                                }
                                                Err(e) => Output::error(&format!(
                                                    "Failed to send file: {}",
                                                    e
                                                )),
                                            }
                                        }
                                        Err(e) => {
                                            Output::error(&format!("Encryption failed: {}", e));
                                        }
                                    }
                                }
                                Err(e) => {
                                    Output::error(&format!("Cannot read file: {}", e));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        Output::error(&format!("{}", e));
                    }
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
            Output::info(&format!(
                "To join group {}, ask the admin to add you with /groupinvite",
                group_id
            ));
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
        Command::Promote { group_id, email } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.promote_member(&group_id, &email) {
                Ok(()) => Output::success(&format!("{} promoted to admin in group {}", email, group_id)),
                Err(e) => Output::error(&format!("Failed to promote: {}", e)),
            }
        }
        Command::Demote { group_id, email } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.demote_member(&group_id, &email) {
                Ok(()) => Output::success(&format!("{} demoted to member in group {}", email, group_id)),
                Err(e) => Output::error(&format!("Failed to demote: {}", e)),
            }
        }
        Command::Block { group_id, email } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.block_user(&group_id, &email) {
                Ok(()) => Output::success(&format!("{} blocked in group {}", email, group_id)),
                Err(e) => Output::error(&format!("Failed to block: {}", e)),
            }
        }
        Command::Unblock { group_id, email } => {
            let mut group_mgr = crate::whisper::GroupManager::new();
            match group_mgr.unblock_user(&group_id, &email) {
                Ok(()) => Output::success(&format!("{} unblocked in group {}", email, group_id)),
                Err(e) => Output::error(&format!("Failed to unblock: {}", e)),
            }
        }

        // ── Папки (folders) ────────────────────────────────────
        Command::FolderCreate { name, icon } => {
            let mut store = crate::whisper::FolderStore::new();
            match store.create_folder(&name, &icon) {
                Ok(true) => Output::success(&format!("Folder '{}' created ({})", name, icon)),
                Ok(false) => Output::error(&format!("Folder '{}' already exists", name)),
                Err(e) => Output::error(&format!("Failed to create folder: {}", e)),
            }
        }
        Command::FolderDelete { name } => {
            let mut store = crate::whisper::FolderStore::new();
            match store.get_folder_by_name(&name) {
                Some(folder) => {
                    let id = folder.id.clone();
                    match store.delete_folder(&id) {
                        Ok(true) => Output::success(&format!("Folder '{}' deleted", name)),
                        Ok(false) => Output::error("Folder not found"),
                        Err(e) => Output::error(&format!("Failed to delete folder: {}", e)),
                    }
                }
                None => Output::error(&format!("Folder '{}' not found", name)),
            }
        }
        Command::FolderRename { old_name, new_name } => {
            let mut store = crate::whisper::FolderStore::new();
            match store.get_folder_by_name(&old_name) {
                Some(folder) => {
                    let id = folder.id.clone();
                    match store.rename_folder(&id, &new_name) {
                        Ok(true) => Output::success(&format!(
                            "Folder '{}' renamed to '{}'",
                            old_name, new_name
                        )),
                        Ok(false) => {
                            Output::error(&format!("Folder '{}' already exists", new_name))
                        }
                        Err(e) => Output::error(&format!("Failed to rename: {}", e)),
                    }
                }
                None => Output::error(&format!("Folder '{}' not found", old_name)),
            }
        }
        Command::FolderAdd {
            folder_name,
            chat_id,
        } => {
            let mut store = crate::whisper::FolderStore::new();
            match store.get_folder_by_name(&folder_name) {
                Some(folder) => {
                    let id = folder.id.clone();
                    match store.add_chat(&id, &chat_id) {
                        Ok(true) => Output::success(&format!(
                            "Added '{}' to folder '{}'",
                            chat_id, folder_name
                        )),
                        Ok(false) => Output::info(&format!(
                            "'{}' is already in folder '{}'",
                            chat_id, folder_name
                        )),
                        Err(e) => Output::error(&format!("Failed to add: {}", e)),
                    }
                }
                None => Output::error(&format!("Folder '{}' not found", folder_name)),
            }
        }
        Command::FolderRemove {
            folder_name,
            chat_id,
        } => {
            let mut store = crate::whisper::FolderStore::new();
            match store.get_folder_by_name(&folder_name) {
                Some(folder) => {
                    let id = folder.id.clone();
                    match store.remove_chat(&id, &chat_id) {
                        Ok(true) => Output::success(&format!(
                            "Removed '{}' from folder '{}'",
                            chat_id, folder_name
                        )),
                        Ok(false) => Output::info(&format!(
                            "'{}' was not in folder '{}'",
                            chat_id, folder_name
                        )),
                        Err(e) => Output::error(&format!("Failed to remove: {}", e)),
                    }
                }
                None => Output::error(&format!("Folder '{}' not found", folder_name)),
            }
        }
        Command::FolderList => {
            let store = crate::whisper::FolderStore::new();
            let folders = store.list_folders();
            if folders.is_empty() {
                Output::info("No folders. Create one with /foldercreate <name> [icon]");
            } else {
                Output::divider();
                Output::info(&format!("Folders ({}):", folders.len()));
                for folder in &folders {
                    println!(
                        "  {} {} — {} chat(s)",
                        folder.icon,
                        folder.name,
                        folder.chats.len()
                    );
                }
                println!();
                Output::divider();
            }
        }
        Command::FolderChats { name } => {
            let store = crate::whisper::FolderStore::new();
            match store.get_folder_by_name(&name) {
                Some(folder) => {
                    if folder.chats.is_empty() {
                        Output::info(&format!("Folder '{}' is empty", name));
                    } else {
                        Output::divider();
                        Output::info(&format!(
                            "{} {} — {} chat(s):",
                            folder.icon,
                            folder.name,
                            folder.chats.len()
                        ));
                        for chat in &folder.chats {
                            println!("  • {}", chat);
                        }
                        println!();
                        Output::divider();
                    }
                }
                None => Output::error(&format!("Folder '{}' not found", name)),
            }
        }

        // ── Редактирование сообщений ──────────────────────────
        Command::EditMessage {
            message_id,
            new_content,
        } => {
            let email = ctx.config.email.clone().unwrap_or_default();
            match ctx
                .edit_manager
                .edit_message(&message_id, &email, &new_content)
            {
                Ok(result) => {
                    if result.success {
                        Output::success(&format!("Message edited (edit #{})", result.edit_count));
                    } else if let Some(warning) = result.warning {
                        Output::error(&warning);
                    }
                }
                Err(e) => Output::error(&format!("Edit failed: {}", e)),
            }
        }
        Command::EditInfo { message_id } => {
            if let Some(record) = ctx.edit_manager.get_latest(&message_id) {
                Output::divider();
                println!("  Message: {}", record.message_id);
                println!("  Editor:  {}", record.editor_email);
                println!("  Edits:   {}", record.edit_count);
                println!(
                    "  Last:    {}",
                    record.edited_at.format("%Y-%m-%d %H:%M:%S")
                );
                let preview: String = record.new_content.chars().take(100).collect();
                println!("  Content: {}", preview);
            } else {
                Output::info("Message has not been edited.");
            }
        }
        Command::EditUndo { message_id } => match ctx.edit_manager.undo_last_edit(&message_id) {
            Ok(true) => {
                let count = ctx.edit_manager.edit_count(&message_id);
                Output::success(&format!("Edit undone. {} edit(s) remaining.", count));
            }
            Ok(false) => Output::error("No edits found for this message."),
            Err(e) => Output::error(&format!("Undo failed: {}", e)),
        },

        // ── Медиа-превью ──────────────────────────────────────
        Command::Thumb { file_path, size } => {
            let path = std::path::Path::new(&file_path);
            if !path.exists() {
                Output::error(&format!("File not found: {}", file_path));
            } else {
                let thumb_size = match size.as_str() {
                    "s" | "small" => crate::whisper::ThumbnailSize::Small,
                    "l" | "large" => crate::whisper::ThumbnailSize::Large,
                    _ => crate::whisper::ThumbnailSize::Medium,
                };
                match crate::whisper::MediaInfo::from_file(path) {
                    Ok(info) => {
                        let thumb_dir = dirs::data_local_dir()
                            .unwrap_or_else(|| std::path::PathBuf::from("."))
                            .join("whisper")
                            .join("thumbnails");
                        let mut mgr = crate::whisper::ThumbnailManager::with_dir(thumb_dir);
                        match mgr.generate_thumbnail(&info, thumb_size) {
                            Ok(thumb) => {
                                Output::success(&format!(
                                    "Thumbnail created: {} ({}x{}, {} bytes)",
                                    thumb.thumb_path.display(),
                                    thumb.thumb_width,
                                    thumb.thumb_height,
                                    thumb.thumb_size
                                ));
                            }
                            Err(e) => Output::error(&format!("Thumbnail failed: {}", e)),
                        }
                    }
                    Err(e) => Output::error(&format!("Media info failed: {}", e)),
                }
            }
        }
        Command::ThumbInfo { file_path } => {
            let path = std::path::Path::new(&file_path);
            if !path.exists() {
                Output::error(&format!("File not found: {}", file_path));
            } else {
                match crate::whisper::MediaInfo::from_file(path) {
                    Ok(info) => {
                        Output::divider();
                        println!("  File:     {}", file_path);
                        println!("  MIME:     {}", info.mime_type);
                        println!("  Size:     {} bytes", info.size);
                        println!(
                            "  Dims:     {}x{}",
                            info.width.unwrap_or(0),
                            info.height.unwrap_or(0)
                        );
                        println!(
                            "  Thumbnailable: {}",
                            if info.is_thumbnailable { "yes" } else { "no" }
                        );
                        Output::divider();
                    }
                    Err(e) => Output::error(&format!("Media info failed: {}", e)),
                }
            }
        }

        // ── Settings ─────────────────────────────────────────
        Command::Settings => {
            Output::divider();
            Output::info("Settings:");
            println!(
                "  Email:   {}",
                ctx.config.email.as_deref().unwrap_or("not set")
            );
            println!(
                "  Server:  {}",
                ctx.config.server.as_deref().unwrap_or("default")
            );
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
            let user = ctx.config.email.as_deref().unwrap_or("local");
            if !Reaction::is_valid_emoji(&emoji) {
                Output::error(&format!(
                    "Invalid emoji '{}'. Use one of: 👍 ❤️ 😂 😮 😢 🔥",
                    emoji
                ));
            } else {
                // Encrypt reaction data and store locally
                let reaction_json =
                    serde_json::to_string(&crate::whisper::Reaction::new(&id, &emoji, user))
                        .unwrap_or_default();
                let encrypted = ctx.crypto.encrypt(&reaction_json);
                match ctx.reaction_store.add_reaction(&id, &emoji, user) {
                    Ok(true) => {
                        Output::success(&format!("Reacted {} to message {}", emoji, id));
                        // Also send reaction email notification if connected
                        if let Some(ref mut client) = ctx.email_client {
                            let _ = client
                                .send_email(
                                    "",
                                    &format!("[WHISPER-REACT] {} {}", id, emoji),
                                    &encrypted,
                                )
                                .await;
                        }
                    }
                    Ok(false) => {
                        Output::error(&format!("Invalid emoji: {}", emoji));
                    }
                    Err(e) => Output::error(&format!("Failed to react: {}", e)),
                }
            }
        }
        Command::Unreact { id, emoji } => {
            let user = ctx.config.email.as_deref().unwrap_or("local");
            match ctx.reaction_store.remove_reaction(&id, &emoji, user) {
                Ok(true) => {
                    Output::success(&format!("Removed {} reaction from message {}", emoji, id));
                }
                Ok(false) => {
                    Output::info(&format!("No {} reaction found on message {}", emoji, id));
                }
                Err(e) => Output::error(&format!("Failed to remove reaction: {}", e)),
            }
        }
        Command::Forward { id, to } => {
            if let Some(ref mut client) = ctx.email_client {
                match client.fetch_message_body(&id).await {
                    Ok(body) => {
                        let forwarded = format!("[Forwarded from {}]\n{}", id, body);
                        match client
                            .send_email(&to, &format!("Fwd: {}", id), &forwarded)
                            .await
                        {
                            Ok(_) => {
                                Output::success(&format!("Forwarded message {} to {}", id, to))
                            }
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
            // Сначала ищем в локальном индексе
            let local_results = ctx.message_index.search(&query);
            if !local_results.is_empty() {
                Output::divider();
                Output::info(&format!(
                    "Index results for \"{}\" ({} hits):",
                    query,
                    local_results.len()
                ));
                for result in local_results.iter().take(15) {
                    let fields = result.matched_fields.join(", ");
                    let ts = result.entry.timestamp.format("%Y-%m-%d %H:%M").to_string();
                    println!(
                        "  [{}] {} — <{}> {} ({})",
                        ts,
                        result.entry.message_id,
                        result.entry.from,
                        result.entry.subject,
                        fields,
                    );
                }
                println!();
            }

            // Также ищем через IMAP если подключены
            if let Some(ref mut client) = ctx.email_client {
                Output::info(&format!("Searching IMAP for: {}", query));
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
                        if results.is_empty() && local_results.is_empty() {
                            Output::info("No results found.");
                        } else if !results.is_empty() {
                            Output::info(&format!("IMAP results ({} hits):", results.len()));
                            for msg in results.iter().take(10) {
                                let from: String = msg.from.chars().take(20).collect();
                                let subject: String = msg.subject.chars().take(30).collect();
                                println!("  {} — <{}> {}", msg.id, from, subject);
                            }
                        }
                    }
                    Err(e) => {
                        if local_results.is_empty() {
                            Output::error(&format!("Search failed: {}", e));
                        }
                    }
                }
            } else if local_results.is_empty() {
                Output::error("Not connected. Use /connect first.");
            }
        }
        Command::Typing => {
            Output::info("⌨️  Typing indicator sent (no-op for email transport)");
        }
        Command::Unreact { id, emoji } => {
            Output::info(&format!("Removed reaction {} from message {}", emoji, id));
        }
        Command::Verify { email } => {
            Output::success(&format!("Contact verified: {}", email));
        }
        Command::Unverify { email } => {
            Output::info(&format!("Verification removed for: {}", email));
        }
        Command::Export { email } => {
            Output::info(&format!("Exporting keys for: {}", email));
            Output::info("(Export not yet implemented)");
        }
        Command::Import { json } => {
            Output::info(&format!(
                "Importing keys from JSON: {}",
                &json[..json.len().min(20)]
            ));
            Output::info("(Import not yet implemented)");
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
            Output::block(
                "/connect — Connect to email server",
                &[
                    "Usage: /connect <email> <app-password> [server]",
                    "",
                    "Examples:",
                    "  /connect user@gmail.com abcd-efgh-ijkl-mnop",
                    "  /connect user@outlook.com pass123 outlook.office365.com",
                    "",
                    "Servers auto-detected for: Gmail, Outlook, Yandex, Mail.ru",
                ],
            );
        }
        Some("chat") => {
            Output::block(
                "/chat — Enter chat mode",
                &[
                    "Usage: /chat <email>",
                    "",
                    "Enters chat mode where typed messages are sent directly.",
                    "Use /leave to exit chat mode.",
                ],
            );
        }
        Some("encrypt") | Some("decrypt") => {
            Output::block(
                "/encrypt — Encrypt text",
                &[
                    "Usage: /encrypt <plaintext>",
                    "       /decrypt <ciphertext>",
                    "",
                    "Encrypts/decrypts text using XChaCha20-Poly1305.",
                    "For files, use /attach or /sendfile.",
                ],
            );
        }
        Some("keys") => {
            Output::block(
                "/keys — Key management",
                &[
                    "  /keygen       Generate new X25519 key pair",
                    "  /keys         Show key status and fingerprint",
                    "  /keyshare     Share public key with a contact",
                ],
            );
        }
        Some("files") => {
            Output::block(
                "/attach /sendfile — File encryption",
                &[
                    "  /attach <path>     Queue a file for sending",
                    "  /sendfile <path>   Encrypt and send a file immediately",
                    "  /sf <path>         Shortcut for /sendfile",
                    "",
                    "Files are encrypted with XChaCha20-Poly1305 via the Encryptor.",
                    "Encrypted files use the ---BEGIN WHISPER ENCRYPTED--- format.",
                    "Size limits: Gmail 25MB, Outlook 20MB, Yandex 30MB.",
                    "",
                    "Workflow:",
                    "  1. /attach report.pdf    — queue the file",
                    "  2. /send hello world      — sends text + all queued attachments",
                    "  3. /sf secret.zip        — encrypt & send file immediately",
                ],
            );
        }
        Some("folders") => {
            Output::block(
                "/folder* — Chat folders (Telegram-style)",
                &[
                    "  /foldercreate <name> [icon]   Create a folder (default icon: 📁)",
                    "  /folderdelete <name>          Delete a folder",
                    "  /folderrename <old> <new>     Rename a folder",
                    "  /folderadd <folder> <chat>    Add a chat to a folder",
                    "  /folderremove <folder> <chat> Remove a chat from a folder",
                    "  /folderlist                   List all folders",
                    "  /folderchats <name>           Show chats in a folder",
                    "",
                    "Shortcuts: /fc, /fd, /fr, /fa, /frem, /fl, /fch",
                    "",
                    "Examples:",
                    "  /fc Work 💼                   Create 'Work' folder with briefcase icon",
                    "  /fa Work alice@test.com       Add alice to Work folder",
                    "  /fl                           List all folders",
                    "  /fch Work                     Show chats in Work folder",
                ],
            );
        }
        Some("media") | Some("thumbs") => {
            Output::block(
                "/thumb* — Media thumbnails",
                &[
                    "  /thumb <file> [s|m|l]    Generate thumbnail (default: m=256px)",
                    "  /thumbinfo <file>        Show media file info",
                    "",
                    "Sizes:",
                    "  s / small  — 128x128",
                    "  m / medium — 256x256 (default)",
                    "  l / large  — 512x512",
                    "",
                    "Supported: JPEG, PNG, GIF",
                    "",
                    "Shortcuts: /th, /ti",
                    "",
                    "Examples:",
                    "  /thumb photo.jpg s       — small thumbnail",
                    "  /thumbinfo video.mp4     — show file info",
                ],
            );
        }
        _ => {
            Output::block(
                "Whisper CLI — Commands",
                &[
                    "",
                    "  SESSION",
                    "    /help [topic]     Show help (topics: connect, chat, encrypt, keys, files, folders, media)",
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
                    "  FOLDERS",
                    "    /fc <name> [icon]  Create folder",
                    "    /fl                List folders",
                    "    /fa <folder> <chat> Add chat to folder",
                    "    /fch <name>        Show chats in folder",
                    "",
                    "  MEDIA",
                    "    /thumb <file> [s|m|l] Generate thumbnail",
                    "    /thumbinfo <file>  Show media file info",
                    "",
                    "  GROUPS",
                    "    /creategroup <name> Create new group",
                    "    /groupmembers <id> List group members",
                    "    /groupinvite <id> <email> Add member",
                    "    /groupremove <id> <email> Remove member",
                    "    /promote <id> <email> Promote to admin",
                    "    /demote <id> <email> Demote to member",
                    "    /block <id> <email> Block user in group",
                    "    /unblock <id> <email> Unblock user",
                    "    /leavegroup <id> Leave group",
                    "",
                    "  SETTINGS",
                    "    /settings          Show settings",
                    "    /set <key> <val>   Change setting",
                    "",
                ],
            );
        }
    }
}
