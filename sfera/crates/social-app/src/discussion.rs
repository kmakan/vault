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
use social_rights::Audience;

fn permitted(audience: &Audience, record: &social_contacts::ContactRecord) -> bool {
    match audience {
        Audience::AllContacts => true,
        Audience::Sphere { id } => record.spheres.iter().any(|sphere| sphere == id),
        Audience::Selected { fps } => fps.iter().any(|candidate| candidate.same(&record.fp)),
        Audience::AllExcept { fps } => !fps.iter().any(|candidate| candidate.same(&record.fp)),
    }
}

pub fn recipients(
    post: &SignedPost,
    author_contacts: &social_contacts::ContactBook,
    peers: &[social_link::LinkedContact],
) -> Vec<social_link::LinkedContact> {
    // До протокола делегированной рассылки ответ распространяет сам участник.
    // Книга автора поста ограничивает исходную аудиторию; peers дают ключи
    // собеседников участника. Их пересечение не раскрывает чужую адресную книгу.
    let candidates = author_contacts.contacts().filter(|record| {
        permitted(&post.post.audience.spec, record)
            && participant_access(post, author_contacts, &record.fp).is_ok()
    });
    let mut recipients = Vec::new();
    for record in candidates {
        if let Some(peer) = peers.iter().find(|peer| peer.fp.same(&record.fp)) {
            recipients.push(peer.clone());
        }
    }
    recipients.sort_by(|a, b| a.fp.as_str().cmp(b.fp.as_str()));
    recipients.dedup_by(|a, b| a.fp.same(&b.fp));
    recipients
}

pub fn seal(
    post: &SignedPost,
    author_contacts: &social_contacts::ContactBook,
    peers: &[social_link::LinkedContact],
    sender: &social_delivery::SenderKeyMaterial,
    payload: &social_discussion::DiscussionPayload,
) -> Result<Vec<(String, String, String)>, DiscussionError> {
    let plaintext = social_discussion::envelope_json(payload)?;
    let batch = social_bridge::seal_for_contacts(&plaintext, sender, &recipients(post, author_contacts, peers));
    let mut outbox = Vec::new();
    for item in batch.sealed {
        let id = social_discussion::publication_id(payload, &item.to)?;
        let wire = serde_json::to_string(&item.envelope)
            .map_err(|e| DiscussionError::Canonical(e.to_string()))?;
        outbox.push((id, item.address, wire));
    }
    Ok(outbox)
}

