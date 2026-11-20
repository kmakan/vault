//! Лента: только валидные посты, дедуп, детерминированный порядок, read-state,
//! безопасное восстановление из сохранения.

use std::str::FromStr;

use social_feed::{Feed, FeedEntry, FeedError, InsertOutcome, PostId};
use social_post::{compose, PostAudience, SignedPost};
use social_rights::Audience;

const SEED: &str = "0100000000000000000000000000000000000000000000000000000000000000";
const SEED2: &str = "0200000000000000000000000000000000000000000000000000000000000000";

fn audience() -> PostAudience {
    PostAudience {
        id: "aud_x".into(),
        epoch: 1,
        spec: Audience::AllContacts,
    }
}

fn post(seed: &str, ts: u64, body: &str) -> SignedPost {
    compose(seed, ts, body, audience(), vec![]).unwrap()
}

#[test]
fn insert_then_duplicate() {
    let mut feed = Feed::new();
    let p = post(SEED, 100, "раз");
    let first = feed.insert(p.clone(), 1).unwrap();
    let id = match first {
        InsertOutcome::Inserted(id) => id,
        _ => panic!("expected insert"),
    };
    assert_eq!(feed.len(), 1);
    assert!(feed.contains(&id));

    // Повторная доставка не создаёт дубль.
    assert_eq!(feed.insert(p, 2).unwrap(), InsertOutcome::Duplicate(id));
    assert_eq!(feed.len(), 1);
}

#[test]
fn invalid_signature_is_rejected() {
    let mut evil = post(SEED, 100, "текст");
    evil.post.body = "подмена".into(); // подпись больше не сходится
    let mut feed = Feed::new();
    assert_eq!(feed.insert(evil, 1), Err(FeedError::InvalidSignature));
    assert!(feed.is_empty());
}

#[test]
fn order_is_ts_desc_then_id_asc() {
    let mut feed = Feed::new();
    let old = post(SEED, 100, "старый");
    let new = post(SEED, 300, "новый");
    let mid = post(SEED, 200, "средний");
    feed.insert(old, 1).unwrap();
    feed.insert(new, 2).unwrap();
    feed.insert(mid, 3).unwrap();

    let order: Vec<u64> = feed.ordered().iter().map(|e| e.post.post.ts).collect();
    assert_eq!(order, vec![300, 200, 100]);

    // Одинаковый ts — порядок по id, стабильный между устройствами.
    let mut tie = Feed::new();
    let a = post(SEED, 500, "aaa");
    let b = post(SEED, 500, "bbb");
    let ida = match tie.insert(a, 1).unwrap() {
        InsertOutcome::Inserted(id) => id,
        _ => unreachable!(),
    };
    let idb = match tie.insert(b, 2).unwrap() {
        InsertOutcome::Inserted(id) => id,
        _ => unreachable!(),
    };
    let got: Vec<PostId> = tie.ordered().iter().map(|e| e.id).collect();
    let mut expected = vec![ida, idb];
    expected.sort();
    assert_eq!(got, expected);
}

#[test]
fn read_state() {
    let mut feed = Feed::new();
    let id = match feed.insert(post(SEED, 100, "x"), 1).unwrap() {
        InsertOutcome::Inserted(id) => id,
        _ => unreachable!(),
    };
    assert_eq!(feed.unread_count(), 1);
    assert!(!feed.is_read(&id));

    assert!(feed.mark_read(&id));
    assert!(feed.is_read(&id));
    assert_eq!(feed.unread_count(), 0);
    assert!(!feed.mark_read(&id), "повторная отметка не новая");
}

#[test]
fn remove_drops_entry_and_read_state() {
    let mut feed = Feed::new();
    let id = match feed.insert(post(SEED, 100, "x"), 1).unwrap() {
        InsertOutcome::Inserted(id) => id,
        _ => unreachable!(),
    };
    feed.mark_read(&id);
    assert!(feed.remove(&id).is_some());
    assert!(!feed.contains(&id));
    assert!(!feed.is_read(&id));
    assert!(feed.remove(&id).is_none());
}

#[test]
fn post_id_is_stable_and_content_bound() {
    let a = post(SEED, 100, "одинаково");
    let b = post(SEED, 100, "одинаково");
    let c = post(SEED, 100, "другое");
    assert_eq!(PostId::from_post(&a.post).unwrap(), PostId::from_post(&b.post).unwrap());
    assert_ne!(PostId::from_post(&a.post).unwrap(), PostId::from_post(&c.post).unwrap());
}

#[test]
fn snapshot_and_restore_roundtrip() {
    let mut feed = Feed::new();
    let p = post(SEED, 100, "x");
    let id = match feed.insert(p, 7).unwrap() {
        InsertOutcome::Inserted(id) => id,
        _ => unreachable!(),
    };
    feed.mark_read(&id);

    let snapshot = feed.snapshot();
    let mut restored = Feed::restore(snapshot).unwrap();
    restored.restore_read(feed.read_ids());
    assert_eq!(restored.len(), 1);
    assert!(restored.contains(&id));
    assert!(restored.is_read(&id));
    assert_eq!(restored.ordered()[0].received_at, 7);
}

#[test]
fn restore_rejects_forged_id() {
    let entry = FeedEntry::new(post(SEED, 100, "x"), 1).unwrap();
    let mut forged = entry.clone();
    forged.id = PostId::from_str(&"00".repeat(32)).unwrap();
    assert!(matches!(
        Feed::restore(vec![forged]),
        Err(FeedError::IdMismatch)
    ));
}

#[test]
fn restore_rejects_tampered_post() {
    let mut entry = FeedEntry::new(post(SEED, 100, "x"), 1).unwrap();
    entry.post.post.body = "подмена".into();
    assert!(matches!(
        Feed::restore(vec![entry]),
        Err(FeedError::InvalidSignature)
    ));
}

#[test]
fn post_id_hex_and_json_roundtrip() {
    let id = PostId::from_post(&post(SEED2, 5, "y").post).unwrap();
    assert_eq!(id.to_hex().len(), 64);
    assert_eq!(PostId::from_str(&id.to_hex()).unwrap(), id);

    let json = serde_json::to_string(&id).unwrap();
    assert_eq!(json, format!("\"{}\"", id.to_hex()));
    assert_eq!(serde_json::from_str::<PostId>(&json).unwrap(), id);
}
