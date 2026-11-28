//! Локальная приёмка production FFI-команды синхронизации публичного канала.
//! Секреты только в env, вывод — типизированные счётчики без токенов.
//! Запуск: scripts/live-public-sync.sh с изолированным scratch-state.

use std::{path::PathBuf, sync::Arc, time::{SystemTime, UNIX_EPOCH}};
use social_app::{Identity, SferaApp};
use social_ffi::SferaState;
use social_paid::{PublicChannel, PublicFeed};
use social_post::PostAudience;
use social_rights::Audience;
use social_sync::{Quota, RetryPolicy};
use storage_local::LocalStore;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn main() {
    let root = PathBuf::from(env("SFERA_SYNC_ROOT"));
    let channel_id = env("SFERA_SYNC_CHANNEL");
    let state = SferaState::new(
        SferaApp::new(
            Identity::from_seed("01".repeat(32)).unwrap(),
            Arc::new(LocalStore::new(root.join("blobs")).unwrap()),
            RetryPolicy::default(),
            Quota::new(3600, 1_000_000, 100, now()),
        ),
        None,
    ).with_keys_dir(root.join("keys"));
    let feed_path = root.join("public/channels").join(format!("{channel_id}.json"));
    let mut feed = match PublicFeed::load_from(&feed_path).unwrap() {
        Some(feed) => feed,
        None => {
            let seed = state.call(|app| Ok(app.identity().signing_seed().to_string())).unwrap();
            let channel = PublicChannel::create(&channel_id, &seed, "Приёмка Sfera", "Изолированный тест", now()).unwrap();
            PublicFeed::new(channel).unwrap()
        }
    };
    let body = format!("Публичная приёмка {}", now());
    let post = state.call(|app| {
        app.publish_post(
            now(), body, PostAudience { id: channel_id.clone(), epoch: 1, spec: Audience::Public },
            vec![], now(),
        ).map_err(social_ffi::CommandError::from)
    }).unwrap();
    feed.publish(post).unwrap();
    feed.save_to(&feed_path).unwrap();

    let phase = env("SFERA_SYNC_PHASE");
    if phase == "prepare" {
        println!("prepared channel={channel_id} posts={}", feed.posts.len());
        return;
    }
    assert_eq!(phase, "sync", "phase must be prepare or sync");
    let report = social_ffi::sync_public_channel_for_test(
        &state,
        social_ffi::SyncPublicChannelRequest {
            v: social_ffi::API_VERSION,
            channel_id,
            base_url: env("SFERA_SYNC_URL"),
            upload_token: env("SFERA_SYNC_TOKEN"),
        },
    ).unwrap();
    println!("sync inserted={} duplicates={} posts={}", report.inserted, report.duplicates, report.posts);
}
