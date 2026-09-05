//! In-memory хранилище конвертов: HashMap<token_hash, VecDeque>.
//! MVP — без персиста (rest server = чистые очереди; sqlite-WAL — M2.3,
//! если решим, что рестарты должны сохранять непрочитанное).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

#[derive(Clone, serde::Serialize)]
pub struct Envelope {
    /// envelope id — дедуп на клиенте (тот же, что в письме).
    pub id: String,
    /// зашифрованное тело письма (wire как есть).
    pub body: String,
    /// ttl конверта (unix-сек).
    pub exp: u64,
    /// время публикации (unix-сек) — для порядка/очистки.
    pub ts: u64,
}

#[derive(Default)]
pub struct Store {
    queues: Mutex<HashMap<String, VecDeque<Envelope>>>,
}

impl Store {
    pub fn new() -> Self {
        Self::default()
    }

    /// Положить конверт в очередь токена; FIFO-вытеснение при переполнении.
    pub fn push(&self, token_hash: &str, env: Envelope, max_queue: usize) {
        let mut q = self.queues.lock().expect("store lock");
        let deque = q.entry(token_hash.to_string()).or_default();
        // Дедуп на сервере: тот же id уже в очереди = no-op (email-дубль не
        // займёт слот дважды).
        if deque.iter().any(|e| e.id == env.id) {
            return;
        }
        if deque.len() >= max_queue {
            deque.pop_front();
        }
        deque.push_back(env);
    }

    /// Вернуть в голову (не-ack'нутые WS-конверты при обрыве).
    pub fn push_front(&self, token_hash: &str, env: Envelope, max_queue: usize) {
        let mut q = self.queues.lock().expect("store lock");
        let deque = q.entry(token_hash.to_string()).or_default();
        if deque.len() >= max_queue {
            deque.pop_back();
        }
        deque.push_front(env);
    }

    /// Забрать все живые конверты очереди (TTL-фильтрация на месте).
    pub fn drain(&self, token_hash: &str) -> Option<Vec<Envelope>> {
        let mut q = self.queues.lock().expect("store lock");
        let deque = q.get_mut(token_hash)?;
        let now = now_unix();
        deque.retain(|e| e.exp > now);
        if deque.is_empty() {
            return Some(Vec::new());
        }
        Some(deque.drain(..).collect())
    }

    /// Сколько конвертов ждёт токен (hello-кадр WS).
    pub fn len(&self, token_hash: &str) -> usize {
        let q = self.queues.lock().expect("store lock");
        let now = now_unix();
        q.get(token_hash)
            .map(|d| d.iter().filter(|e| e.exp > now).count())
            .unwrap_or(0)
    }

    /// Суммарно в очередях (для /metrics).
    pub fn total(&self) -> usize {
        let q = self.queues.lock().expect("store lock");
        q.values().map(|d| d.len()).sum()
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
