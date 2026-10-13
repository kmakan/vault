//! Real loopback TLS/IMAP fixtures for the production full-scan path.
//! No environment overrides, real mailboxes, disk keys, or new dependencies.
use super::*;
use native_tls::{Certificate, Identity, TlsAcceptor};
use openssl::asn1::Asn1Time;
use openssl::bn::{BigNum, MsbOption};
use openssl::hash::MessageDigest;
use openssl::pkey::PKey;
use openssl::rsa::Rsa;
use openssl::x509::extension::{BasicConstraints, SubjectAlternativeName};
use openssl::x509::{X509NameBuilder, X509};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

#[derive(Clone, Copy, Debug)]
enum Mode {
    Healthy,
    Stall(&'static str),
    Drip,
    MissingJunk,
    Broken(&'static str),
}

struct Fixture {
    port: u16,
    tls: TlsConnector,
    commands: Arc<Mutex<Vec<String>>>,
    done: mpsc::Receiver<bool>,
    thread: Option<thread::JoinHandle<()>>,
}

fn tls_pair() -> (TlsAcceptor, TlsConnector) {
    let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
    let mut name = X509NameBuilder::new().unwrap();
    name.append_entry_by_text("CN", "localhost").unwrap();
    let name = name.build();
    let mut cert = X509::builder().unwrap();
    cert.set_version(2).unwrap();
    let mut serial = BigNum::new().unwrap();
    serial.rand(128, MsbOption::MAYBE_ZERO, false).unwrap();
    cert.set_serial_number(&serial.to_asn1_integer().unwrap())
        .unwrap();
    cert.set_subject_name(&name).unwrap();
    cert.set_issuer_name(&name).unwrap();
    cert.set_pubkey(&key).unwrap();
    cert.set_not_before(&Asn1Time::days_from_now(0).unwrap())
        .unwrap();
    cert.set_not_after(&Asn1Time::days_from_now(1).unwrap())
        .unwrap();
    cert.append_extension(BasicConstraints::new().critical().ca().build().unwrap())
        .unwrap();
    let san = SubjectAlternativeName::new()
        .ip("127.0.0.1")
        .dns("localhost")
        .build(&cert.x509v3_context(None, None))
        .unwrap();
    cert.append_extension(san).unwrap();
    cert.sign(&key, MessageDigest::sha256()).unwrap();
    let pem = cert.build().to_pem().unwrap();
    let identity = Identity::from_pkcs8(&pem, &key.private_key_to_pem_pkcs8().unwrap()).unwrap();
    // Trust the generated CA; production TLS certificate/hostname validation
    // stays enabled, even in this fixture (no danger_accept_invalid_* flags).
    let tls = TlsConnector::builder()
        .add_root_certificate(Certificate::from_pem(&pem).unwrap())
        .build()
        .unwrap();
    (TlsAcceptor::new(identity).unwrap(), tls)
}

impl Fixture {
    fn new(modes: Vec<Mode>) -> Self {
        let (acceptor, tls) = tls_pair();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let commands2 = commands.clone();
        let (done_tx, done) = mpsc::channel();
        let thread = thread::spawn(move || {
            for mode in modes {
                let start = Instant::now();
                let tcp = loop {
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && start.elapsed() < Duration::from_secs(4) =>
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                        _ => {
                            let _ = done_tx.send(false);
                            return;
                        }
                    }
                };
                tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                let Ok(stream) = acceptor.accept(tcp) else {
                    let _ = done_tx.send(false);
                    return;
                };
                let closed = serve(stream, mode, &commands2);
                let _ = done_tx.send(closed);
            }
        });
        Self {
            port,
            tls,
            commands,
            done,
            thread: Some(thread),
        }
    }

    fn client(&self) -> EmailClient {
        let mut client = EmailClient::new(EmailConfig {
            email: "fixture@example.test".to_string(),
            password: "synthetic-test-only".to_string(),
            imap_server: "127.0.0.1".to_string(),
            imap_port: self.port,
            smtp_server: "127.0.0.1".to_string(),
            smtp_port: 1,
        });
        client.connect_imap_with_tls(&self.tls).unwrap();
        client
    }

    fn closed(&self) {
        assert!(
            self.done.recv_timeout(Duration::from_secs(1)).unwrap(),
            "fixture peer did not observe shutdown/EOF (only its read timeout)"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}

fn serve(stream: TlsStream<TcpStream>, mode: Mode, commands: &Mutex<Vec<String>>) -> bool {
    let mut wire = BufReader::new(stream);
    let mut folder = "INBOX".to_string();
    let mut inbox_selects = 0;
    loop {
        let mut line = String::new();
        match wire.read_line(&mut line) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(e) => {
                return e.kind() != std::io::ErrorKind::WouldBlock
                    && e.kind() != std::io::ErrorKind::TimedOut
            }
        }
        let Some((tag, cmd)) = line.trim_end().split_once(' ') else {
            return false;
        };
        if cmd.starts_with("LOGIN ") {
            // Don't retain authentication command arguments, even synthetic ones.
            if write!(wire.get_mut(), "{tag} OK login\r\n")
                .and_then(|_| wire.get_mut().flush())
                .is_err()
            {
                return true;
            }
            continue;
        }
        commands.lock().unwrap().push(cmd.to_string());
        let is_final = cmd.starts_with("SELECT ") && cmd.contains("INBOX") && inbox_selects == 1;
        let stage = if is_final {
            "FINAL"
        } else if cmd.starts_with("LIST ") {
            "LIST"
        } else if cmd.starts_with("SELECT ") {
            "SELECT"
        } else if cmd.starts_with("UID SEARCH ") {
            "SEARCH"
        } else {
            "FETCH"
        };
        if matches!(mode, Mode::Stall(s) if s == stage) || matches!(mode, Mode::Drip) {
            wire.get_mut()
                .get_ref()
                .set_read_timeout(Some(Duration::from_millis(15)))
                .unwrap();
            let start = Instant::now();
            loop {
                if matches!(mode, Mode::Drip)
                    && wire
                        .get_mut()
                        .write_all(b"* OK still waiting\r\n")
                        .and_then(|_| wire.get_mut().flush())
                        .is_err()
                {
                    return true;
                }
                let mut byte = [0];
                match wire.get_mut().read(&mut byte) {
                    Ok(0) => return true,
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => return true,
                    Ok(_) => {}
                }
                if start.elapsed() > Duration::from_secs(3) {
                    return false;
                }
            }
        }
        let response = if cmd.starts_with("LIST ") {
            format!("* LIST () \"/\" \"INBOX\"\r\n* LIST (\\Junk) \"/\" \"Junk\"\r\n* LIST () \"/\" \"Myself\"\r\n* LIST (\\Sent) \"/\" \"Sent\"\r\n* LIST (\\All) \"/\" \"All\"\r\n{tag} OK list\r\n")
        } else if cmd.starts_with("SELECT ") {
            folder = cmd[7..].trim_matches('"').to_string();
            if folder == "INBOX" {
                inbox_selects += 1;
            }
            if matches!(mode, Mode::Broken(s) if s == folder) {
                return true;
            }
            if matches!(mode, Mode::MissingJunk) && folder == "Junk" {
                format!("{tag} NO No such folder\r\n")
            } else {
                format!(
                    "* 2 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n{tag} OK [READ-WRITE] select\r\n"
                )
            }
        } else if cmd.starts_with("UID SEARCH ") {
            format!("* SEARCH 1 2\r\n{tag} OK search\r\n")
        } else if cmd.starts_with("UID FETCH ") {
            let mut reply = String::new();
            for uid in [2, 1] {
                // One cross-folder duplicate, plus a unique message per folder.
                let mid = if uid == 2 {
                    "duplicate".to_string()
                } else {
                    folder.clone()
                };
                let header = format!("From: fixture@example.test\r\nTo: fixture@example.test\r\nSubject: \r\nDate: Thu, 01 Jan 1970 00:00:00 +0000\r\nMessage-ID: <{mid}@example.test>\r\n\r\n");
                reply += &format!("* {uid} FETCH (UID {uid} FLAGS (\\Seen) RFC822.SIZE 123 RFC822.HEADER {{{}}}\r\n{header})\r\n", header.len());
            }
            reply + &format!("{tag} OK fetch\r\n")
        } else if cmd == "LOGOUT" {
            format!("* BYE bye\r\n{tag} OK logout\r\n")
        } else {
            return false;
        };
        if wire
            .get_mut()
            .write_all(response.as_bytes())
            .and_then(|_| wire.get_mut().flush())
            .is_err()
        {
            return true;
        }
        if cmd == "LOGOUT" {
            return true;
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
}

async fn assert_worker_exited() {
    // A sentinel on a SINGLE-thread blocking pool cannot run until the scan
    // worker actually returns. Peer EOF alone would not prove that.
    tokio::time::timeout(
        Duration::from_millis(500),
        tokio::task::spawn_blocking(|| ()),
    )
    .await
    .expect("full-scan worker leaked after cancellation")
    .unwrap();
}

#[test]
fn full_scan_reproducer_sync_future_ignores_tokio_deadline() {
    let fixture = Fixture::new(vec![Mode::Stall("LIST")]);
    let mut client = fixture.client();
    // The OLD async body was synchronous IMAP I/O with a per-read timeout.
    // Even with a 40ms tokio deadline it blocks for the socket's 350ms.
    client
        .imap_socket
        .as_ref()
        .unwrap()
        .set_read_timeout(Some(Duration::from_millis(350)))
        .unwrap();
    runtime().block_on(async {
        let heartbeat = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Instant::now()
        });
        let start = Instant::now();
        let result = tokio::time::timeout(Duration::from_millis(40), async {
            full_scan_body(client.imap_session.as_mut().unwrap())
        })
        .await;
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(300),
            "reproducer did not block: {elapsed:?}"
        );
        assert!(
            matches!(result, Ok(Err(_))),
            "outer timeout unexpectedly interrupted synchronous read"
        );
        assert!(heartbeat.await.unwrap() >= start + Duration::from_millis(300));
        let _ = client.imap_socket.take().unwrap().shutdown(Shutdown::Both);
        client.imap_session = None;
        fixture.closed();
        eprintln!("full_scan OLD mechanism: {elapsed:?} despite 40ms deadline; heartbeat starved");
    });
}

#[test]
fn full_scan_tls_stalls_are_bounded_and_do_not_starve_runtime() {
    for stage in ["LIST", "SELECT", "SEARCH", "FETCH", "FINAL"] {
        let fixture = Fixture::new(vec![Mode::Stall(stage)]);
        let mut client = fixture.client();
        let rt = runtime();
        rt.block_on(async {
            let heartbeat = tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Instant::now()
            });
            let start = Instant::now();
            let err = client
                .fetch_messages_with_timeout(Duration::from_millis(120))
                .await
                .unwrap_err();
            let elapsed = start.elapsed();
            assert!(
                err.to_string().starts_with("Full scan timed out"),
                "{stage}: {err:?}"
            );
            assert!(elapsed < Duration::from_millis(800), "{stage}: {elapsed:?}");
            assert!(
                heartbeat.await.unwrap() < start + Duration::from_millis(100),
                "runtime heartbeat starved"
            );
            assert!(
                !client.is_connected()
                    && client.imap_socket.is_none()
                    && client.selected_folder.is_none()
            );
            fixture.closed();
            assert_worker_exited().await;
            eprintln!("full_scan TLS {stage}: {elapsed:?}, heartbeat/EOF/worker exit verified");
        });
    }
}

