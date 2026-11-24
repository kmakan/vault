//! IMAP-приём Sfera: только свои социальные письма и только BODY.PEEK.
//!
//! Это транспортный адаптер, а не монитор всего ящика. Обычные письма не
//! скачиваются телом; UID и папка образуют локальный cursor дедупликации.
//! Криптография и правила профиля остаются в social-app/social-ffi.

use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

use native_tls::TlsConnector;
use social_ffi::SferaState;

pub const SUBJECT_PREFIX: &str = "sfera-profile:";
const CURSOR_FILE: &str = "imap-received.json";
const FETCH_LIMIT: usize = 50;

#[derive(Clone, Debug)]
pub struct ImapConfig {
    pub email: String,
    pub password: String,
    pub server: String,
    pub port: u16,
    pub allow_insecure: bool,
}

impl ImapConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(email) = std::env::var("SFERA_IMAP_EMAIL") else { return Ok(None) };
        let password = std::env::var("SFERA_IMAP_PASSWORD")
            .map_err(|_| "SFERA_IMAP_PASSWORD is required with SFERA_IMAP_EMAIL".to_string())?;
        let server = std::env::var("SFERA_IMAP_SERVER")
            .map_err(|_| "SFERA_IMAP_SERVER is required with SFERA_IMAP_EMAIL".to_string())?;
        let port = std::env::var("SFERA_IMAP_PORT")
            .unwrap_or_else(|_| "993".into())
            .parse::<u16>()
            .map_err(|_| "SFERA_IMAP_PORT must be a valid TCP port".to_string())?;
        let allow_insecure = std::env::var("SFERA_IMAP_ALLOW_INSECURE").as_deref() == Ok("1");
        if allow_insecure && !matches!(server.as_str(), "127.0.0.1" | "localhost" | "::1") {
            return Err("plaintext IMAP is allowed only for a local test server".into());
        }
        if email.is_empty() || password.is_empty() || server.is_empty() {
            return Err("SFERA_IMAP_EMAIL/PASSWORD/SERVER must not be empty".into());
        }
        Ok(Some(Self { email, password, server, port, allow_insecure }))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct ReceiveReport {
    pub scanned: usize,
    pub candidates: usize,
    pub accepted: usize,
    pub duplicates: usize,
    pub rejected: usize,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct Cursor {
    v: u8,
    ids: Vec<String>,
}

fn cursor_path(data_dir: &Path) -> PathBuf { data_dir.join(CURSOR_FILE) }

fn load_cursor(data_dir: &Path) -> Result<std::collections::HashSet<String>, String> {
    let path = cursor_path(data_dir);
    if !path.exists() { return Ok(Default::default()); }
    let cursor: Cursor = serde_json::from_str(
        &std::fs::read_to_string(path).map_err(|e| format!("read IMAP cursor: {e}"))?,
    ).map_err(|e| format!("parse IMAP cursor: {e}"))?;
    if cursor.v != 1 { return Err("unsupported IMAP cursor version".into()); }
    Ok(cursor.ids.into_iter().collect())
}

fn save_cursor(data_dir: &Path, ids: &std::collections::HashSet<String>) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("create IMAP cursor dir: {e}"))?;
    let mut ids: Vec<_> = ids.iter().cloned().collect();
    ids.sort();
    let path = cursor_path(data_dir);
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_vec(&Cursor { v: 1, ids }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("write IMAP cursor: {e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("protect IMAP cursor: {e}"))?;
    }
    std::fs::rename(tmp, path).map_err(|e| format!("commit IMAP cursor: {e}"))
}

fn read_line<S: ReadWrite>(reader: &mut BufReader<S>, transcript: &mut String) -> Result<String, String> {
    let mut line = String::new();
    let count = reader.read_line(&mut line).map_err(|e| format!("IMAP read: {e}"))?;
    if count == 0 { return Err("IMAP connection closed".into()); }
    transcript.push_str(&line);
    Ok(line)
}

fn command<S: ReadWrite>(
    reader: &mut BufReader<S>,
    tag: &str,
    command: &str,
    transcript: &mut String,
) -> Result<Vec<String>, String> {
    reader.get_mut().write_all(format!("{tag} {command}\r\n").as_bytes())
        .map_err(|e| format!("IMAP write: {e}"))?;
    reader.get_mut().flush().map_err(|e| format!("IMAP flush: {e}"))?;
    let mut lines = Vec::new();
    loop {
        let line = read_line(reader, transcript)?;
        if line.starts_with(&format!("{tag} OK")) { return Ok(lines); }
        if line.starts_with(&format!("{tag} NO")) || line.starts_with(&format!("{tag} BAD")) {
            return Err("IMAP command rejected".into());
        }
        lines.push(line);
    }
}

fn parse_uids(lines: &[String]) -> Vec<u32> {
    let mut uids: Vec<u32> = lines.iter()
        .filter_map(|line| line.strip_prefix("* SEARCH "))
        .flat_map(|tail| tail.split_whitespace().filter_map(|s| s.parse().ok()))
        .collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(FETCH_LIMIT);
    uids
}

