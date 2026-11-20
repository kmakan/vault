//! Яндекс Диск говорит по WebDAV, поэтому HTTP-логика не дублируется:
//! conformance прогоняется на том же transports, что и storage-webdav,
//! но с Bearer-авторизацией (как в YandexTokens).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use storage_webdav::{WebDavConfig, WebDavStore};

type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

async fn spawn_dav() -> (String, Store) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let blobs: Store = Arc::new(Mutex::new(HashMap::new()));
    let state = blobs.clone();

    tokio::spawn(async move {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let state = state.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let first = req.lines().next().unwrap_or("").to_string();
                let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                let key = path.trim_start_matches('/').to_string();
                let body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
                let body = &buf[body_start..n];

                let (status, headers, payload): (&str, String, Vec<u8>) = if first.starts_with("PUT") {
                    state.lock().unwrap().insert(key, body.to_vec());
                    ("201 Created", String::new(), vec![])
                } else if first.starts_with("HEAD") {
                    match state.lock().unwrap().get(&key) {
                        Some(v) => ("200 OK", format!("Content-Length: {}\r\n", v.len()), vec![]),
                        None => ("404 Not Found", String::new(), vec![]),
                    }
                } else if first.starts_with("DELETE") {
                    state.lock().unwrap().remove(&key);
                    ("204 No Content", String::new(), vec![])
                } else if first.starts_with("GET") {
                    match state.lock().unwrap().get(&key) {
                        Some(v) => {
                            let range = req.lines().find(|l| l.to_ascii_lowercase().starts_with("range:"));
                            let (out, extra) = match range {
                                Some(r) => {
                                    let spec = r.split(':').nth(1).unwrap_or("").trim();
                                    let spec = spec.strip_prefix("bytes=").unwrap_or(spec);
                                    let mut parts = spec.split('-');
                                    let start: usize = parts.next().unwrap_or("0").parse().unwrap_or(0);
                                    let end: usize = parts.next().and_then(|s| s.parse().ok())
                                        .unwrap_or(v.len().saturating_sub(1));
                                    let end = end.min(v.len().saturating_sub(1));
                                    let slice = if start <= end { v[start..=end].to_vec() } else { vec![] };
                                    (slice, format!("Content-Range: bytes {}-{}/{}\r\n", start, end, v.len()))
                                }
                                None => (v.clone(), String::new()),
                            };
                            ("206 Partial Content", format!("Content-Length: {}\r\n{}", out.len(), extra), out)
                        }
                        None => ("404 Not Found", String::new(), vec![]),
                    }
                } else {
                    ("405 Method Not Allowed", String::new(), vec![])
                };

                let head = format!("HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n");
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&payload).await;
            });
        }
    });

    (format!("http://{addr}"), blobs)
}

#[tokio::test]
async fn yandex_transport_passes_provider_conformance() {
    let (base, _state) = spawn_dav().await;
    let cfg = WebDavConfig::new(format!("{base}/vault"), storage_yandex::STORE_ID)
        .with_bearer_token("test-oauth-token");
    let store = WebDavStore::new(cfg).unwrap();
    storage_conformance::run(&store)
        .await
        .expect("Yandex WebDAV transport must pass provider conformance");
}