#[test]
fn full_scan_tls_drip_cannot_extend_overall_deadline() {
    let fixture = Fixture::new(vec![Mode::Drip]);
    let mut client = fixture.client();
    runtime().block_on(async {
        let start = Instant::now();
        assert!(client
            .fetch_messages_with_timeout(Duration::from_millis(120))
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Full scan timed out"));
        assert!(start.elapsed() < Duration::from_millis(800));
        fixture.closed();
        assert_worker_exited().await;
    });
}

#[test]
fn full_scan_tls_outer_cancellation_also_shuts_down_worker() {
    let fixture = Fixture::new(vec![Mode::Stall("LIST")]);
    let mut client = fixture.client();
    runtime().block_on(async {
        assert!(tokio::time::timeout(
            Duration::from_millis(80),
            client.fetch_messages_with_timeout(Duration::from_secs(2))
        )
        .await
        .is_err());
        assert!(!client.is_connected() && client.imap_socket.is_none());
        fixture.closed();
        assert_worker_exited().await;
    });
}

#[test]
fn full_scan_tls_healthy_preserves_headers_dedup_and_session() {
    let fixture = Fixture::new(vec![Mode::Healthy]);
    let mut client = fixture.client();
    runtime().block_on(async {
        let messages = client.fetch_messages().await.unwrap();
        assert_eq!(messages.len(), 4);
        assert_eq!(
            messages
                .iter()
                .map(|m| m.folder.as_str())
                .collect::<Vec<_>>(),
            ["INBOX", "INBOX", "Junk", "Myself"]
        );
        assert!(messages.iter().all(|m| m.subject.is_empty()
            && m.from == "fixture@example.test"
            && m.to == "fixture@example.test"
            && m.is_read
            && m.size == 123));
        assert!(client.is_connected() && client.imap_socket.is_some());
        assert_eq!(client.selected_folder.as_deref(), Some("INBOX"));
        assert!(!fixture
            .commands
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "SELECT \"Sent\"" || c == "SELECT \"All\""));
        client.disconnect();
        fixture.closed();
    });
}