fn header_value(headers: &str, name: &str) -> String {
    let mut lines = headers.lines().peekable();
    let mut value = String::new();
    while let Some(line) = lines.next() {
        if line.is_empty() { break; }
        if !value.is_empty() && line.starts_with([' ', '\t']) {
            value.push(' ');
            value.push_str(line.trim());
        } else if let Some(rest) = line.strip_prefix(name) {
            value = rest.trim().to_string();
        }
    }
    value
}

/// Разобрать заранее прочитанный PEEK-ответ без раскрытия содержимого в логах.
/// JSON находится сразу после маркера `{length}` IMAP literal; заголовков
/// RFC822 у BODY[TEXT] нет, поэтому пустую строку искать нельзя.
pub fn envelope_from_peek(response: &str) -> Result<social_delivery::SealedEnvelope, String> {
    let body = response.split_once("}\r\n")
        .or_else(|| response.split_once("}\n"))
        .map(|(_, body)| body)
        .ok_or_else(|| "IMAP message has no literal body".to_string())?;
    let json = body.lines()
        .take_while(|line| !line.starts_with(')'))
        .collect::<Vec<_>>().join("\n");
    serde_json::from_str(json.trim()).map_err(|e| format!("sealed envelope JSON: {e}"))
}

pub fn subject_is_sfera(subject: &str) -> bool { subject.starts_with(SUBJECT_PREFIX) }

trait ReadWrite: std::io::Read + std::io::Write {}
impl<T: std::io::Read + std::io::Write> ReadWrite for T {}

fn fetch_with_stream<S: ReadWrite>(
    stream: S,
    config: &ImapConfig,
    data_dir: &Path,
    state: &SferaState,
) -> Result<ReceiveReport, String> {
    let mut transcript = String::new();
    let mut reader = BufReader::new(stream);
    read_line(&mut reader, &mut transcript)?;
    command(&mut reader, "a1", "CAPABILITY", &mut transcript)?;
    // LOGIN содержит пароль: команда не попадает ни в transcript, ни в ошибки.
    reader.get_mut().write_all(format!("a2 LOGIN \"{}\" \"{}\"\r\n", config.email.replace('"', ""), config.password.replace('"', "")).as_bytes())
        .map_err(|e| format!("IMAP login write: {e}"))?;
    reader.get_mut().flush().map_err(|e| format!("IMAP login flush: {e}"))?;
    loop {
        let line = read_line(&mut reader, &mut transcript)?;
        if line.starts_with("a2 OK") { break; }
        if line.starts_with("a2 NO") || line.starts_with("a2 BAD") {
            return Err("IMAP login rejected".into());
        }
    }
    command(&mut reader, "a3", "SELECT INBOX", &mut transcript)?;
    let found = command(&mut reader, "a4", "UID SEARCH ALL", &mut transcript)?;
    let uids = parse_uids(&found);
    let mut seen = load_cursor(data_dir)?;
    let mut report = ReceiveReport { scanned: uids.len(), ..Default::default() };
    for (index, uid) in uids.into_iter().enumerate() {
        let id = format!("INBOX:{uid}");
        if seen.contains(&id) { continue; }
        let tag = format!("h{index}");
        let header_lines = command(
            &mut reader, &tag,
            &format!("UID FETCH {uid} (UID BODY.PEEK[HEADER.FIELDS (SUBJECT)])"),
            &mut transcript,
        )?;
        let subject = header_value(&header_lines.concat(), "Subject:");
        if !subject_is_sfera(&subject) { continue; }
        report.candidates += 1;
        let tag = format!("b{index}");
        let body_lines = command(
            &mut reader, &tag,
            &format!("UID FETCH {uid} (UID BODY.PEEK[TEXT])"),
            &mut transcript,
        )?;
        match envelope_from_peek(&body_lines.concat())
            .map_err(|e| e.to_string())
            .and_then(|envelope| state.receive_profile_envelope(&envelope).map(|_| ()).map_err(|e| e.message))
        {
            Ok(()) => {
                if seen.insert(id) {
                    report.accepted += 1;
                } else {
                    report.duplicates += 1;
                }
            }
            Err(error) => {
                #[cfg(test)]
                {
                    eprintln!("IMAP candidate rejected: {error}");
                }
                #[cfg(not(test))]
                let _ = error;
                report.rejected += 1;
            }
        }
    }
    save_cursor(data_dir, &seen)?;
    let _ = command(&mut reader, "zz", "LOGOUT", &mut transcript);
    Ok(report)
}

