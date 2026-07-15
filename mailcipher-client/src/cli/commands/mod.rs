pub mod decrypt;
pub mod encrypt;

use std::fmt;

/// Parsed CLI command
#[derive(Debug, Clone)]
pub enum Command {
    // ── Session ──────────────────────────────────────────────
    Help(Option<String>),
    Quit,
    Clear,

    // ── Connection ───────────────────────────────────────────
    Connect { email: String, password: String, server: String },
    Status,

    // ── Messaging ────────────────────────────────────────────
    Chat { contact: String },
    Send { message: String },
    Inbox,
    Read { id: String },
    Reply { id: String, message: String },
    Thread { subject: String },

    // ── Telegram-like features ──────────────────────────────
    React { id: String, emoji: String },
    Forward { id: String, to: String },
    Pin { id: String },
    Unpin { id: String },
    Mute { chat: String },
    Unmute { chat: String },
    Search { query: String },
    Typing,

    // ── Contacts ─────────────────────────────────────────────
    Contacts,
    Add { email: String, name: Option<String> },
    Remove { email: String },
    Whois { email: String },
    Invite { email: String },
    Accept { invite: String },
    Confirm { email: String },

    // ── Crypto ───────────────────────────────────────────────
    Keygen,
    Keys,
    KeyShare { contact: String },
    Encrypt { text: String },
    Decrypt { text: String },

    // ── Files ────────────────────────────────────────────────
    Attach { path: String },
    SendFile { path: String },

    // ── Groups ────────────────────────────────────────────────
    CreateGroup { name: String },
    JoinGroup { group_id: String },
    LeaveGroup { group_id: String },
    GroupMembers { group_id: String },
    GroupInvite { group_id: String, email: String },
    GroupRemove { group_id: String, email: String },

    // ── Settings ─────────────────────────────────────────────
    Settings,
    Set { key: String, value: String },

    // ── Unknown ──────────────────────────────────────────────
    Unknown(String),
}