pub fn receive_envelope(
    app: &mut crate::SferaApp,
    envelope: &social_delivery::SealedEnvelope,
    x25519_private: &str,
    pq_seed: &str,
) -> Result<EventOutcome, DiscussionError> {
    let plaintext = social_delivery::open_payload(envelope, x25519_private, &envelope.from_x25519, pq_seed)
        .map_err(|e| DiscussionError::Canonical(e.to_string()))?;
    match social_discussion::parse_envelope_json(&plaintext)? {
        social_discussion::DiscussionPayload::SocialComment(signed) => {
            let id = signed.comment.target.post_id.to_hex().parse()
                .map_err(|_| DiscussionError::UnknownPost)?;
            app.receive_comment(&id, signed).map_err(|e| DiscussionError::Canonical(e.to_string()))
        }
        social_discussion::DiscussionPayload::SocialReaction(signed) => {
            let id = signed.reaction.target.post_id.to_hex().parse()
                .map_err(|_| DiscussionError::UnknownPost)?;
            app.receive_reaction(&id, signed).map_err(|e| DiscussionError::Canonical(e.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use social_discussion::compose_comment;
    use social_model::post::public_key_hex;
    use social_post::PostAudience;
    use social_rights::Role;

    fn fp(seed: &str) -> Fingerprint {
        Fingerprint::from_public_key_hex(&public_key_hex(seed).unwrap()).unwrap()
    }

    #[test]
    fn sealed_comment_contains_no_plaintext_and_opens_for_selected_recipient() {
        let sender = social_keys::EncryptionIdentity::generate([11; 32]).unwrap();
        let recipient = social_keys::EncryptionIdentity::generate([22; 32]).unwrap();
        let outsider = social_keys::EncryptionIdentity::generate([33; 32]).unwrap();
        let recipient_fp = recipient.fingerprint().unwrap();
        let author = social_model::Author::from_public_key_hex(
            &social_model::post::public_key_hex(&"01".repeat(32)).unwrap()).unwrap();
        let post = SignedPost { post: social_post::PostV1::new(
            author, 1, "Пост", PostAudience { id: "family".into(), epoch: 1,
                spec: Audience::Selected { fps: vec![recipient_fp.clone()] } }, vec![],
        ).unwrap(), sig: String::new() };
        let mut book = social_contacts::ContactBook::new();
        book.upsert(social_contacts::ContactRecord::contact(recipient_fp, Role::Friend, vec![], true));
        let linked = social_link::LinkedContact {
            fp: recipient.fingerprint().unwrap(), pub_key: String::new(), label: String::new(),
            x25519_pub: recipient.x25519_public_hex().into(), pq_ek: recipient.pq_ek_b64().into(),
            address: "recipient@example.org".into(),
        };
        let target = DiscussionTarget {
            post_id: social_discussion::PostRef::from_post(&post.post).unwrap(),
            post_author: post.post.author.fp.clone(), audience: post.post.audience.clone(),
        };
        let signed = compose_comment(&"02".repeat(32), &"44".repeat(32), target, None, 2,
            "СЕКРЕТНЫЙ_КОММЕНТАРИЙ", vec![]).unwrap();
        let payload = social_discussion::DiscussionPayload::SocialComment(signed.clone());
        let entries = seal(&post, &book, &[linked], &sender.sender_material(), &payload).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].2.contains("СЕКРЕТНЫЙ_КОММЕНТАРИЙ"));
        let envelope: social_delivery::SealedEnvelope = serde_json::from_str(&entries[0].2).unwrap();
        let plaintext = social_delivery::open_payload(&envelope, recipient.x25519_private_hex(),
            &envelope.from_x25519, recipient.pq_seed_hex()).unwrap();
        assert_eq!(social_discussion::parse_envelope_json(&plaintext).unwrap(), payload);
        assert!(social_delivery::open_payload(&envelope, outsider.x25519_private_hex(),
            &envelope.from_x25519, outsider.pq_seed_hex()).is_err());
    }

    #[test]
    fn recipients_use_post_audience_not_every_peer() {
        let a = fp(&"01".repeat(32));
        let b = fp(&"02".repeat(32));
        let c = fp(&"03".repeat(32));
        let author = social_model::Author::from_public_key_hex(&public_key_hex(&"01".repeat(32)).unwrap()).unwrap();
        let post = SignedPost { post: social_post::PostV1::new(
            author, 1, "post", PostAudience { id: "x".into(), epoch: 1,
                spec: Audience::Selected { fps: vec![b.clone()] } }, vec![],
        ).unwrap(), sig: String::new() };
        let mut book = social_contacts::ContactBook::new();
        for candidate in [b.clone(), c.clone()] {
            book.upsert(social_contacts::ContactRecord::contact(candidate, Role::Friend, vec![], true));
        }
        let peers = [b, c].into_iter().map(|candidate| social_link::LinkedContact {
            fp: candidate, pub_key: String::new(), label: String::new(), x25519_pub: String::new(),
            pq_ek: String::new(), address: String::new(),
        }).collect::<Vec<_>>();
        let recipients = recipients(&post, &book, &peers);
        assert_eq!(recipients.len(), 1);
        assert!(recipients[0].fp.same(&fp(&"02".repeat(32))));
        assert!(!recipients.iter().any(|p| p.fp.same(&a)));
    }
}

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
