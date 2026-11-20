//! Vault Sfera — синхронизация (ADR-006 §7.1).
//!
//! Три чистых механизма, без сети и без runtime:
//! - [`RetryPolicy`] — экспоненциальная задержка с потолком и числом попыток;
//! - [`Quota`] — фиксированное окно по байтам и числу отправок;
//! - [`Outbox`] — очередь исходящих с идемпотентной постановкой и `drain_due`;
//! - [`ingest`] — идемпотентная вставка входящих в [`Feed`].
//!
//! Транспорт (IMAP/SMTP/relay) — тонкий адаптер: `drain_due` принимает
//! замыкание отправки, поэтому ядро остаётся синхронным и тестируемым.

use std::collections::BTreeMap;

use social_feed::{Feed, InsertOutcome};
use social_post::SignedPost;

/// Политика ретраев. Задержка: `base_ms * factor^(failures-1)`, не выше
/// `max_delay_ms`; после `max_attempts` неудач — окончательный провал.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RetryPolicy {
    pub base_ms: u64,
    pub factor: u32,
    pub max_delay_ms: u64,
    pub max_attempts: u32,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_ms: 1_000,
            factor: 2,
            max_delay_ms: 60_000,
            max_attempts: 5,
        }
    }
}

impl RetryPolicy {
    /// Задержка перед следующей попыткой после `failures` неудач (1-based).
    /// `None` — попытки исчерпаны.
    pub fn delay_after(&self, failures: u32) -> Option<u64> {
        if failures == 0 || failures >= self.max_attempts {
            return None;
        }
        let mut delay = self.base_ms;
        for _ in 1..failures {
            delay = delay.saturating_mul(self.factor as u64);
            if delay >= self.max_delay_ms {
                return Some(self.max_delay_ms);
            }
        }
        Some(delay.min(self.max_delay_ms))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuotaError {
    ItemsExceeded { max: u64 },
    BytesExceeded { max: u64 },
}

impl std::fmt::Display for QuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ItemsExceeded { max } => write!(f, "quota exceeded: max {max} items per window"),
            Self::BytesExceeded { max } => write!(f, "quota exceeded: max {max} bytes per window"),
        }
    }
}

impl std::error::Error for QuotaError {}

/// Квота фиксированного окна: `window_secs` секунд, затем счётчики
/// сбрасываются. Для MVP достаточно; скользящее окно — отдельная партия.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Quota {
    pub window_secs: u64,
    pub max_bytes: u64,
    pub max_items: u64,
    pub window_start: u64,
    pub used_bytes: u64,
    pub used_items: u64,
}

impl Quota {
    pub fn new(window_secs: u64, max_bytes: u64, max_items: u64, now: u64) -> Self {
        Self {
            window_secs: window_secs.max(1),
            max_bytes,
            max_items,
            window_start: now,
            used_bytes: 0,
            used_items: 0,
        }
    }

    fn roll(&mut self, now: u64) {
        let elapsed = now.saturating_sub(self.window_start);
        if elapsed >= self.window_secs {
            let windows = elapsed / self.window_secs;
            self.window_start += windows * self.window_secs;
            self.used_bytes = 0;
            self.used_items = 0;
        }
    }

    /// Списать одну отправку и `bytes`. Ошибка — лимит окна.
    pub fn try_charge(&mut self, now: u64, bytes: u64) -> Result<(), QuotaError> {
        self.roll(now);
        if self.used_items + 1 > self.max_items {
            return Err(QuotaError::ItemsExceeded {
                max: self.max_items,
            });
        }
        if self.used_bytes.saturating_add(bytes) > self.max_bytes {
            return Err(QuotaError::BytesExceeded {
                max: self.max_bytes,
            });
        }
        self.used_items += 1;
        self.used_bytes += bytes;
        Ok(())
    }

