//! Адресная доставка подписанного поста и его приём в ленту.
//!
//! Список получателей и права вычисляет общий модуль обсуждения: пост и
//! комментарий не могут разойтись по аудитории. Содержимое всегда внутри
//! адресного E2E-конверта; сам конверт не доказывает подлинность поста.

use crate::{AppError, SferaApp, SignedPost};
use social_discussion::{DiscussionError, EventOutcome};

pub fn publish(
    app: &mut SferaApp,
    ts: u64,
    body: impl Into<String>,
    audience: social_post::PostAudience,
    media: Vec<social_post::MediaRef>,
    now: u64,
) -> Result<SignedPost, AppError> {
    let post = social_post::compose(app.identity().signing_seed(), ts, body, audience, media)?;
    let previous_feed = app.feed().snapshot();
    let previous_outbox = app.previous_outbox().clone();
    let result = (|| {
        let recipients = crate::discussion::recipients(&post, app.contacts(), app.peers());
        let sender = app.encryption_material();
        if !recipients.is_empty() && sender.is_none() {
            return Err(DiscussionError::DeliveryUnavailable(
                "post delivery requires sender encryption identity".into(),
            ).into());
        }
        if let Some(sender) = sender {
            let plaintext = social_delivery::post_envelope_json(&post)
                .map_err(|e| AppError::Canonical(e.to_string()))?;
            let batch = social_bridge::seal_for_contacts(&plaintext, sender, &recipients);
            for item in batch.sealed {
                let id = social_delivery::post_publication_id(&post, &item.to)
                    .map_err(|e| AppError::Canonical(e.to_string()))?;
                let wire = serde_json::to_string(&item.envelope)
                    .map_err(|e| AppError::Canonical(e.to_string()))?;
                if !item.address.trim().is_empty() {
                    app.outbox_mut().enqueue_envelope(id, item.address, wire, false, now)?;
                }
            }
            if !batch.skipped.is_empty() {
                eprintln!("sfera: post recipients without delivery material: {}", batch.skipped.len());
            }
        }
        // Свой пост виден локально независимо от наличия сети. Входящий путь
        // всё равно проверит подпись и дедупликацию, без особой «доверенной» вставки.
        let report = app.receive_posts([post.clone()], now);
        if report.rejected != 0 {
            return Err(AppError::Feed("own post signature was rejected".into()));
        }
        Ok(post)
    })();
    if result.is_err() {
        app.replace_outbox(previous_outbox);
        app.restore_feed_snapshot(previous_feed)?;
    }
    result
}

pub fn receive(
    app: &mut SferaApp,
    post: SignedPost,
    now: u64,
) -> Result<EventOutcome, AppError> {
    // E2E выбирает получателя, но только подпись автора разрешает ленту.
    // Никакой проверки по собственной неполной книге получателя.
    let report = app.receive_posts([post], now);
    if report.rejected != 0 {
        return Err(AppError::Feed("post signature or form is invalid".into()));
    }
    if report.inserted != 0 {
        Ok(EventOutcome::Inserted)
    } else {
        Ok(EventOutcome::Duplicate)
    }
}