#[test]
fn full_scan_tls_optional_missing_folder_is_not_network_success() {
    let fixture = Fixture::new(vec![Mode::MissingJunk]);
    let mut client = fixture.client();
    runtime().block_on(async {
        let messages = client.fetch_messages().await.unwrap();
        assert_eq!(messages.len(), 3);
        assert!(!messages.iter().any(|m| m.folder == "Junk"));
        assert!(client.is_connected());
        client.disconnect();
        fixture.closed();
    });
    for folder in ["Junk", "Myself"] {
        let fixture = Fixture::new(vec![Mode::Broken(folder)]);
        let mut client = fixture.client();
        runtime().block_on(async {
            assert!(
                client.fetch_messages().await.is_err(),
                "network failure in {folder} returned partial Ok"
            );
            assert!(!client.is_connected() && client.imap_socket.is_none());
            fixture.closed();
            assert_worker_exited().await;
        });
    }
}

#[test]
fn full_scan_tls_repeated_timeout_then_reconnect_works() {
    let fixture = Fixture::new(vec![
        Mode::Stall("LIST"),
        Mode::Stall("FETCH"),
        Mode::Healthy,
    ]);
    let mut client = fixture.client();
    runtime().block_on(async {
        for _ in 0..2 {
            assert!(client
                .fetch_messages_with_timeout(Duration::from_millis(120))
                .await
                .is_err());
            client.note_failure();
            assert!(client
                .fetch_messages()
                .await
                .unwrap_err()
                .to_string()
                .contains("backoff"));
            assert_eq!(client.fail_streak(), 1);
            fixture.closed();
            assert_worker_exited().await;
            client.connect_retry_after = Some(Instant::now() - Duration::from_millis(1));
            client.connect_imap_with_tls(&fixture.tls).unwrap();
            client.note_success();
        }
        assert_eq!(client.fetch_messages().await.unwrap().len(), 4);
        assert_eq!(client.fail_streak(), 0);
        client.disconnect();
        fixture.closed();
    });
}

#[test]
fn full_scan_busy_and_disconnected_are_visible_errors() {
    runtime().block_on(async {
        let state = crate::EmailState::default();
        let guard = state.0.lock().await;
        assert_eq!(
            crate::email_fetch_messages_inner(&state).await.unwrap_err(),
            "Email client busy; retry full scan"
        );
        drop(guard);
        assert_eq!(
            crate::email_fetch_messages_inner(&state).await.unwrap_err(),
            "Not connected to email server"
        );
    });
}
