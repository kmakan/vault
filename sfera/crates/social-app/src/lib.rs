//! Vault Sfera — композиционный корень (ADR-006 §9).
//!
//! Единственное место, где фичи видят друг друга. Здесь НЕТ правил: форма,
//! подпись, права, ротация ключей и ретраи живут в своих крейтах. Корень только
//! держит состояние каждой фичи и связывает его с портами (хранилище,
//! отправитель). Стрелки: `social-app → все фичи`, `фича ↛ фича`.
//!
//! Бюджет — 300 строк (ratchet ADR-006 §9.5). Время приходит аргументом `now`:
//! корень не читает системные часы, поэтому сценарии детерминированы.

use std::collections::BTreeMap;
use std::sync::Arc;

use social_audience::AudienceKeys;
use social_contacts::ContactBook;
use social_delivery::SenderKeyMaterial;
use social_feed::Feed;
use social_post::{compose, PostError};
use social_profile::{ProfileBook, ProfileError};
mod profile_publish;
mod profile_receive;
mod discussion;
use social_sync::{ingest, DrainReport, Outbox, Quota, QuotaError, RetryPolicy};
use storage_api::BlobStore;

// Типы домена реэкспортируются корнем: social-ffi → social-app, не в обход.
pub use social_account::Identity;
pub use social_audience::MembershipChange;
pub use social_contacts::ContactRecord;
pub use social_feed::PostId;
pub use social_model::{Author, Fingerprint};
pub use social_post::{MediaRef, PostAudience, SignedPost};
pub use social_profile::{AvatarRef, ProfileLink, SignedProfile};
pub use social_profile::UpsertOutcome as ProfileUpsertOutcome;
pub use social_rights::{Access, Audience, Role};
pub use social_sync::{OutboxItem, SyncReport};
pub use storage_api::{StoreCaps, StoreKind};

/// Итог публикации: книга обновлена, а рассылка видна по числам.
#[derive(Clone, Debug)]
pub struct ProfilePublication {
    pub outcome: ProfileUpsertOutcome,
    pub sealed: usize,
    pub skipped: usize,
}

#[derive(Debug)]
pub enum AppError {
    Post(PostError),
    Profile(ProfileError),
    Discussion(social_discussion::DiscussionError),
    Quota(QuotaError),
    Canonical(String),
    UnknownAudience(String),
    Feed(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Post(e) => write!(f, "post: {e}"),
            Self::Profile(e) => write!(f, "profile: {e}"),
            Self::Discussion(e) => write!(f, "discussion: {e}"),
            Self::Quota(e) => write!(f, "quota: {e}"),
            Self::Canonical(m) => write!(f, "canonical form failed: {m}"),
            Self::UnknownAudience(id) => write!(f, "unknown audience: {id}"),
            Self::Feed(e) => write!(f, "feed: {e}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<PostError> for AppError { fn from(e: PostError) -> Self { Self::Post(e) } }
impl From<ProfileError> for AppError { fn from(e: ProfileError) -> Self { Self::Profile(e) } }
impl From<social_discussion::DiscussionError> for AppError { fn from(e: social_discussion::DiscussionError) -> Self { Self::Discussion(e) } }
impl From<QuotaError> for AppError { fn from(e: QuotaError) -> Self { Self::Quota(e) } }
impl From<social_feed::FeedError> for AppError { fn from(e: social_feed::FeedError) -> Self { Self::Feed(e.to_string()) } }

/// Сборка приложения. Ничего не шифрует и не решает — только держит порты.
pub struct SferaApp {
    identity: Identity,
    feed: Feed,
    profiles: ProfileBook,
    discussion: social_discussion::DiscussionBook,
    contacts: ContactBook,
    outbox: Outbox,
    audiences: BTreeMap<String, AudienceKeys>,
    store: Arc<dyn BlobStore>,
    peers: Vec<social_link::LinkedContact>,
    encryption: Option<SenderKeyMaterial>,
    own_encryption_public: Option<(String, String)>,
    own_delivery_address: String,
}

impl std::fmt::Debug for SferaApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SferaApp")
            .field("identity", &self.identity)
            .field("feed", &self.feed.len())
            .field("profiles", &self.profiles.len())
            .field("outbox", &self.outbox.len())
            .field("audiences", &self.audiences.keys())
            .finish_non_exhaustive()
    }
}

impl SferaApp {
    /// Собрать приложение из идентичности, порта хранилища и политик.
    pub fn new(
        identity: Identity,
        store: Arc<dyn BlobStore>,
        retry: RetryPolicy,
        quota: Quota,
    ) -> Self {
        Self {
            identity,
            feed: Feed::new(),
            profiles: ProfileBook::new(),
            discussion: social_discussion::DiscussionBook::new(),
            contacts: ContactBook::new(),
            outbox: Outbox::new(retry, quota),
            audiences: BTreeMap::new(),
            store,
            peers: Vec::new(),
            encryption: None,
            own_encryption_public: None,
            own_delivery_address: String::new(),
        }
    }

