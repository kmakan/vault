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
    /// opaque-строка отправителя (клиентский email в открытом виде —
    /// вариант §9.3; сервер ничего не валидирует, только ретранслирует).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// M2.4 автообмен: read-токен отправителя (адрес его очереди).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tok: Option<String>,
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

    /// Peek (канал, M2): прочитать живые конверты, НЕ забирая — очередь канала
    /// общая, каждый подписчик должен получить каждый пост (fan-out на
    /// read-стороне, design channels §4.1). Дедуп — на клиенте по env.id.
    /// `since` — вернуть только посты новее unix-секунды (клиентский курсор:
    /// общий peek без него переотдавал бы всю 24ч-историю на каждый поллинг).
    /// Удаление — только по TTL (retain) и вытеснению при переполнении.
    pub fn peek(&self, token_hash: &str, since: u64) -> Option<Vec<Envelope>> {
        let mut q = self.queues.lock().expect("store lock");
        let deque = q.get_mut(token_hash)?;
        let now = now_unix();
        deque.retain(|e| e.exp > now);
        Some(deque.iter().filter(|e| e.ts > since).cloned().collect())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn env(id: &str, ts: u64, exp: u64) -> Envelope {
        Envelope {
            id: id.to_string(),
            body: format!("body-{id}"),
            exp,
            ts,
            from: None,
            tok: None,
        }
    }

    /// Живые конверты: срок — через сутки.
    fn alive(id: &str, ts: u64) -> Envelope {
        env(id, ts, now_unix() + 86_400)
    }

    #[test]
    fn push_dedups_by_envelope_id() {
        // Email-дубль (одно письмо доставлено дважды) не должен занимать слот
        // дважды: иначе очередь забивается копиями и вытесняет живые конверты.
        let s = Store::new();
        let now = now_unix();
        s.push("t1", alive("dup", now), 10);
        s.push("t1", alive("dup", now), 10);
        s.push("t1", alive("other", now), 10);
        assert_eq!(s.len("t1"), 2, "дубль с тем же id добавился повторно");
    }

    #[test]
    fn push_evicts_the_oldest_and_push_front_evicts_the_newest() {
        // Разные направления вытеснения — не деталь, а смысл: обычная
        // публикация теряет СТАРЕЙШИЙ непрочитанный, а возврат не-ack'нутых
        // при обрыве WS — НОВЕЙШИЙ (голову очереди трогать нельзя).
        let s = Store::new();
        let now = now_unix();
        for i in 0..3 {
            s.push("p", alive(&format!("p{i}"), now + i), 3);
        }
        s.push("p", alive("p3", now + 3), 3);
        let got = s.drain("p").expect("очередь есть");
        assert_eq!(
            got.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p2", "p3"],
            "push вытеснил не старейший конверт"
        );

        let s = Store::new();
        for i in 0..3 {
            s.push("f", alive(&format!("f{i}"), now + i), 3);
        }
        s.push_front("f", alive("head", now + 3), 3);
        let got = s.drain("f").expect("очередь есть");
        assert_eq!(
            got.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["head", "f0", "f1"],
            "push_front вытеснил не новейший конверт"
        );
    }

    #[test]
    fn expired_are_dropped_by_every_read_path() {
        // TTL обязан фильтровать на месте во ВСЕХ точках чтения: drain,
        // peek и len (hello-кадр WS). Иначе клиент год спустя получит
        // просроченный конверт, а счётчик будет обещать то, чего нет.
        //
        // ПОЧЕМУ ТРИ ОТДЕЛЬНЫЕ ОЧЕРЕДИ (25.10, первая версия теста на этом и
        // провалилась): retain у peek и drain удаляет просрочку ИЗ ОБЩЕЙ
        // очереди, поэтому проверка «drain не отдал мёртвый» после peek
        // меряет уже НЕ drain — мутация «убрать retain в drain» выживала на
        // зелёном тесте. Каждая точка чтения получает свой ключ.
        let s = Store::new();
        let now = now_unix();

        s.push("l", alive("live", now), 10);
        s.push("l", env("dead", now, now - 10), 10);
        assert_eq!(s.len("l"), 1, "len посчитал просроченный конверт");

        s.push("p", alive("live", now), 10);
        s.push("p", env("dead", now, now - 10), 10);
        let peeked = s.peek("p", 0).expect("очередь есть");
        assert_eq!(
            peeked.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["live"],
            "peek отдал просроченный конверт"
        );

        s.push("d", alive("live", now), 10);
        s.push("d", env("dead", now, now - 10), 10);
        let drained = s.drain("d").expect("очередь есть");
        assert_eq!(
            drained.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["live"],
            "drain отдал просроченный конверт"
        );
        // Очередь существует, но пуста — это Some([]), а не None: клиент по
        // None идёт регистрироваться заново, хотя очередь у него уже есть.
        assert!(
            matches!(s.drain("d"), Some(v) if v.is_empty()),
            "пустая очередь вернулась как None"
        );
    }

    #[test]
    fn peek_cursor_is_strictly_newer_than_since() {
        // Курсор клиента: `since` — уже полученная секунда. Возврат равной
        // (=) снова отдаёт тот же пост каждому подписчику на каждый поллинг.
        let s = Store::new();
        let now = now_unix();
        s.push("c", alive("old", now - 5), 10);
        s.push("c", alive("new", now + 5), 10);
        let got = s.peek("c", now - 5).expect("очередь есть");
        assert_eq!(
            got.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["new"],
            "peek вернул пост на границе курсора"
        );
        // peek не забирает: очередь канала общая (fan-out на read-стороне).
        assert_eq!(s.len("c"), 2, "peek забрал конверты из общей очереди");
        assert_eq!(
            s.peek("c", now - 5).map(|v| v.len()),
            Some(1),
            "второй подписчик канала ничего не получил — peek изымает очередь"
        );
    }

    #[test]
    fn unknown_queue_is_none_not_empty_vec() {
        // Разница для клиента: «очереди нет» (нужен register) против
        // «очередь есть, пусто». Подмена молча ломает регистрацию.
        let s = Store::new();
        assert!(s.drain("нет-такой").is_none());
        assert!(s.peek("нет-такой", 0).is_none());
        assert_eq!(s.len("нет-такой"), 0);
        assert_eq!(s.total(), 0);
    }
}
