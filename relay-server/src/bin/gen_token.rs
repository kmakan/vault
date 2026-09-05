//! CLI выдачи токенов подписки (M2.4 — экран/QR позже).
//!
//! vault-relay-gen <server_key_hex> read|write <days> [count]
//!   → печатает токены построчно (их отдаём пользователям: read = клиент
//!     получателя, write = право publish, если анонимный publish выключен).

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: vault-relay-gen <server_key_hex(64)> read|write <days> [count]");
        std::process::exit(2);
    }
    let key_hex = &args[1];
    let scope = match args[2].as_str() {
        "read" => vault_relay::Scope::Read,
        "write" => vault_relay::Scope::Write,
        _ => {
            eprintln!("scope must be read|write");
            std::process::exit(2);
        }
    };
    let days: u32 = args[3].parse().unwrap_or_else(|_| {
        eprintln!("bad days");
        std::process::exit(2);
    });
    let count: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1);

    let key = match hex_decode(key_hex) {
        Some(k) if k.len() == 32 => k,
        _ => {
            eprintln!("bad key (need 64 hex chars)");
            std::process::exit(2);
        }
    };
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key);
    let keys = vault_relay::ServerKeys::new(arr);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as u32;
    let expiry = now + days * 86400;
    for _ in 0..count {
        println!("{}", vault_relay::issue(&keys, scope, expiry));
    }
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
