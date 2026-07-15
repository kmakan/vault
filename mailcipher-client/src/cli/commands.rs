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
                "react" | "r" => {
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
        } else if self_is_in_chat_context(input) {
            // In chat mode, bare text = send message
            Command::Send { message: input.to_string() }
        } else {
            Command::Unknown(input.to_string())
        }
    }
}

/// Check if input looks like a chat message (not a command)
/// For now, bare text is always treated as a send candidate
fn self_is_in_chat_context(_input: &str) -> bool {
    // The REPL layer tracks chat context; this is a fallback
    false
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
    fn test_parse_keygen() {
        assert!(matches!(Command::parse("/keygen"), Command::Keygen));
        assert!(matches!(Command::parse("/kg"), Command::Keygen));
    }

    #[test]
    fn test_parse_unknown_command() {
        assert!(matches!(Command::parse("/foobar"), Command::Unknown(_)));
    }

    #[test]
    fn test_parse_thread() {
        let cmd = Command::parse("/thread Meeting notes");
        match cmd {
            Command::Thread { subject } => assert_eq!(subject, "Meeting notes"),
            _ => panic!("Expected Thread"),
        }
        assert!(matches!(Command::parse("/th test"), Command::Thread { .. }));
    }

    #[test]
    fn test_parse_whois() {
        let cmd = Command::parse("/whois alice@example.com");
        match cmd {
            Command::Whois { email } => assert_eq!(email, "alice@example.com"),
            _ => panic!("Expected Whois"),
        }
        assert!(matches!(Command::parse("/whois"), Command::Unknown(_)));
    }

    #[test]
    fn test_parse_reply() {
        let cmd = Command::parse("/reply msg-123 Thanks!");
        match cmd {
            Command::Reply { id, message } => {
                assert_eq!(id, "msg-123");
                assert_eq!(message, "Thanks!");
            }
            _ => panic!("Expected Reply"),
        }
    }

    #[test]
    fn test_default_imap_server() {
        assert_eq!(default_imap_server("u@gmail.com"), "imap.gmail.com");
        assert_eq!(default_imap_server("u@outlook.com"), "outlook.office365.com");
        assert_eq!(default_imap_server("u@yandex.ru"), "imap.yandex.com");
        assert_eq!(default_imap_server("u@mail.ru"), "imap.mail.ru");
        assert_eq!(default_imap_server("u@unknown.com"), "imap.gmail.com");
    }

    #[test]
    fn test_parse_group_commands() {
        assert!(matches!(Command::parse("/creategroup Test"), Command::CreateGroup { .. }));
        assert!(matches!(Command::parse("/cg Test"), Command::CreateGroup { .. }));
        assert!(matches!(Command::parse("/joingroup grp_123"), Command::JoinGroup { .. }));
        assert!(matches!(Command::parse("/jg grp_123"), Command::JoinGroup { .. }));
        assert!(matches!(Command::parse("/leavegroup grp_123"), Command::LeaveGroup { .. }));
        assert!(matches!(Command::parse("/lg grp_123"), Command::LeaveGroup { .. }));
        assert!(matches!(Command::parse("/groupmembers grp_123"), Command::GroupMembers { .. }));
        assert!(matches!(Command::parse("/gm grp_123"), Command::GroupMembers { .. }));
        assert!(matches!(Command::parse("/groupinvite grp_123 user@test.com"), Command::GroupInvite { .. }));
        assert!(matches!(Command::parse("/gi grp_123 user@test.com"), Command::GroupInvite { .. }));
        assert!(matches!(Command::parse("/groupremove grp_123 user@test.com"), Command::GroupRemove { .. }));
        assert!(matches!(Command::parse("/gr grp_123 user@test.com"), Command::GroupRemove { .. }));
        
        // Missing args
        assert!(matches!(Command::parse("/creategroup"), Command::Unknown(_)));
        assert!(matches!(Command::parse("/joingroup"), Command::Unknown(_)));
        assert!(matches!(Command::parse("/groupinvite grp_123"), Command::Unknown(_)));
    }
}