/// Один явный цикл приёма. Планировщик и живой ящик не запускаются скрыто.
pub fn receive_once(
    config: &ImapConfig,
    data_dir: &Path,
    state: &SferaState,
) -> Result<ReceiveReport, String> {
    let stream = TcpStream::connect((config.server.as_str(), config.port))
        .map_err(|e| format!("IMAP connect: {e}"))?;
    if config.allow_insecure {
        return fetch_with_stream(stream, config, data_dir, state);
    }
    let tls = TlsConnector::builder().build().map_err(|e| format!("IMAP TLS: {e}"))?;
    let stream = tls.connect(&config.server, stream).map_err(|e| format!("IMAP TLS connect: {e}"))?;
    fetch_with_stream(stream, config, data_dir, state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_sfera_subject_is_candidate() {
        assert!(subject_is_sfera("sfera-profile:abc"));
        assert!(!subject_is_sfera("hello"));
        assert!(!subject_is_sfera("Re: sfera-profile:abc"));
    }

    #[test]
    fn uid_search_is_sorted_and_limited() {
        let lines = vec!["* SEARCH 2 90 1 51\r\n".into()];
        assert_eq!(parse_uids(&lines), vec![90, 51, 2, 1]);
    }

    #[test]
    fn folded_subject_is_read() {
        assert_eq!(header_value("Subject: sfera-profile:\r\n abc\r\n\r\n", "Subject:"), "sfera-profile: abc");
    }

    #[test]
    fn cursor_rejects_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(cursor_path(dir.path()), r#"{"v":2,"ids":[]}"#).unwrap();
        assert!(load_cursor(dir.path()).is_err());
    }

    #[test]
    fn real_envelope_is_received_over_peek_and_foreign_body_is_not_fetched() {
        use std::io::Write;
        use std::net::TcpListener;

        const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";
        let sender = social_keys::EncryptionIdentity::generate([11; 32]).unwrap();
        let recipient = social_keys::EncryptionIdentity::generate([22; 32]).unwrap();
        let signed = social_profile::compose(SEED, 100, "Аня", "", None, vec![]).unwrap();
        let plaintext = social_profile::envelope_json(&signed, None).unwrap();
        let envelope = social_delivery::seal_payload(
            &plaintext,
            &sender.sender_material(),
            &social_delivery::RecipientKeyMaterial {
                fp: recipient.fingerprint().unwrap(),
                x25519_public_hex: recipient.x25519_public_hex().into(),
                pq_ek_b64: recipient.pq_ek_b64().into(),
                address: "peer@example.org".into(),
            },
        ).unwrap();
        let payload = serde_json::to_string(&envelope).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.write_all(b"* OK localhost IMAP4rev1\r\n").unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut commands = Vec::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 { break; }
                let (tag, command) = line.split_once(' ').unwrap();
                commands.push(command.trim().to_string());
                let upper = command.to_ascii_uppercase();
                if upper.starts_with("CAPABILITY") {
                    socket.write_all(b"* CAPABILITY IMAP4rev1 UIDPLUS\r\n").unwrap();
                } else if upper.starts_with("LOGIN") {
                    // Пароль не сохраняем в transcript assertions.
                } else if upper.starts_with("SELECT") {
                    socket.write_all(b"* 2 EXISTS\r\n").unwrap();
                } else if upper.starts_with("UID SEARCH") {
                    socket.write_all(b"* SEARCH 1 2\r\n").unwrap();
                } else if upper.contains("HEADER.FIELDS") {
                    let subject = if command.contains(" 1 ") { "ordinary mail" } else { "sfera-profile:pub1" };
                    socket.write_all(format!("* 1 FETCH (UID 1 BODY[HEADER.FIELDS (SUBJECT)] {{{}}}\r\nSubject: {}\r\n\r\n)\r\n", subject.len() + 11, subject).as_bytes()).unwrap();
                } else if upper.contains("BODY.PEEK[TEXT]") {
                    socket.write_all(format!("* 2 FETCH (UID 2 BODY[TEXT] {{{}}}\r\n{}\r\n)\r\n", payload.len(), payload).as_bytes()).unwrap();
                } else if upper.starts_with("LOGOUT") {
                    socket.write_all(b"* BYE\r\n").unwrap();
                }
                socket.write_all(format!("{tag} OK done\r\n").as_bytes()).unwrap();
                if upper.starts_with("LOGOUT") { break; }
            }
            commands
        });

        let dir = tempfile::tempdir().unwrap();
        social_keys::save_at(&dir.path().join("keys"), &recipient).unwrap();
        let core = social_app::SferaApp::new(
            social_app::Identity::from_seed(SEED).unwrap(),
            std::sync::Arc::new(storage_local::LocalStore::new(dir.path().join("blobs")).unwrap()),
            social_sync::RetryPolicy::default(),
            social_sync::Quota::new(60, 1_000_000, 10, 0),
        );
        let state = SferaState::new(core, None).with_keys_dir(dir.path().join("keys"));
        let config = ImapConfig {
            email: "sfera@example.org".into(), password: "test-only".into(),
            server: "127.0.0.1".into(), port, allow_insecure: true,
        };
        let report = receive_once(&config, dir.path(), &state).unwrap();
        assert_eq!(report, ReceiveReport { scanned: 2, candidates: 1, accepted: 1, duplicates: 0, rejected: 0 });
        let commands = server.join().unwrap();
        assert!(commands.iter().filter(|c| c.contains("BODY.PEEK[TEXT]")).count() == 1);
        assert!(commands.iter().all(|c| !c.contains("RFC822") && !c.to_ascii_uppercase().contains("STORE")));
        assert!(commands.iter().all(|c| c.contains("PEEK") || !c.contains("BODY")));
    }
}
