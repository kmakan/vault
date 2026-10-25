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

#[cfg(test)]
mod tests {
    use super::*;

    /// Ведро — process-global `OnceLock`, а `cargo test` гоняет тесты в одном
    /// процессе параллельно. Каждый тест берёт свой ключ, иначе они вычерпывают
    /// ведро друг у друга и результат зависит от порядка.
    fn key(tag: &str) -> String {
        format!("rate-test-{tag}-{}", std::process::id())
    }

    fn count_allowed(allow: impl Fn(&str) -> bool, k: &str, n: usize) -> usize {
        (0..n).filter(|_| allow(k)).count()
    }

    #[test]
    fn fresh_bucket_allows_and_burst_is_capped() {
        // Потолки с запасом: между вызовами капает время и ведро чуть
        // пополняется, на загруженной машине цикл может занять миллисекунды.
        let k = key("pub");
        assert!(allow_pub(&k), "первый запрос обязан пройти");
        let allowed = count_allowed(allow_pub, &k, 60);
        assert!(
            allowed <= 20 && allowed >= 5,
            "burst публикации: {allowed} из 60 (ожидается ~10)"
        );

        let k = key("poll");
        assert!(allow_poll(&k), "первый опрос обязан пройти");
        let allowed = count_allowed(allow_poll, &k, 30);
        assert!(
            allowed <= 8 && allowed >= 2,
            "burst опроса: {allowed} из 30 (ожидается ~5; 10 = ведро публикации)"
        );
    }

    #[test]
    fn keys_have_own_buckets() {
        // Ключ — hash токена получателя: иначе один спамер вычерпывает лимит
        // всех остальных, и анонимный спам обходится сменой заголовка.
        count_allowed(allow_pub, &key("drained"), 30);
        let fresh = key("fresh");
        let allowed = count_allowed(allow_pub, &fresh, 10);
        assert!(allowed >= 5, "свежий ключ без собственного ведра: {allowed} из 10");
    }

    #[test]
    fn fractional_seconds_refill_the_bucket() {
        // Пополнение считается в ДОЛЯХ секунды: 0,35 с при 10 rps = ~3 запроса.
        // Целые секунды или деление на скорость дают ноль — лимит становится
        // в разы жёстче и легитимный клиент начинает получать 429.
        let k = key("fractional");
        count_allowed(allow_pub, &k, 30);
        std::thread::sleep(std::time::Duration::from_millis(350));
        let allowed = count_allowed(allow_pub, &k, 5);
        assert!(allowed >= 2, "за 0,35 с ведро не пополнилось: {allowed} из 5");
    }

    #[test]
    fn idle_does_not_grow_the_bucket_past_its_burst() {
        // Потолок ведра = burst. Без него пауза в 2,1 с превращается в 21
        // токен: один клиент залпом проходит после каждого простоя.
        let k = key("idlecap");
        count_allowed(allow_pub, &k, 30);
        std::thread::sleep(std::time::Duration::from_millis(2100));
        let allowed = count_allowed(allow_pub, &k, 20);
        assert!(
            allowed <= 14,
            "после простоя ведро больше burst: {allowed} из 20 (ожидается ~10)"
        );
    }
}