impl Command {
    /// Parse a line of user input into a Command
    pub fn parse(input: &str) -> Self {
        let input = input.trim();
        if input.is_empty() {
            return Command::Unknown(String::new());
        }

        // Slash commands
        if let Some(rest) = input.strip_prefix('/') {
            let parts: Vec<&str> = rest.splitn(2, ' ').collect();
            let cmd = parts[0].to_lowercase();
            let args = parts.get(1).map(|s| s.trim()).unwrap_or("");

            match cmd.as_str() {
                // Session
                "help" | "h" | "?" => {
                    Command::Help(if args.is_empty() { None } else { Some(args.to_string()) })
                }
                "quit" | "exit" | "q" => Command::Quit,
                "clear" | "cls" => Command::Clear,

                // Connection
                "connect" | "conn" => parse_connect(args),
                "status" | "st" => Command::Status,

                // Messaging
                "chat" | "c" => {
                    if args.is_empty() {
                        Command::Unknown("/chat requires a contact name or email".into())
                    } else {
                        Command::Chat { contact: args.to_string() }
                    }
                }
                "send" | "s" => {
                    if args.is_empty() {
                        Command::Unknown("/send requires a message".into())
                    } else {
                        Command::Send { message: args.to_string() }
                    }
                }
                "inbox" | "in" | "ls" => Command::Inbox,
                "read" | "r" => {
                    if args.is_empty() {
                        Command::Unknown("/read requires a message ID".into())
                    } else {
                        Command::Read { id: args.to_string() }
                    }
                }
                "reply" | "rep" => parse_reply(args),

                // Threads
                "thread" | "th" => {
                    if args.is_empty() {
                        Command::Unknown("/thread requires a subject or ID".into())
                    } else {
                        Command::Thread { subject: args.to_string() }
                    }
                }

                // Telegram-like features
                "react" => {
                    let mut parts = args.splitn(2, ' ');
                    match (parts.next(), parts.next()) {
                        (Some(id), Some(emoji)) => Command::React {
                            id: id.to_string(),
                            emoji: emoji.to_string(),
                        },
                        _ => Command::Unknown("/react requires <id> <emoji>".into()),
                    }
                }
                "forward" | "fwd" => {
                    let mut parts = args.splitn(2, ' ');
                    match (parts.next(), parts.next()) {
                        (Some(id), Some(to)) => Command::Forward {
                            id: id.to_string(),
                            to: to.to_string(),
                        },
                        _ => Command::Unknown("/forward requires <id> <to>".into()),
                    }
                }
                "pin" => {
                    if args.is_empty() {
                        Command::Unknown("/pin requires a message ID".into())
                    } else {
                        Command::Pin { id: args.to_string() }
                    }
                }
                "unpin" => {
                    if args.is_empty() {
                        Command::Unknown("/unpin requires a message ID".into())
                    } else {
                        Command::Unpin { id: args.to_string() }
                    }
                }
                "mute" => {
                    if args.is_empty() {
                        Command::Unknown("/mute requires a chat name".into())
                    } else {
                        Command::Mute { chat: args.to_string() }
                    }
                }
                "unmute" => {
                    if args.is_empty() {
                        Command::Unknown("/unmute requires a chat name".into())
                    } else {
                        Command::Unmute { chat: args.to_string() }
                    }
                }
                "search" | "find" => {
                    if args.is_empty() {
                        Command::Unknown("/search requires a query".into())
                    } else {
                        Command::Search { query: args.to_string() }
                    }
                }
                "typing" | "ty" => Command::Typing,

                // Contacts
                "contacts" | "who" => Command::Contacts,
                "add" => {
                    if args.is_empty() {
                        Command::Unknown("/add requires an email".into())
                    } else {
                        let mut parts = args.splitn(2, ' ');
                        let email = parts.next().unwrap().to_string();
                        let name = parts.next().map(|s| s.trim().to_string());
                        Command::Add { email, name }
                    }
                }
                "remove" | "rm" => {
                    if args.is_empty() {
                        Command::Unknown("/remove requires an email".into())
                    } else {
                        Command::Remove { email: args.to_string() }
                    }
                }
                "whois" => {
                    if args.is_empty() {
                        Command::Unknown("/whois requires an email".into())
                    } else {
                        Command::Whois { email: args.to_string() }
                    }
                }
                "invite" | "inv" => {
                    if args.is_empty() {
                        Command::Unknown("/invite requires an email".into())
                    } else {
                        Command::Invite { email: args.to_string() }
                    }
                }
                "accept" => {
                    if args.is_empty() {
                        Command::Unknown("/accept requires an invite code or link".into())
                    } else {
                        Command::Accept { invite: args.to_string() }
                    }
                }
                "confirm" => {
                    if args.is_empty() {
                        Command::Unknown("/confirm requires an email".into())
                    } else {
                        Command::Confirm { email: args.to_string() }
                    }
                }

                // Groups
                "creategroup" | "cg" => {
                    if args.is_empty() {
                        Command::Unknown("/creategroup requires a group name".into())
                    } else {
                        Command::CreateGroup { name: args.to_string() }
                    }
                }
                "joingroup" | "jg" => {
                    if args.is_empty() {
                        Command::Unknown("/joingroup requires a group ID".into())
                    } else {
                        Command::JoinGroup { group_id: args.to_string() }
                    }
                }
                "leavegroup" | "lg" => {
                    if args.is_empty() {
                        Command::Unknown("/leavegroup requires a group ID".into())
                    } else {
                        Command::LeaveGroup { group_id: args.to_string() }
                    }
                }
                "groupmembers" | "gm" => {
                    if args.is_empty() {
                        Command::Unknown("/groupmembers requires a group ID".into())
                    } else {
                        Command::GroupMembers { group_id: args.to_string() }
                    }
                }
                "groupinvite" | "gi" => {
                    let mut parts = args.splitn(2, ' ');
                    match (parts.next(), parts.next()) {
                        (Some(gid), Some(email)) => Command::GroupInvite {
                            group_id: gid.to_string(),
                            email: email.to_string(),
                        },
                        _ => Command::Unknown("/groupinvite requires <group_id> <email>".into()),
                    }
                }
                "groupremove" | "gr" => {
                    let mut parts = args.splitn(2, ' ');
                    match (parts.next(), parts.next()) {
                        (Some(gid), Some(email)) => Command::GroupRemove {
                            group_id: gid.to_string(),
                            email: email.to_string(),
                        },
                        _ => Command::Unknown("/groupremove requires <group_id> <email>".into()),
                    }
                }

                // Crypto
                "keygen" | "kg" => Command::Keygen,
                "keys" | "k" => Command::Keys,
                "keyshare" | "ks" => {
                    if args.is_empty() {
                        Command::Unknown("/keyshare requires a contact name or email".into())
                    } else {
                        Command::KeyShare { contact: args.to_string() }
                    }
                }
                "encrypt" | "enc" => {
                    if args.is_empty() {
                        Command::Unknown("/encrypt requires text to encrypt".into())
                    } else {
                        Command::Encrypt { text: args.to_string() }
                    }
                }
                "decrypt" | "dec" => {
                    if args.is_empty() {
                        Command::Unknown("/decrypt requires ciphertext".into())
                    } else {
                        Command::Decrypt { text: args.to_string() }
                    }
                }

                // Files
                "attach" => {
                    if args.is_empty() {
                        Command::Unknown("/attach requires a file path".into())
                    } else {
                        Command::Attach { path: args.to_string() }
                    }
                }
                "sendfile" | "sf" => {
                    if args.is_empty() {
                        Command::Unknown("/sendfile requires a file path".into())
                    } else {
                        Command::SendFile { path: args.to_string() }
                    }
                }

                // Settings
                "settings" | "cfg" => Command::Settings,
                "set" => {
                    let mut parts = args.splitn(2, ' ');
                    match (parts.next(), parts.next()) {
                        (Some(key), Some(value)) => {
                            Command::Set { key: key.to_string(), value: value.trim().to_string() }
                        }
                        _ => Command::Unknown("/set requires key and value".into()),
                    }
                }

                _ => Command::Unknown(format!("Unknown command: /{}", cmd)),
            }
        } else {
            Command::Unknown(input.to_string())
        }
    }
}

