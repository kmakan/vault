//! Vault Sfera: связка композиционного корня с новыми доменами (ADR-006 §9).
//!
//! `social-app` держится в бюджете 300 строк и НЕ раздувается правилами.
//! Здесь — только композиция: принять bundle связывания, восстановить
//! репозиторий, выдать историю батчами. Все решения остаются в своих крейтах.

use social_contacts::ContactBook;
use social_history::{make_batches, HistoryBatch, HistoryKey, GrantProgress, DEFAULT_BATCH_SIZE};
use social_link::{from_uri, LinkBundle, LinkError};
use social_model::Fingerprint;
use social_repo::{RepoChain, RepoError};

#[derive(Clone, Debug)]
pub struct LinkedIdentity {
    pub account_fp: Fingerprint,
    pub device_pub_key: String,
    pub contacts: Vec<social_link::LinkedContact>,
    pub spheres: Vec<social_link::LinkedSphere>,
    pub seq: u64,
}

/// Принять QR-ссылку: разобрать, проверить цепочку, вернуть данные для корня.
pub fn accept_link(uri: &str, expected_seq: u64) -> Result<LinkedIdentity, LinkError> {
    let bundle: LinkBundle = from_uri(uri)?;
    bundle.verify(expected_seq)?;
    Ok(LinkedIdentity {
        account_fp: bundle.payload.account.fp.clone(),
        device_pub_key: bundle.payload.device_cert.device_pub_key().to_string(),
        contacts: bundle.payload.contacts.clone(),
        spheres: bundle.payload.spheres.clone(),
        seq: bundle.payload.seq,
    })
}

/// Перенести контакты из bundle в локальную книгу. Идемпотентно: повторный
/// `upsert` того же fp не создаёт второй контакт.
pub fn import_contacts(book: &mut ContactBook, identity: &LinkedIdentity) -> usize {
    let mut added = 0;
    for linked in &identity.contacts {
        let rec = social_contacts::ContactRecord::contact(
            linked.fp.clone(),
            social_model::Author::from_public_key_hex(&linked.pub_key)
                .map(|_| social_rights::Role::Acquaintance)
                .unwrap_or(social_rights::Role::Restricted),
            Vec::new(),
            false,
        );
        if book.get(&linked.fp).is_none() {
            added += 1;
        }
        book.upsert(rec);
    }
    added
}

/// Восстановить репозиторий из загруженных блоков: проверить цепочку целиком.
pub fn restore_repo(blocks: Vec<social_repo::RepoBlock>) -> Result<RepoChain, RepoError> {
    let mut chain = RepoChain::new();
    for block in blocks {
        chain.append(block)?;
    }
    chain.verify_all()?;
    Ok(chain)
}

/// Подготовить выдачу истории батчами с дедупом по nonce.
pub fn prepare_history_grant(
    book: &mut ContactBook,
    from: Fingerprint,
    to: Fingerprint,
    request_nonce: &str,
    keys: Vec<HistoryKey>,
) -> Vec<HistoryBatch> {
    let batches = make_batches(from, to, request_nonce, keys, DEFAULT_BATCH_SIZE);
    // Отмечаем nonce сразу: повторная доставка того же батча не выдаст ключ.
    for batch in &batches {
        social_history::accept_batch(book, batch);
    }
    batches
}

