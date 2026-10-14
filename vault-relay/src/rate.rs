//! Rate-limits (design §5.4): 10 rps publish, 5 rps poll на токен.
//! Токен-ведро in-memory; ключ — hash токена (publish — по токену
//! получателя, чтобы анонимный спам не обходил лимит сменой заголовка).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

struct Bucket {
    tokens: f64,
    updated: Instant,
}

struct Limiter {
    cap: f64,
    rate: f64,
    map: Mutex<HashMap<String, Bucket>>,
}

impl Limiter {
    fn new(cap: f64, rate: f64) -> Self {
        Self {
            cap,
            rate,
            map: Mutex::new(HashMap::new()),
        }
    }

    fn allow(&self, key: &str) -> bool {
        let mut map = self.map.lock().expect("rate lock");
        let now = Instant::now();
        let cap = self.cap;
        let rate = self.rate;
        let b = map.entry(key.to_string()).or_insert(Bucket {
            tokens: cap,
            updated: now,
        });
        let elapsed = now.duration_since(b.updated).as_secs_f64();
        b.tokens = (b.tokens + elapsed * rate).min(cap);
        b.updated = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

static PUB: std::sync::OnceLock<Limiter> = std::sync::OnceLock::new();
static POLL: std::sync::OnceLock<Limiter> = std::sync::OnceLock::new();

/// Publish: burst 10, sustained 10 rps.
pub fn allow_pub(key: &str) -> bool {
    PUB.get_or_init(|| Limiter::new(10.0, 10.0)).allow(key)
}

/// Poll: burst 5, sustained 5 rps.
pub fn allow_poll(key: &str) -> bool {
    POLL.get_or_init(|| Limiter::new(5.0, 5.0)).allow(key)
}