fn parse_connect(args: &str) -> Command {
    let parts: Vec<&str> = args.split_whitespace().collect();
    match parts.len() {
        0 => Command::Unknown("/connect requires email password [server]".into()),
        1 => Command::Unknown(format!("Missing password for {}", parts[0])),
        2 => Command::Connect {
            email: parts[0].to_string(),
            password: parts[1].to_string(),
            server: default_imap_server(parts[0]),
        },
        _ => Command::Connect {
            email: parts[0].to_string(),
            password: parts[1].to_string(),
            server: parts[2].to_string(),
        },
    }
}

fn parse_reply(args: &str) -> Command {
    let parts: Vec<&str> = args.splitn(2, ' ').collect();
    match parts.len() {
        0 => Command::Unknown("/reply requires an ID and message".into()),
        1 => Command::Unknown(format!("Missing message text for reply to {}", parts[0])),
        _ => Command::Reply {
            id: parts[0].to_string(),
            message: parts[1].to_string(),
        },
    }
}

fn default_imap_server(email: &str) -> String {
    if email.ends_with("@gmail.com") || email.ends_with("@googlemail.com") {
        "imap.gmail.com".to_string()
    } else if email.ends_with("@outlook.com") || email.ends_with("@hotmail.com") {
        "outlook.office365.com".to_string()
    } else if email.ends_with("@yandex.ru") || email.ends_with("@yandex.com") {
        "imap.yandex.com".to_string()
    } else if email.ends_with("@mail.ru") {
        "imap.mail.ru".to_string()
    } else {
        "imap.gmail.com".to_string()
    }
}

