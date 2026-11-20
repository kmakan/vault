//! Ретраи, квоты, outbox и идемпотентная вставка в ленту.

use social_feed::Feed;
use social_post::{compose, PostAudience, SignedPost};
use social_rights::Audience;
use social_sync::{
    ingest, DrainReport, EnqueueOutcome, MarkOutcome, Outbox, OutboxItem, OutboxState, Quota,
    QuotaError, RetryPolicy, SyncReport,
};

const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const SEED2: &str = "0200000000000000000000000000000000000000000000000000000000000000";

fn post(seed: &str, ts: u64, body: &str) -> SignedPost {
    let audience = PostAudience {
        id: "aud_x".into(),
        epoch: 1,
        spec: Audience::AllContacts,
    };
    compose(seed, ts, body, audience, vec![]).unwrap()
}

#[test]
fn retry_policy_backoff_and_exhaustion() {
    let p = RetryPolicy {
        base_ms: 100,
        factor: 2,
        max_delay_ms: 1_000,
        max_attempts: 4,
    };
    assert_eq!(p.delay_after(0), None);
    assert_eq!(p.delay_after(1), Some(100));
    assert_eq!(p.delay_after(2), Some(200));
    assert_eq!(p.delay_after(3), Some(400));
    assert_eq!(p.delay_after(4), None, "4-я неудача исчерпывает попытки");
}

#[test]
fn retry_policy_caps_delay() {
    let p = RetryPolicy {
        base_ms: 100,
        factor: 10,
        max_delay_ms: 500,
        max_attempts: 5,
    };
    assert_eq!(p.delay_after(1), Some(100));
    assert_eq!(p.delay_after(2), Some(500));
}

#[test]
fn quota_bytes_and_window_reset() {
    let mut q = Quota::new(60, 100, 10, 0);
    assert!(q.try_charge(0, 60).is_ok());
    assert_eq!(
        q.try_charge(0, 50),
        Err(QuotaError::BytesExceeded { max: 100 })
    );
    // Новое окно — счётчики сброшены.
    assert!(q.try_charge(60, 50).is_ok());
    assert_eq!(q.remaining(60), (50, 9));
}

#[test]
fn quota_items_limit() {
    let mut q = Quota::new(60, 1_000, 2, 0);
    assert!(q.try_charge(0, 1).is_ok());
    assert!(q.try_charge(0, 1).is_ok());
    assert_eq!(
        q.try_charge(0, 1),
        Err(QuotaError::ItemsExceeded { max: 2 })
    );
}

#[test]
fn enqueue_is_idempotent_and_charges_quota_once() {
    let mut ob = Outbox::new(RetryPolicy::default(), Quota::new(60, 100, 1, 0));
    assert_eq!(ob.enqueue("a", 10, 0).unwrap(), EnqueueOutcome::Enqueued);
    assert_eq!(ob.enqueue("a", 10, 0).unwrap(), EnqueueOutcome::Duplicate);
    assert_eq!(ob.len(), 1);
    assert_eq!(ob.quota().used_items, 1);
    assert!(matches!(
        ob.enqueue("b", 10, 0),
        Err(QuotaError::ItemsExceeded { .. })
    ));
}

#[test]
fn mark_failed_retries_then_fails() {
    let policy = RetryPolicy {
        base_ms: 10,
        factor: 2,
        max_delay_ms: 100,
        max_attempts: 2,
    };
    let mut ob = Outbox::new(policy, Quota::new(60, 1_000, 100, 0));
    ob.enqueue("a", 1, 100).unwrap();

    assert_eq!(ob.mark_failed("a", 100), Some(MarkOutcome::RetryAt(110)));
    let item = ob.get("a").unwrap();
    assert_eq!(item.attempts, 1);
    assert_eq!(item.state, OutboxState::Pending);

    assert_eq!(ob.mark_failed("a", 110), Some(MarkOutcome::Failed));
    assert_eq!(ob.get("a").unwrap().state, OutboxState::Failed);
    assert_eq!(ob.mark_failed("a", 120), None, "не Pending — не трогаем");
}

#[test]
fn due_respects_next_attempt_at() {
    let policy = RetryPolicy {
        base_ms: 10,
        factor: 2,
        max_delay_ms: 100,
        max_attempts: 3,
    };
    let mut ob = Outbox::new(policy, Quota::new(60, 1_000, 100, 0));
    ob.enqueue("a", 1, 100).unwrap();
    ob.mark_failed("a", 100);
    assert!(ob.due(109).is_empty());
    assert_eq!(ob.due(110).len(), 1);
}

#[test]
fn drain_due_reports_sent_and_retried() {
    let policy = RetryPolicy {
        base_ms: 10,
        factor: 2,
        max_delay_ms: 100,
        max_attempts: 3,
    };
    let mut ob = Outbox::new(policy, Quota::new(60, 1_000, 100, 0));
    for id in ["a", "b", "c"] {
        ob.enqueue(id, 1, 0).unwrap();
    }

    let report = ob.drain_due(0, |item| item.id != "c");
    assert_eq!(
        report,
        DrainReport {
            sent: 2,
            retried: 1,
            failed: 0
        }
    );
    assert_eq!(ob.get("a").unwrap().state, OutboxState::Sent);
    assert_eq!(ob.get("b").unwrap().state, OutboxState::Sent);
    assert_eq!(ob.get("c").unwrap().state, OutboxState::Pending);
    assert_eq!(ob.pending_count(), 1);
}

#[test]
fn drain_due_fails_after_attempts_exhausted() {
    let policy = RetryPolicy {
        base_ms: 10,
        factor: 2,
        max_delay_ms: 100,
        max_attempts: 1,
    };
    let mut ob = Outbox::new(policy, Quota::new(60, 1_000, 100, 0));
    ob.enqueue("a", 1, 0).unwrap();
    let report = ob.drain_due(0, |_| false);
    assert_eq!(
        report,
        DrainReport {
            sent: 0,
            retried: 0,
            failed: 1
        }
    );
    assert_eq!(ob.failed_count(), 1);
}

#[test]
fn ingest_counts_and_dedups() {
    let mut feed = Feed::new();
    let good = post(SEED, 100, "x");
    let mut evil = post(SEED, 100, "y");
    evil.post.body = "подмена".into();

    let report = ingest(&mut feed, vec![good.clone(), good, evil], 1);
    assert_eq!(
        report,
        SyncReport {
            inserted: 1,
            duplicates: 1,
            rejected: 1
        }
    );
    assert_eq!(feed.len(), 1);
}

#[test]
fn ingest_is_idempotent_across_batches() {
    let mut feed = Feed::new();
    let batch = vec![post(SEED, 100, "x"), post(SEED2, 200, "y")];

    assert_eq!(
        ingest(&mut feed, batch.clone(), 1),
        SyncReport {
            inserted: 2,
            duplicates: 0,
            rejected: 0
        }
    );
    assert_eq!(
        ingest(&mut feed, batch, 2),
        SyncReport {
            inserted: 0,
            duplicates: 2,
            rejected: 0
        }
    );
    assert_eq!(feed.len(), 2);
}

#[test]
fn outbox_item_serde_roundtrip() {
    let item = OutboxItem {
        id: "x".into(),
        payload_len: 5,
        attempts: 2,
        next_attempt_at: 7,
        state: OutboxState::Pending,
        to: Some("a@example".into()),
        envelope: Some("CONV1".into()),
        relay_mirror: true,
    };
    let json = serde_json::to_string(&item).unwrap();
    let back: OutboxItem = serde_json::from_str(&json).unwrap();
    assert_eq!(back, item);
}