    /// Публичные ключи получателей из проверенного bundle связывания.
    pub fn set_link_contacts(&mut self, peers: Vec<social_link::LinkedContact>) {
        self.peers = peers;
    }

    /// Объединить проверенные адресные ключи без потери уже известных.
    pub fn merge_link_contacts(&mut self, peers: impl IntoIterator<Item = social_link::LinkedContact>) {
        for peer in peers {
            if let Some(index) = self.peers.iter().position(|known| known.fp.same(&peer.fp)) {
                self.peers[index] = peer;
            } else {
                self.peers.push(peer);
            }
        }
        self.peers.sort_by(|a, b| a.fp.as_str().cmp(b.fp.as_str()));
        self.peers.dedup_by(|a, b| a.fp.same(&b.fp));
    }

    /// Публичная подпись собственного транспортного адреса для делегирования
    /// участникам обсуждения. Приватные ключи сюда не попадают.
    pub fn set_own_delivery(&mut self, address: String) {
        self.own_delivery_address = address;
    }

    pub fn own_delivery_material(&self) -> Result<social_delivery::RecipientKeyMaterial, AppError> {
        let sender = self.own_encryption_public.as_ref().ok_or_else(|| {
            social_discussion::DiscussionError::DeliveryUnavailable("owner encryption is unavailable".into())
        })?;
        if self.own_delivery_address.trim().is_empty() {
            return Err(social_discussion::DiscussionError::DeliveryUnavailable(
                "owner transport address is unavailable".into(),
            ).into());
        }
        Ok(social_delivery::RecipientKeyMaterial {
            fp: self.identity.fingerprint().clone(),
            x25519_public_hex: sender.0.clone(),
            pq_ek_b64: sender.1.clone(),
            address: self.own_delivery_address.clone(),
        })
    }

    /// Только публичная адресная часть книги; приватный ключ не выдаётся.
    pub fn link_contacts(&self) -> &[social_link::LinkedContact] {
        &self.peers
    }

    /// Свой ключ шифрования Sfera. Приватный ключ мессенджера сюда не копируется.
    pub fn set_encryption_identity(&mut self, sender: SenderKeyMaterial) {
        self.encryption = Some(sender);
    }