impl fmt::Display for Command {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Command::Help(_) => write!(f, "help"),
            Command::Quit => write!(f, "quit"),
            Command::Clear => write!(f, "clear"),
            Command::Connect { email, .. } => write!(f, "connect {}", email),
            Command::Status => write!(f, "status"),
            Command::Chat { contact } => write!(f, "chat {}", contact),
            Command::Send { message } => write!(f, "send {}", message),
            Command::Inbox => write!(f, "inbox"),
            Command::Read { id } => write!(f, "read {}", id),
            Command::Reply { id, .. } => write!(f, "reply {}", id),
            Command::Thread { subject } => write!(f, "thread {}", subject),
            Command::React { id, emoji } => write!(f, "react {} {}", id, emoji),
            Command::Forward { id, to } => write!(f, "forward {} {}", id, to),
            Command::Pin { id } => write!(f, "pin {}", id),
            Command::Unpin { id } => write!(f, "unpin {}", id),
            Command::Mute { chat } => write!(f, "mute {}", chat),
            Command::Unmute { chat } => write!(f, "unmute {}", chat),
            Command::Search { query } => write!(f, "search {}", query),
            Command::Typing => write!(f, "typing"),
            Command::Contacts => write!(f, "contacts"),
            Command::Add { email, .. } => write!(f, "add {}", email),
            Command::Remove { email } => write!(f, "remove {}", email),
            Command::Whois { email } => write!(f, "whois {}", email),
            Command::Invite { email } => write!(f, "invite {}", email),
            Command::Accept { invite } => write!(f, "accept {}", invite),
            Command::Confirm { email } => write!(f, "confirm {}", email),
            Command::Keygen => write!(f, "keygen"),
            Command::Keys => write!(f, "keys"),
            Command::KeyShare { contact } => write!(f, "keyshare {}", contact),
            Command::Encrypt { .. } => write!(f, "encrypt ..."),
            Command::Decrypt { .. } => write!(f, "decrypt ..."),
            Command::Attach { path } => write!(f, "attach {}", path),
            Command::SendFile { path } => write!(f, "sendfile {}", path),
            Command::CreateGroup { name } => write!(f, "creategroup {}", name),
            Command::JoinGroup { group_id } => write!(f, "joingroup {}", group_id),
            Command::LeaveGroup { group_id } => write!(f, "leavegroup {}", group_id),
            Command::GroupMembers { group_id } => write!(f, "groupmembers {}", group_id),
            Command::GroupInvite { group_id, email } => write!(f, "groupinvite {} {}", group_id, email),
            Command::GroupRemove { group_id, email } => write!(f, "groupremove {} {}", group_id, email),
            Command::Settings => write!(f, "settings"),
            Command::Set { key, .. } => write!(f, "set {}", key),
            Command::Unknown(s) => write!(f, "{}", s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_empty() {
        assert!(matches!(Command::parse(""), Command::Unknown(_)));
    }

    #[test]
    fn test_parse_quit() {
        assert!(matches!(Command::parse("/quit"), Command::Quit));
        assert!(matches!(Command::parse("/exit"), Command::Quit));
        assert!(matches!(Command::parse("/q"), Command::Quit));
    }

    #[test]
    fn test_parse_help() {
        assert!(matches!(Command::parse("/help"), Command::Help(None)));
        assert!(matches!(Command::parse("/help keys"), Command::Help(Some(_))));
    }

    #[test]
    fn test_parse_connect() {
        let cmd = Command::parse("/connect user@gmail.com pass123");
        match cmd {
            Command::Connect { email, password, server } => {
                assert_eq!(email, "user@gmail.com");
                assert_eq!(password, "pass123");
                assert_eq!(server, "imap.gmail.com");
            }
            _ => panic!("Expected Connect"),
        }
    }

    #[test]
    fn test_parse_chat() {
        let cmd = Command::parse("/chat alice@example.com");
        match cmd {
            Command::Chat { contact } => assert_eq!(contact, "alice@example.com"),
            _ => panic!("Expected Chat"),
        }
    }

    #[test]
    fn test_parse_send() {
        let cmd = Command::parse("/send hello world");
        match cmd {
            Command::Send { message } => assert_eq!(message, "hello world"),
            _ => panic!("Expected Send"),
        }
    }

    #[test]
    fn test_parse_react() {
        let cmd = Command::parse("/react msg1 👍");
        match cmd {
            Command::React { id, emoji } => {
                assert_eq!(id, "msg1");
                assert_eq!(emoji, "👍");
            }
            _ => panic!("Expected React"),
        }
    }

    #[test]
    fn test_parse_creatgroup() {
        let cmd = Command::parse("/creategroup MyGroup");
        match cmd {
            Command::CreateGroup { name } => assert_eq!(name, "MyGroup"),
            _ => panic!("Expected CreateGroup"),
        }
    }

    #[test]
    fn test_parse_groupinvite() {
        let cmd = Command::parse("/groupinvite grp_123 user@test.com");
        match cmd {
            Command::GroupInvite { group_id, email } => {
                assert_eq!(group_id, "grp_123");
                assert_eq!(email, "user@test.com");
            }
            _ => panic!("Expected GroupInvite"),
        }
    }

    // ── CLI Demo: comprehensive slash-command parsing tests ──

    #[test]
    fn test_help_all_aliases() {
        assert!(matches!(Command::parse("/help"), Command::Help(None)));
        assert!(matches!(Command::parse("/h"), Command::Help(None)));
        // Note: "?" is inside slash-prefix block, so /? works but bare ? is Unknown
        assert!(matches!(Command::parse("/?"), Command::Help(None)));
        assert!(matches!(Command::parse("/help keys"), Command::Help(Some(_))));
        assert!(matches!(Command::parse("/help encrypt"), Command::Help(Some(_))));
        assert!(matches!(Command::parse("/help connect"), Command::Help(Some(_))));
        assert!(matches!(Command::parse("/help chat"), Command::Help(Some(_))));
        assert!(matches!(Command::parse("/help files"), Command::Help(Some(_))));
    }

    #[test]
    fn test_clear_all_aliases() {
        assert!(matches!(Command::parse("/clear"), Command::Clear));
        assert!(matches!(Command::parse("/cls"), Command::Clear));
    }

    #[test]
    fn test_connect_auto_detect_servers() {
        let cmd = Command::parse("/connect u@outlook.com p");
        match cmd {
            Command::Connect { server, .. } => assert_eq!(server, "outlook.office365.com"),
            _ => panic!("Expected Connect"),
        }
        let cmd = Command::parse("/connect u@yandex.ru p");
        match cmd {
            Command::Connect { server, .. } => assert_eq!(server, "imap.yandex.com"),
            _ => panic!("Expected Connect"),
        }
        let cmd = Command::parse("/connect u@mail.ru p");
        match cmd {
            Command::Connect { server, .. } => assert_eq!(server, "imap.mail.ru"),
            _ => panic!("Expected Connect"),
        }
        let cmd = Command::parse("/connect u@other.com p");
        match cmd {
            Command::Connect { server, .. } => assert_eq!(server, "imap.gmail.com"),
            _ => panic!("Expected Connect"),
        }
    }

    #[test]
    fn test_connect_missing_args() {
        assert!(matches!(Command::parse("/connect"), Command::Unknown(_)));
        assert!(matches!(Command::parse("/connect user@gmail.com"), Command::Unknown(_)));
    }

    #[test]
    fn test_status_aliases() {
        assert!(matches!(Command::parse("/status"), Command::Status));
        assert!(matches!(Command::parse("/st"), Command::Status));
    }

    #[test]
    fn test_chat_requires_arg() {
        assert!(matches!(Command::parse("/chat"), Command::Unknown(_)));
        let cmd = Command::parse("/chat bob@test.com");
        match cmd {
            Command::Chat { contact } => assert_eq!(contact, "bob@test.com"),
            _ => panic!("Expected Chat"),
        }
    }

    #[test]
    fn test_send_requires_arg() {
        assert!(matches!(Command::parse("/send"), Command::Unknown(_)));
        let cmd = Command::parse("/send hello world");
        match cmd {
            Command::Send { message } => assert_eq!(message, "hello world"),
            _ => panic!("Expected Send"),
        }
    }

    #[test]
    fn test_inbox_aliases() {
        assert!(matches!(Command::parse("/inbox"), Command::Inbox));
        assert!(matches!(Command::parse("/in"), Command::Inbox));
        assert!(matches!(Command::parse("/ls"), Command::Inbox));
    }

    #[test]
    fn test_read_requires_arg() {
        assert!(matches!(Command::parse("/read"), Command::Unknown(_)));
        let cmd = Command::parse("/read msg123");
        match cmd {
            Command::Read { id } => assert_eq!(id, "msg123"),
            _ => panic!("Expected Read"),
        }
    }

    #[test]
    fn test_reply_parsing() {
        assert!(matches!(Command::parse("/reply"), Command::Unknown(_)));
        let cmd = Command::parse("/reply msg1 hello back");
        match cmd {
            Command::Reply { id, message } => {
                assert_eq!(id, "msg1");
                assert_eq!(message, "hello back");
            }
            _ => panic!("Expected Reply"),
        }
    }

    #[test]
    fn test_thread_requires_arg() {
        assert!(matches!(Command::parse("/thread"), Command::Unknown(_)));
        let cmd = Command::parse("/thread subject line");
        match cmd {
            Command::Thread { subject } => assert_eq!(subject, "subject line"),
            _ => panic!("Expected Thread"),
        }
    }

    #[test]
    fn test_forward_parsing() {
        assert!(matches!(Command::parse("/forward"), Command::Unknown(_)));
        assert!(matches!(Command::parse("/forward msg1"), Command::Unknown(_)));
        let cmd = Command::parse("/forward msg1 alice@test.com");
        match cmd {
            Command::Forward { id, to } => {
                assert_eq!(id, "msg1");
                assert_eq!(to, "alice@test.com");
            }
            _ => panic!("Expected Forward"),
        }
    }

    #[test]
    fn test_pin_unpin() {
        let cmd = Command::parse("/pin msg1");
        match cmd { Command::Pin { id } => assert_eq!(id, "msg1"), _ => panic!("Expected Pin") }
        assert!(matches!(Command::parse("/pin"), Command::Unknown(_)));
        let cmd = Command::parse("/unpin msg1");
        match cmd { Command::Unpin { id } => assert_eq!(id, "msg1"), _ => panic!("Expected Unpin") }
        assert!(matches!(Command::parse("/unpin"), Command::Unknown(_)));
    }

    #[test]
    fn test_mute_unmute() {
        let cmd = Command::parse("/mute alice@test.com");
        match cmd { Command::Mute { chat } => assert_eq!(chat, "alice@test.com"), _ => panic!() }
        assert!(matches!(Command::parse("/mute"), Command::Unknown(_)));
        let cmd = Command::parse("/unmute alice@test.com");
        match cmd { Command::Unmute { chat } => assert_eq!(chat, "alice@test.com"), _ => panic!() }
        assert!(matches!(Command::parse("/unmute"), Command::Unknown(_)));
    }

    #[test]
    fn test_search_requires_arg() {
        assert!(matches!(Command::parse("/search"), Command::Unknown(_)));
        let cmd = Command::parse("/search query");
        match cmd { Command::Search { query } => assert_eq!(query, "query"), _ => panic!() }
    }

    #[test]
    fn test_typing_aliases() {
        assert!(matches!(Command::parse("/typing"), Command::Typing));
        assert!(matches!(Command::parse("/ty"), Command::Typing));
    }

    #[test]
    fn test_contacts_aliases() {
        assert!(matches!(Command::parse("/contacts"), Command::Contacts));
        assert!(matches!(Command::parse("/who"), Command::Contacts));
    }

    #[test]
    fn test_add_remove() {
        let cmd = Command::parse("/add alice@test.com Alice");
        match cmd {
            Command::Add { email, name } => {
                assert_eq!(email, "alice@test.com");
                assert_eq!(name, Some("Alice".to_string()));
            }
            _ => panic!(),
        }
        let cmd = Command::parse("/add bob@test.com");
        match cmd {
            Command::Add { email, name } => {
                assert_eq!(email, "bob@test.com");
                assert!(name.is_none());
            }
            _ => panic!(),
        }
        assert!(matches!(Command::parse("/add"), Command::Unknown(_)));
        let cmd = Command::parse("/rm alice@test.com");
        match cmd { Command::Remove { email } => assert_eq!(email, "alice@test.com"), _ => panic!() }
    }

    #[test]
    fn test_whois_requires_arg() {
        assert!(matches!(Command::parse("/whois"), Command::Unknown(_)));
        let cmd = Command::parse("/whois alice@test.com");
        match cmd { Command::Whois { email } => assert_eq!(email, "alice@test.com"), _ => panic!() }
    }

    #[test]
    fn test_invite_accept_confirm() {
        let cmd = Command::parse("/invite alice@test.com");
        match cmd { Command::Invite { email } => assert_eq!(email, "alice@test.com"), _ => panic!() }
        assert!(matches!(Command::parse("/invite"), Command::Unknown(_)));
        let cmd = Command::parse("/accept inv_abc123");
        match cmd { Command::Accept { invite } => assert_eq!(invite, "inv_abc123"), _ => panic!() }
        assert!(matches!(Command::parse("/accept"), Command::Unknown(_)));
        let cmd = Command::parse("/confirm alice@test.com");
        match cmd { Command::Confirm { email } => assert_eq!(email, "alice@test.com"), _ => panic!() }
        assert!(matches!(Command::parse("/confirm"), Command::Unknown(_)));
    }

    #[test]
    fn test_keygen_keys_aliases() {
        assert!(matches!(Command::parse("/keygen"), Command::Keygen));
        assert!(matches!(Command::parse("/kg"), Command::Keygen));
        assert!(matches!(Command::parse("/keys"), Command::Keys));
        assert!(matches!(Command::parse("/k"), Command::Keys));
    }

    #[test]
    fn test_keyshare_requires_arg() {
        assert!(matches!(Command::parse("/keyshare"), Command::Unknown(_)));
        let cmd = Command::parse("/keyshare alice@test.com");
        match cmd { Command::KeyShare { contact } => assert_eq!(contact, "alice@test.com"), _ => panic!() }
    }

    #[test]
    fn test_encrypt_decrypt_aliases() {
        let cmd = Command::parse("/encrypt Hello World");
        match cmd { Command::Encrypt { text } => assert_eq!(text, "Hello World"), _ => panic!() }
        let cmd = Command::parse("/enc secret");
        match cmd { Command::Encrypt { text } => assert_eq!(text, "secret"), _ => panic!() }
        assert!(matches!(Command::parse("/encrypt"), Command::Unknown(_)));
        let cmd = Command::parse("/decrypt data");
        match cmd { Command::Decrypt { text } => assert_eq!(text, "data"), _ => panic!() }
        let cmd = Command::parse("/dec data2");
        match cmd { Command::Decrypt { text } => assert_eq!(text, "data2"), _ => panic!() }
    }

    #[test]
    fn test_attach_sendfile() {
        let cmd = Command::parse("/attach /tmp/file.pdf");
        match cmd { Command::Attach { path } => assert_eq!(path, "/tmp/file.pdf"), _ => panic!() }
        assert!(matches!(Command::parse("/attach"), Command::Unknown(_)));
        let cmd = Command::parse("/sendfile /tmp/doc.txt");
        match cmd { Command::SendFile { path } => assert_eq!(path, "/tmp/doc.txt"), _ => panic!() }
        let cmd = Command::parse("/sf /tmp/doc.txt");
        match cmd { Command::SendFile { path } => assert_eq!(path, "/tmp/doc.txt"), _ => panic!() }
    }

    #[test]
    fn test_group_commands_full() {
        let cmd = Command::parse("/cg TestGroup");
        match cmd { Command::CreateGroup { name } => assert_eq!(name, "TestGroup"), _ => panic!() }
        let cmd = Command::parse("/joingroup grp123");
        match cmd { Command::JoinGroup { group_id } => assert_eq!(group_id, "grp123"), _ => panic!() }
        let cmd = Command::parse("/leavegroup grp123");
        match cmd { Command::LeaveGroup { group_id } => assert_eq!(group_id, "grp123"), _ => panic!() }
        let cmd = Command::parse("/gm grp123");
        match cmd { Command::GroupMembers { group_id } => assert_eq!(group_id, "grp123"), _ => panic!() }
        let cmd = Command::parse("/gi grp123 bob@test.com");
        match cmd {
            Command::GroupInvite { group_id, email } => { assert_eq!(group_id, "grp123"); assert_eq!(email, "bob@test.com"); }
            _ => panic!(),
        }
        let cmd = Command::parse("/gr grp123 bob@test.com");
        match cmd {
            Command::GroupRemove { group_id, email } => { assert_eq!(group_id, "grp123"); assert_eq!(email, "bob@test.com"); }
            _ => panic!(),
        }
    }

    #[test]
    fn test_settings_set() {
        assert!(matches!(Command::parse("/settings"), Command::Settings));
        assert!(matches!(Command::parse("/cfg"), Command::Settings));
        let cmd = Command::parse("/set email test@test.com");
        match cmd { Command::Set { key, value } => { assert_eq!(key, "email"); assert_eq!(value, "test@test.com"); } _ => panic!() }
        assert!(matches!(Command::parse("/set"), Command::Unknown(_)));
    }

    #[test]
    fn test_unknown_and_empty() {
        assert!(matches!(Command::parse("/foobar"), Command::Unknown(_)));
        assert!(matches!(Command::parse("random text"), Command::Unknown(_)));
        assert!(matches!(Command::parse(""), Command::Unknown(_)));
        assert!(matches!(Command::parse("   "), Command::Unknown(_)));
    }
}