/// Прогресс выдачи для UI: только числа, без ключей.
pub fn grant_progress(sent_batches: usize, batches: &[HistoryBatch]) -> GrantProgress {
    GrantProgress {
        sent_batches,
        total_batches: batches.len(),
        sent_keys: batches
            .iter()
            .take(sent_batches)
            .map(|b| b.keys.len())
            .sum(),
        total_keys: batches.iter().map(|b| b.keys.len()).sum(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use social_device::DeviceCert;
    use social_link::LinkBundle;

    const ACCOUNT: &str = "0100000000000000000000000000000000000000000000000000000000000000";
    const DEVICE: &str = "0200000000000000000000000000000000000000000000000000000000000000";
    const CONTACT: &str = "0300000000000000000000000000000000000000000000000000000000000000";

    fn fp(byte: u8) -> Fingerprint {
        let mut key = [0u8; 32];
        key[0] = byte;
        Fingerprint::from_public_key_hex(&hex::encode(key)).unwrap()
    }

    fn account() -> social_model::Author {
        social_model::Author::from_public_key_hex(
            &social_device::account_public_key(ACCOUNT).unwrap(),
        ).unwrap()
    }

    fn link_uri() -> String {
        let dev_pub = social_device::account_public_key(DEVICE).unwrap();
        let cert = DeviceCert::issue(ACCOUNT, account().fp, &dev_pub, 1).unwrap();
        let contact = social_link::LinkedContact {
            fp: fp(3),
            pub_key: CONTACT.into(),
            label: "Анна".into(),
            x25519_pub: CONTACT.into(),
            pq_ek: "pq-ek".into(),
            address: "anna@example.org".into(),
        };
        let bundle = LinkBundle::create(
            ACCOUNT, account(), cert, vec![contact], vec![], 1,
        ).unwrap();
        social_link::to_uri(&bundle).unwrap()
    }

    #[test]
    fn link_and_import_contacts() {
        let identity = accept_link(&link_uri(), 0).unwrap();
        assert_eq!(identity.seq, 1);
        let mut book = ContactBook::new();
        assert_eq!(import_contacts(&mut book, &identity), 1);
        assert_eq!(import_contacts(&mut book, &identity), 0, "повтор не добавляет");
    }

    #[test]
    fn stale_link_is_rejected() {
        assert!(accept_link(&link_uri(), 1).is_err());
    }

    #[test]
    fn history_grant_is_idempotent() {
        let mut book = ContactBook::new();
        let keys = (0..3).map(|i| social_history::HistoryKey {
            blob_id: format!("{:064x}", i), key_hex: format!("{:064x}", i), epoch: 1,
        }).collect();
        let batches = prepare_history_grant(&mut book, fp(1), fp(2), "req", keys);
        assert_eq!(batches.len(), 1);
        assert!(!social_history::accept_batch(&mut book, &batches[0]), "повтор не выдаёт");
        let p = grant_progress(1, &batches);
        assert!(p.done());
        assert_eq!(p.sent_keys, 3);
    }
}

// --- Конверты профиля для контактов (ADR-006 §7.6) ------------------------
//
// Профиль публикуется адресно: каждому контакту — свой конверт, запечатанный
// его публичным ключом. Здесь композиция: `social-delivery` умеет печатать,
// `social-bridge` решает, КОМУ и с каким адресом. Правил шифрования тут нет.

use social_delivery::{seal_payload, RecipientKeyMaterial, SealedEnvelope, SenderKeyMaterial};

/// Один конверт профиля: адресат, адрес доставки и шифротекст.
#[derive(Clone, Debug)]
pub struct ProfileEnvelope {
    pub to: Fingerprint,
    pub address: String,
    pub envelope: SealedEnvelope,
}

/// Итог рассылки: кому ушло и кого пропустили.
#[derive(Clone, Debug, Default)]
pub struct EnvelopeBatch {
    pub sealed: Vec<ProfileEnvelope>,
    /// Контакты без ключей шифрования: отправить нечем. Не ошибка — их
    /// просто не видно в списке адресатов, и это надо показать человеку.
    pub skipped: Vec<Fingerprint>,
}

/// Запечатать профиль каждому контакту, у кого есть ключи.
///
/// `contacts` — из книги контактов (адрес) и bundle (ключи). Контакт без
/// ключей попадает в `skipped`, а не в ошибку: один неполный контакт не
/// должен срывать рассылку остальным.
pub fn seal_profile_for_contacts(
    profile_json: &str,
    sender: &SenderKeyMaterial,
    contacts: &[social_link::LinkedContact],
) -> EnvelopeBatch {
    let mut batch = EnvelopeBatch::default();
    for contact in contacts {
        let material = RecipientKeyMaterial::from_linked(contact);
        if !material.can_seal() {
            batch.skipped.push(contact.fp.clone());
            continue;
        }
        match seal_payload(profile_json, sender, &material) {
            Ok(envelope) => batch.sealed.push(ProfileEnvelope {
                to: contact.fp.clone(),
                address: contact.address.clone(),
                envelope,
            }),
            // Ключи битые (не hex, не base64): контакт пропускаем, остальным
            // конверты всё равно нужны.
            Err(_) => batch.skipped.push(contact.fp.clone()),
        }
    }
    batch
}

#[cfg(test)]
mod envelope_tests {
    use super::*;
    use social_delivery::open_payload;

    fn identity(byte: u8) -> social_keys::EncryptionIdentity {
        social_keys::EncryptionIdentity::generate([byte; 32]).unwrap()
    }

    fn contact_of(id: &social_keys::EncryptionIdentity, address: &str) -> social_link::LinkedContact {
        social_link::LinkedContact {
            fp: id.fingerprint().unwrap(),
            pub_key: id.x25519_public_hex().to_string(),
            label: address.to_string(),
            x25519_pub: id.x25519_public_hex().to_string(),
            pq_ek: id.pq_ek_b64().to_string(),
            address: address.to_string(),
        }
    }

    #[test]
    fn profile_is_sealed_to_every_contact_with_keys() {
        let alice = identity(11);
        let bob = identity(22);
        let carol = identity(33);
        let contacts = vec![contact_of(&bob, "bob@example.org"), contact_of(&carol, "carol@example.org")];

        let batch = seal_profile_for_contacts(r#"{"name":"Алиса"}"#, &alice.sender_material(), &contacts);
        assert_eq!(batch.sealed.len(), 2);
        assert!(batch.skipped.is_empty());

        // Боб открывает СВОЙ конверт и видит профиль.
        let for_bob = batch.sealed.iter().find(|e| e.to == bob.fingerprint().unwrap()).unwrap();
        assert_eq!(for_bob.address, "bob@example.org");
        let opened = open_payload(
            &for_bob.envelope,
            bob.x25519_private_hex(),
            &for_bob.envelope.from_x25519.clone(),
            bob.pq_seed_hex(),
        )
        .unwrap();
        assert_eq!(for_bob.envelope.from_x25519, alice.x25519_public_hex());
        assert_eq!(for_bob.envelope.v, social_delivery::ENVELOPE_VERSION);
        let wire = serde_json::to_string(&for_bob.envelope).unwrap();
        assert!(!wire.contains(alice.x25519_private_hex()), "приватный ключ не сериализуется");
        assert_eq!(opened, r#"{"name":"Алиса"}"#);
    }

    #[test]
    fn contact_without_keys_is_skipped_not_fatal() {
        // Один неполный контакт не должен срывать рассылку остальным.
        let alice = identity(44);
        let bob = identity(55);
        let mut no_keys = contact_of(&bob, "bob@example.org");
        no_keys.x25519_pub = String::new();
        no_keys.pq_ek = String::new();

        let batch = seal_profile_for_contacts("профиль", &alice.sender_material(), &[no_keys]);
        assert!(batch.sealed.is_empty());
        assert_eq!(batch.skipped.len(), 1, "контакт без ключей виден в skipped");
    }

    #[test]
    fn broken_keys_are_skipped_not_fatal() {
        // Битые ключи (не hex/base64) — тот же исход: пропуск, а не паника.
        let alice = identity(66);
        let bob = identity(77);
        let mut broken = contact_of(&bob, "bob@example.org");
        broken.x25519_pub = "не-hex".into();

        let batch = seal_profile_for_contacts("профиль", &alice.sender_material(), &[broken]);
        assert!(batch.sealed.is_empty());
        assert_eq!(batch.skipped.len(), 1);
    }

    #[test]
    fn empty_contact_list_gives_empty_batch() {
        let alice = identity(88);
        let batch = seal_profile_for_contacts("профиль", &alice.sender_material(), &[]);
        assert!(batch.sealed.is_empty() && batch.skipped.is_empty());
    }
}
