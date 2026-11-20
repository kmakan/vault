//! Прогон provider-conformance на in-process S3-заглушке.
//! Заглушка не проверяет подпись (это отдельные юнит-тесты SigV4), но проверяет
//! реальный HTTP-путь: PUT/GET/HEAD/DELETE + range-запросы.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use storage_s3::{S3Config, S3Store};

type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

async fn spawn_s3() -> (String, Store) {
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
                let key = path.split('?').next().unwrap_or("/").to_string();

                let body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
                let body = &buf[body_start..n];

                let (status, headers, payload): (&str, String, Vec<u8>) = if first.starts_with("PUT") {
                    state.lock().unwrap().insert(key.clone(), body.to_vec());
                    ("200 OK", String::new(), vec![])
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
                            // S3-range приходит query-параметром `?range=bytes=START-END`.
                            let range = req.lines().find(|l| l.to_ascii_lowercase().starts_with("range:"));
                            let spec = if path.contains("range=bytes=") {
                                path.split("range=bytes=").nth(1).unwrap_or("").split('&').next().unwrap_or("").to_string()
                            } else if let Some(r) = range {
                                r.split(':').nth(1).unwrap_or("").trim().strip_prefix("bytes=").unwrap_or("").to_string()
                            } else {
                                String::new()
                            };
                            let (out, extra) = if spec.is_empty() {
                                (v.clone(), String::new())
                            } else {
                                let mut parts = spec.split('-');
                                let start: usize = parts.next().unwrap_or("0").parse().unwrap_or(0);
                                let end: usize = parts.next().and_then(|s| s.parse().ok())
                                    .unwrap_or(v.len().saturating_sub(1));
                                let end = end.min(v.len().saturating_sub(1));
                                let slice = if start <= end { v[start..=end].to_vec() } else { vec![] };
                                (slice, format!("Content-Range: bytes {}-{}/{}\r\n", start, end, v.len()))
                            };
                            ("200 OK", format!("Content-Length: {}\r\n{}", out.len(), extra), out)
                        }
                        None => ("404 Not Found", String::new(), vec![]),
                    }
                } else {
                    ("405 Method Not Allowed", String::new(), vec![])
                };

                let head = format!("HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n");
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&payload).await;
                let _ = sock.flush().await;
            });
        }
    });

    (format!("http://{addr}"), blobs)
}

#[tokio::test]
async fn s3_passes_provider_conformance() {
    let (base, _state) = spawn_s3().await;
    let cfg = S3Config::new(base, "vault", "test-s3")
        .with_keys("testkey", "testsecret");
    let store = S3Store::new(cfg).unwrap();
    storage_conformance::run(&store)
        .await
        .expect("S3 must pass provider conformance");
}
