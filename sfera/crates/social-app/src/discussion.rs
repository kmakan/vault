//! Композиция обсуждения с исходным постом и его аудиторией.
//!
//! `social-discussion` проверяет подпись и форму; здесь добавляется доступ.
//! Решение для комментатора берётся из книги контактов АВТОРА поста, не из
//! книги самого комментатора — иначе посторонний сам выдал бы себе доступ.

use social_discussion::{
    DiscussionBook, DiscussionError, DiscussionTarget, EventOutcome, SignedComment, SignedReaction,
};
use social_model::Fingerprint;
use social_post::SignedPost;

pub fn target(post: &SignedPost) -> Result<DiscussionTarget, DiscussionError> {
    Ok(DiscussionTarget {
        post_id: social_discussion::PostRef::from_post(&post.post)?,
        post_author: post.post.author.fp.clone(),
        audience: post.post.audience.clone(),
    })
}

fn participant_access(
    post: &SignedPost,
    author_contacts: &social_contacts::ContactBook,
    actor: &Fingerprint,
) -> Result<(), DiscussionError> {
    if post.post.author.fp.same(actor) { return Ok(()); }
    let Some(record) = author_contacts.get(actor) else {
        return Err(DiscussionError::NotInAudience);
    };
    let access = social_rights::evaluate(
        actor, record.state, record.role, &record.overrides,
        &post.post.audience.spec, &record.spheres,
    );
    if !access.delivered { return Err(DiscussionError::NotInAudience); }
    if !access.can_react() { return Err(DiscussionError::ParticipationDenied); }
    Ok(())
}

pub fn receive_comment(
    book: &mut DiscussionBook,
    known_post: Option<&SignedPost>,
    author_contacts: &social_contacts::ContactBook,
    signed: SignedComment,
) -> Result<EventOutcome, DiscussionError> {
    let post = known_post.ok_or(DiscussionError::UnknownPost)?;
    if target(post)? != signed.comment.target { return Err(DiscussionError::UnknownPost); }
    participant_access(post, author_contacts, &signed.comment.author.fp)?;
    book.insert_comment(signed)
}

pub fn receive_reaction(
    book: &mut DiscussionBook,
    known_post: Option<&SignedPost>,
    author_contacts: &social_contacts::ContactBook,
    signed: SignedReaction,
) -> Result<EventOutcome, DiscussionError> {
    let post = known_post.ok_or(DiscussionError::UnknownPost)?;
    if target(post)? != signed.reaction.target { return Err(DiscussionError::UnknownPost); }
    participant_access(post, author_contacts, &signed.reaction.author.fp)?;
    book.insert_reaction(signed)
}