    /// Остаток в текущем окне: `(байты, отправки)`.
    pub fn remaining(&mut self, now: u64) -> (u64, u64) {
        self.roll(now);
        (
            self.max_bytes.saturating_sub(self.used_bytes),
            self.max_items.saturating_sub(self.used_items),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxState {
    Pending,
    Sent,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OutboxItem {
    pub id: String,
    pub payload_len: u64,
    pub attempts: u32,
    pub next_attempt_at: u64,
    pub state: OutboxState,
    /// Адрес получателя. `None` — старая запись без адреса (обратная
    /// совместимость); transport в таком случае отказывает типизированно.
    #[serde(default)]
    pub to: Option<String>,
    /// Готовый E2E-конверт. `None` — старая запись без конверта.
    #[serde(default)]
    pub envelope: Option<String>,
    /// Дублировать через relay (малая аудитория).
    #[serde(default)]
    pub relay_mirror: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Enqueued,
    /// Такой id уже в очереди/отправлен — повтор не плодит запись.
    Duplicate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkOutcome {
    RetryAt(u64),
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainReport {
    pub sent: usize,
    pub retried: usize,
    pub failed: usize,
}

/// Исходящая очередь. `drain_due` прогоняет созревшие элементы через
/// переданный отправитель и обновляет состояние.
#[derive(Clone, Debug)]
pub struct Outbox {
    policy: RetryPolicy,
    quota: Quota,
    items: BTreeMap<String, OutboxItem>,
}

impl Outbox {
    pub fn new(policy: RetryPolicy, quota: Quota) -> Self {
        Self {
            policy,
            quota,
            items: BTreeMap::new(),
        }
    }

    pub fn policy(&self) -> RetryPolicy {
        self.policy
    }

    pub fn quota(&self) -> &Quota {
        &self.quota
    }

    pub fn quota_mut(&mut self) -> &mut Quota {
        &mut self.quota
    }

    /// Поставить в очередь. Повторный id — `Duplicate` без списания квоты.
    pub fn enqueue(
        &mut self,
        id: impl Into<String>,
        payload_len: u64,
        now: u64,
    ) -> Result<EnqueueOutcome, QuotaError> {
        let id = id.into();
        if self.items.contains_key(&id) {
            return Ok(EnqueueOutcome::Duplicate);
        }
        self.quota.try_charge(now, payload_len)?;
        self.items.insert(
            id.clone(),
            OutboxItem {
                id,
                payload_len,
                attempts: 0,
                next_attempt_at: now,
                state: OutboxState::Pending,
                to: None,
                envelope: None,
                relay_mirror: false,
            },
        );
        Ok(EnqueueOutcome::Enqueued)
    }

    /// Поставить в очередь готовый E2E-конверт с адресом получателя.
    /// Отличие от [`enqueue`]: transport получает реальные данные и не
    /// угадывает адрес. Идемпотентность и квота — те же.
    pub fn enqueue_envelope(
        &mut self,
        id: impl Into<String>,
        to: impl Into<String>,
        envelope: impl Into<String>,
        relay_mirror: bool,
        now: u64,
    ) -> Result<EnqueueOutcome, QuotaError> {
        let id = id.into();
        if self.items.contains_key(&id) {
            return Ok(EnqueueOutcome::Duplicate);
        }
        let envelope = envelope.into();
        let payload_len = envelope.len() as u64;
        self.quota.try_charge(now, payload_len)?;
        self.items.insert(
            id.clone(),
            OutboxItem {
                id,
                payload_len,
                attempts: 0,
                next_attempt_at: now,
                state: OutboxState::Pending,
                to: Some(to.into()),
                envelope: Some(envelope),
                relay_mirror,
            },
        );
        Ok(EnqueueOutcome::Enqueued)
    }

    pub fn get(&self, id: &str) -> Option<&OutboxItem> {
        self.items.get(id)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn pending_count(&self) -> usize {
        self.items
            .values()
            .filter(|i| i.state == OutboxState::Pending)
            .count()
    }

    pub fn failed_count(&self) -> usize {
        self.items
            .values()
            .filter(|i| i.state == OutboxState::Failed)
            .count()
    }

    /// Созревшие к отправке: `Pending` и `next_attempt_at <= now`, по времени,
    /// затем по id (детерминированно).
    pub fn due(&self, now: u64) -> Vec<&OutboxItem> {
        let mut out: Vec<&OutboxItem> = self
            .items
            .values()
            .filter(|i| i.state == OutboxState::Pending && i.next_attempt_at <= now)
            .collect();
        out.sort_by(|a, b| {
            a.next_attempt_at
                .cmp(&b.next_attempt_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    pub fn mark_sent(&mut self, id: &str) -> bool {
        match self.items.get_mut(id) {
            Some(item) if item.state == OutboxState::Pending => {
                item.state = OutboxState::Sent;
                true
            }
            _ => false,
        }
    }

    /// Отметить неудачу. `RetryAt` — будет повтор, `Failed` — попытки кончились.
    pub fn mark_failed(&mut self, id: &str, now: u64) -> Option<MarkOutcome> {
        let item = self.items.get_mut(id)?;
        if item.state != OutboxState::Pending {
            return None;
        }
        item.attempts += 1;
        match self.policy.delay_after(item.attempts) {
            Some(delay) => {
                item.next_attempt_at = now + delay;
                Some(MarkOutcome::RetryAt(item.next_attempt_at))
            }
            None => {
                item.state = OutboxState::Failed;
                Some(MarkOutcome::Failed)
            }
        }
    }

    /// Прогнать созревшие элементы. `send` возвращает `true`, если отправлено.
    pub fn drain_due(
        &mut self,
        now: u64,
        mut send: impl FnMut(&OutboxItem) -> bool,
    ) -> DrainReport {
        let due: Vec<String> = self.due(now).iter().map(|i| i.id.clone()).collect();
        let mut report = DrainReport::default();
        for id in due {
            let ok = {
                let item = self
                    .items
                    .get(&id)
                    .expect("due id must exist in outbox");
                send(item)
            };
            if ok {
                self.mark_sent(&id);
                report.sent += 1;
            } else {
                match self.mark_failed(&id, now) {
                    Some(MarkOutcome::RetryAt(_)) => report.retried += 1,
                    Some(MarkOutcome::Failed) => report.failed += 1,
                    None => {}
                }
            }
        }
        report
    }
}

/// Итог входящей синхронизации.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub inserted: usize,
    pub duplicates: usize,
    pub rejected: usize,
}

/// Идемпотентно вставить входящие посты в ленту.
/// Подпись проверяет `Feed::insert`; дубликаты считаются отдельно.
pub fn ingest(
    feed: &mut Feed,
    posts: impl IntoIterator<Item = SignedPost>,
    received_at: u64,
) -> SyncReport {
    let mut report = SyncReport::default();
    for post in posts {
        match feed.insert(post, received_at) {
            Ok(InsertOutcome::Inserted(_)) => report.inserted += 1,
            Ok(InsertOutcome::Duplicate(_)) => report.duplicates += 1,
            Err(_) => report.rejected += 1,
        }
    }
    report
}