    /// Публичная часть того же ключа, отдельно от приватного sender material.
    pub fn set_own_encryption_public(&mut self, x25519_public_hex: String, pq_ek_b64: String) {
        self.own_encryption_public = Some((x25519_public_hex, pq_ek_b64));
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn feed(&self) -> &Feed {
        &self.feed
    }

    pub fn profiles(&self) -> &ProfileBook {
        &self.profiles
    }

    pub fn discussion(&self) -> &social_discussion::DiscussionBook {
        &self.discussion
    }

    /// Комментарий к чужому посту сначала идёт его владельцу. Локальная
    /// книга комментатора не используется для «выдачи» полной аудитории.
    pub fn comment_on_post(
        &mut self,
        id: &PostId,
        parent_id: Option<String>,
        ts: u64,
        body: &str,
        media: Vec<social_post::MediaRef>,
        now: u64,
    ) -> Result<social_discussion::SignedComment, AppError> {
        let post = self.feed.get(id).ok_or(social_discussion::DiscussionError::UnknownPost)?.post.clone();
        discussion::local_participant_access(&post, &self.contacts, self.identity.fingerprint())?;
        let target = discussion::target(&post)?;
        let comment_id = social_discussion::new_comment_id()?;
        let signed = social_discussion::compose_comment(
            self.identity.signing_seed(), &comment_id, target,
            parent_id, ts, body, media,
        )?;
        let own_post = post.post.author.fp.same(self.identity.fingerprint());
        let payload = if own_post {
            social_discussion::DiscussionPayload::SocialComment(signed.clone())
        } else {
            social_discussion::DiscussionPayload::CommentSubmission { comment: signed.clone(), post: post.clone() }
        };
        let entries = self.seal_discussion(&post, &payload)?;
        self.discussion.insert_comment(signed.clone())?;
        self.enqueue_discussion(entries, now)?;
        Ok(signed)
    }

    pub fn react_to_post(
        &mut self,
        id: &PostId,
        emoji: &str,
        removed: bool,
        now: u64,
    ) -> Result<social_discussion::SignedReaction, AppError> {
        let post = self.feed.get(id).ok_or(social_discussion::DiscussionError::UnknownPost)?.post.clone();
        discussion::local_participant_access(&post, &self.contacts, self.identity.fingerprint())?;
        let target = discussion::target(&post)?;
        let version = self.discussion.next_reaction_version(&target, self.identity.fingerprint(), emoji);
        let signed = social_discussion::compose_reaction(
            self.identity.signing_seed(), target, emoji, version, removed,
        )?;
        let own_post = post.post.author.fp.same(self.identity.fingerprint());
        let payload = if own_post {
            social_discussion::DiscussionPayload::SocialReaction(signed.clone())
        } else {
            social_discussion::DiscussionPayload::ReactionSubmission { reaction: signed.clone(), post: post.clone() }
        };
        let entries = self.seal_discussion(&post, &payload)?;
        self.discussion.insert_reaction(signed.clone())?;
        self.enqueue_discussion(entries, now)?;
        Ok(signed)
    }

    fn seal_discussion(
        &self, post: &SignedPost, payload: &social_discussion::DiscussionPayload,
    ) -> Result<Vec<(String, String, String)>, AppError> {
        let own_post = post.post.author.fp.same(self.identity.fingerprint());
        let Some(sender) = self.encryption.as_ref() else {
            if own_post { return Ok(Vec::new()); }
            return Err(social_discussion::DiscussionError::DeliveryUnavailable(
                "sender encryption identity is unavailable".into()).into());
        };
        let report = if own_post {
            discussion::seal_to(&discussion::recipients(post, &self.contacts, &self.peers), sender, payload)?
        } else {
            discussion::seal_submission_to_author(post, &self.peers, sender, payload)?
        };
        if !report.skipped.is_empty() {
            // До отдельного DTO состояния доставки недоступность хотя бы не
            // теряется в логе; адрес и содержимое конверта сюда не попадают.
            eprintln!("sfera: discussion recipients without delivery material: {}", report.skipped.len());
        }
        Ok(report.entries.into_iter().filter(|(_, address, _)| !address.trim().is_empty()).collect())
    }

    fn enqueue_discussion(&mut self, entries: Vec<(String, String, String)>, now: u64) -> Result<(), AppError> {
        for (id, address, wire) in entries {
            self.outbox.enqueue_envelope(id, address, wire, false, now)?;
        }
        Ok(())
    }

    fn receive_submission(
        &mut self, post: SignedPost, actor: &social_model::Fingerprint, ts: u64,
        comment: Option<social_discussion::SignedComment>,
        reaction: Option<social_discussion::SignedReaction>,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        if !post.post.author.fp.same(self.identity.fingerprint()) {
            return Err(social_discussion::DiscussionError::NotPostAuthor.into());
        }
        let id = PostId::from_post(&post.post)?;
        let known = self.feed.get(&id).ok_or(social_discussion::DiscussionError::UnknownPost)?;
        if known.post != post { return Err(social_discussion::DiscussionError::AttestationMismatch.into()); }
        discussion::participant_access(&post, &self.contacts, actor)?;
        let (outcome, payload) = if let Some(signed) = comment {
            let outcome = self.discussion.insert_comment(signed.clone())?;
            let attested = social_discussion::attest_comment(self.identity.signing_seed(), signed, post, ts)?;
            (outcome, social_discussion::DiscussionPayload::CommentAttestation(attested))
        } else if let Some(signed) = reaction {
            let outcome = self.discussion.insert_reaction(signed.clone())?;
            let attested = social_discussion::attest_reaction(self.identity.signing_seed(), signed, post, ts)?;
            (outcome, social_discussion::DiscussionPayload::ReactionAttestation(attested))
        } else {
            return Err(social_discussion::DiscussionError::BadId("empty discussion submission".into()).into());
        };
        if outcome != social_discussion::EventOutcome::Duplicate {
            let post = self.feed.get(&id).expect("checked post").post.clone();
            let recipients = discussion::recipients(&post, &self.contacts, &self.peers);
            let entries = self.seal_discussion(&post, &payload)?;
            self.enqueue_discussion(entries, ts)?;
            if let Some(link) = self.peers.iter().find(|peer| peer.fp.same(actor)).cloned() {
                let owner = self.own_delivery_material()?;
                let author = social_model::Author::from_public_key_hex(&link.pub_key)
                    .map_err(social_discussion::DiscussionError::BadAuthor)?;
                let material = social_delivery::RecipientKeyMaterial::from_linked(&link);
                let delegated = social_discussion::delegate_peer(
                    self.identity.signing_seed(), post.clone(), author, material, ts, owner,
                )?;
                let payload = social_discussion::DiscussionPayload::PeerDelegate(delegated);
                let entries = discussion::seal_to(
                    &recipients,
                    self.encryption.as_ref().ok_or_else(|| social_discussion::DiscussionError::DeliveryUnavailable(
                        "owner encryption is unavailable".into(),
                    ))?,
                    &payload,
                )?;
                self.enqueue_discussion(entries.entries, ts)?;
            }
        }
        Ok(outcome)
    }

    fn receive_attested_comment(
        &mut self, attested: social_discussion::CommentAttestation,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        let id = PostId::from_post(&attested.post.post)?;
        let post = self.feed.get(&id).ok_or(social_discussion::DiscussionError::UnknownPost)?;
        if post.post != attested.post { return Err(social_discussion::DiscussionError::AttestationMismatch.into()); }
        // Подпись владельца поста уже проверена parse_envelope_json. Права
        // специально не переоцениваются неполной книгой этого получателя.
        Ok(self.discussion.insert_comment(attested.comment)?)
    }

    fn receive_attested_reaction(
        &mut self, attested: social_discussion::ReactionAttestation,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        let id = PostId::from_post(&attested.post.post)?;
        let post = self.feed.get(&id).ok_or(social_discussion::DiscussionError::UnknownPost)?;
        if post.post != attested.post { return Err(social_discussion::DiscussionError::AttestationMismatch.into()); }
        Ok(self.discussion.insert_reaction(attested.reaction)?)
    }

    fn receive_peer_delegate(
        &mut self, delegated: social_discussion::PeerDelegate,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        let id = PostId::from_post(&delegated.post.post)?;
        let known = self.feed.get(&id).ok_or(social_discussion::DiscussionError::UnknownPost)?;
        if known.post != delegated.post {
            return Err(social_discussion::DiscussionError::AttestationMismatch.into());
        }
        let record = social_contacts::ContactRecord::contact(
            delegated.actor.fp.clone(), Role::Friend, vec![], true,
        );
        self.contacts_mut().upsert(record);
        self.merge_link_contacts([
            social_link::LinkedContact {
                fp: delegated.owner.fp.clone(),
                pub_key: delegated.post.post.author.pub_key.clone(),
                label: String::new(),
                x25519_pub: delegated.owner.x25519_public_hex,
                pq_ek: delegated.owner.pq_ek_b64,
                address: delegated.owner.address,
            },
            social_link::LinkedContact {
                fp: delegated.actor.fp,
                pub_key: delegated.actor.pub_key,
                label: String::new(),
                x25519_pub: delegated.encryption.x25519_public_hex,
                pq_ek: delegated.encryption.pq_ek_b64,
                address: delegated.encryption.address,
            },
        ]);
        Ok(social_discussion::EventOutcome::Updated)
    }

    pub fn receive_discussion_payload(
        &mut self, payload: social_discussion::DiscussionPayload, now: u64,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        use social_discussion::DiscussionPayload as Payload;
        match payload {
            Payload::SocialComment(signed) => {
                let id = signed.comment.target.post_id.to_hex().parse()
                    .map_err(|_| social_discussion::DiscussionError::UnknownPost)?;
                self.receive_comment(&id, signed)
            }
            Payload::SocialReaction(signed) => {
                let id = signed.reaction.target.post_id.to_hex().parse()
                    .map_err(|_| social_discussion::DiscussionError::UnknownPost)?;
                self.receive_reaction(&id, signed)
            }
            Payload::CommentSubmission { comment, post } => {
                let actor = comment.comment.author.fp.clone();
                self.receive_submission(post, &actor, now, Some(comment), None)
            }
            Payload::ReactionSubmission { reaction, post } => {
                let actor = reaction.reaction.author.fp.clone();
                self.receive_submission(post, &actor, now, None, Some(reaction))
            }
            Payload::CommentAttestation(attested) => self.receive_attested_comment(attested),
            Payload::ReactionAttestation(attested) => self.receive_attested_reaction(attested),
            Payload::PeerDelegate(delegated) => self.receive_peer_delegate(delegated),
        }
    }

    pub fn receive_discussion_envelope(
        &mut self,
        envelope: &social_delivery::SealedEnvelope,
        x25519_private: &str,
        pq_seed: &str,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        let plaintext = social_delivery::open_payload(envelope, x25519_private, &envelope.from_x25519, pq_seed)
            .map_err(|e| AppError::Canonical(e.to_string()))?;
        let payload = social_discussion::parse_envelope_json(&plaintext)?;
        self.receive_discussion_payload(payload, 0)
    }

    pub fn receive_comment(
        &mut self,
        post_id: &PostId,
        signed: social_discussion::SignedComment,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        let post = self.feed.get(post_id).map(|e| &e.post);
        Ok(discussion::receive_comment(&mut self.discussion, post, &self.contacts, signed)?)
    }

    pub fn receive_reaction(
        &mut self,
        post_id: &PostId,
        signed: social_discussion::SignedReaction,
    ) -> Result<social_discussion::EventOutcome, AppError> {
        let post = self.feed.get(post_id).map(|e| &e.post);
        Ok(discussion::receive_reaction(&mut self.discussion, post, &self.contacts, signed)?)
    }

    pub(crate) fn profiles_mut(&mut self) -> &mut ProfileBook {
        &mut self.profiles
    }

    pub(crate) fn outbox_mut(&mut self) -> &mut Outbox {
        &mut self.outbox
    }

    pub fn feed_snapshot(&self) -> Vec<SignedPost> {
        self.feed.snapshot().into_iter().map(|entry| entry.post).collect()
    }

    pub fn restore_feed(&mut self, posts: Vec<SignedPost>, now: u64) -> Result<(), AppError> {
        let report = self.receive_posts(posts, now);
        if report.rejected > 0 {
            return Err(AppError::Canonical("stored post is invalid".into()));
        }
        Ok(())
    }

    /// Восстановить локальную книгу после повторной проверки каждой подписи.
    /// Права и привязку к известному посту проверяет тот же путь, что и сеть.
    pub fn restore_discussion(
        &mut self,
        comments: Vec<social_discussion::SignedComment>,
        reactions: Vec<social_discussion::SignedReaction>,
    ) -> Result<(), AppError> {
        for signed in comments {
            let id: PostId = signed.comment.target.post_id.to_hex().parse()
                .map_err(|_| social_discussion::DiscussionError::UnknownPost)?;
            self.receive_comment(&id, signed)?;
        }
        for signed in reactions {
            let id: PostId = signed.reaction.target.post_id.to_hex().parse()
                .map_err(|_| social_discussion::DiscussionError::UnknownPost)?;
            self.receive_reaction(&id, signed)?;
        }
        Ok(())
    }

    pub fn contacts(&self) -> &ContactBook {
        &self.contacts
    }

    /// Изменение книги контактов — только через корень: правило состояния
    /// заявки живёт в social-contacts, корень не принимает решений.
    pub fn contacts_mut(&mut self) -> &mut ContactBook {
        &mut self.contacts
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    pub fn store(&self) -> &Arc<dyn BlobStore> {
        &self.store
    }

    pub fn audience(&self, id: &str) -> Option<&AudienceKeys> {
        self.audiences.get(id)
    }

    /// Все аудитории автора. Только чтение: состав и эпохи решает
    /// `social-audience`, корень их не пересчитывает.
    pub fn audiences(&self) -> impl Iterator<Item = &AudienceKeys> {
        self.audiences.values()
    }

    /// Зарегистрировать ключи аудитории (состояние фичи `social-audience`).
    pub fn put_audience(&mut self, keys: AudienceKeys) {
        self.audiences.insert(keys.audience_id().to_string(), keys);
    }

    /// Создать аудиторию с заданным составом: конструктор живёт в
    /// `social-audience`, корень только вызывает его.
    pub fn create_audience<I>(&mut self, id: impl Into<String>, members: I)
    where
        I: IntoIterator<Item = Fingerprint>,
    {
        self.put_audience(AudienceKeys::new(id, members));
    }

    /// Применить состав аудитории; ротацию решает `social-audience`.
    pub fn set_audience_members<I>(
        &mut self,
        id: &str,
        members: I,
    ) -> Result<MembershipChange, AppError>
    where
        I: IntoIterator<Item = Fingerprint>,
    {
        let keys = self
            .audiences
            .get_mut(id)
            .ok_or_else(|| AppError::UnknownAudience(id.to_string()))?;
        Ok(keys.apply_membership(members))
    }

    /// Принять контакт; переходы решают `social-contacts`.
    pub fn put_contact(&mut self, record: ContactRecord) {
        self.contacts.upsert(record);
    }

    /// Сменить роль принятого контакта; проверку состояния делает
    /// `social-contacts`, корень только передаёт вызов.
    pub fn set_contact_role(
        &mut self,
        fp: &Fingerprint,
        role: Role,
    ) -> Result<(), social_contacts::ContactError> {
        self.contacts.set_role(fp, role)
    }

    /// Опубликовать пост: сборка/подпись в `social-post`, постановка в outbox.
    /// Доставку делает `sync_outbox`, здесь её нет.
    pub fn publish_post(
        &mut self,
        ts: u64,
        body: impl Into<String>,
        audience: PostAudience,
        media: Vec<social_post::MediaRef>,
        now: u64,
    ) -> Result<SignedPost, AppError> {
        let post = compose(self.identity.signing_seed(), ts, body, audience, media)?;
        let id = PostId::from_post(&post.post)
            .map_err(|e| AppError::Canonical(e.to_string()))?
            .to_hex();
        let len = social_post::canonical_post(&post.post)
            .map_err(AppError::Canonical)?
            .len() as u64;
        self.outbox.enqueue(id, len, now)?;
        Ok(post)
    }

    /// Принять входящие посты: проверка подписи и дедуп в `social-feed`.
    pub fn receive_posts(
        &mut self,
        posts: impl IntoIterator<Item = SignedPost>,
        received_at: u64,
    ) -> SyncReport {
        ingest(&mut self.feed, posts, received_at)
    }

    /// Отметить прочитанным — локальное состояние ленты.
    pub fn mark_read(&mut self, id: &PostId) -> bool {
        self.feed.mark_read(id)
    }

    /// Опубликовать свой профиль: подпись в `social-profile`, обновление книги.
    /// Адресная рассылка и манифест — композиция в `social-bridge`.
    pub fn set_my_profile(
        &mut self,
        ts: u64,
        display_name: impl Into<String>,
        bio: impl Into<String>,
        avatar: Option<AvatarRef>,
        links: Vec<ProfileLink>,
        now: u64,
        avatar_manifest: Option<serde_json::Value>,
    ) -> Result<ProfilePublication, AppError> {
        let sender = self.encryption.clone();
        let peers = self.peers.clone();
        profile_publish::set_my_profile(
            self, ts, display_name, bio, avatar, links, now,
            avatar_manifest, &peers, sender.as_ref(),
        )
    }

    /// Принять чужой профиль; «новее побеждает» решает `social-profile`.
    pub fn receive_profile(&mut self, signed: SignedProfile) -> Result<ProfileUpsertOutcome, AppError> {
        Ok(self.profiles.upsert(signed)?)
    }

    /// Принять адресный конверт своими приватными ключами Sfera.
    pub fn receive_profile_envelope(
        &mut self,
        envelope: &social_delivery::SealedEnvelope,
        recipient_x25519_private_hex: &str,
        recipient_pq_seed_hex: &str,
    ) -> Result<profile_receive::ReceivedProfile, AppError> {
        profile_receive::receive_profile_envelope(
            self, envelope, recipient_x25519_private_hex, recipient_pq_seed_hex,
        )
    }

    /// Профиль по отпечатку (для показа контактам).
    pub fn profile_of(&self, fp: &Fingerprint) -> Option<&SignedProfile> {
        self.profiles.get(fp)
    }

    /// Решение о доступе: состояние отношения из `social-contacts`, вердикт
    /// считает `social-rights`. Корень только соединяет их.
    pub fn access(
        &self,
        viewer: &Fingerprint,
        audience: &Audience,
        viewer_spheres: &[String],
    ) -> Option<Access> {
        let record = self.contacts.get(viewer)?;
        Some(social_rights::evaluate(
            viewer,
            record.state,
            record.role,
            &record.overrides,
            audience,
            viewer_spheres,
        ))
    }

    /// Прогнать очередь. `send` — тонкий адаптер email/relay; корень не знает,
    /// чем именно отправляется конверт.
    pub fn sync_outbox(&mut self, now: u64, send: impl FnMut(&OutboxItem) -> bool) -> DrainReport {
        self.outbox.drain_due(now, send)
    }
}
