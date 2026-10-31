//! Открытие входящего письма: книга ключей и один перебор.
//!
//! ЗАЧЕМ. 31.10 приложение теряло письма ровно там, где терял их бот: ключ
//! собеседника брался одной строкой `peerKeys[from]`. Если у человека второй
//! ящик, ключ лежит за адресом-алиасом, и расшифровка падала — письмо молча
//! пропадало (в чате, в счётчике, в уведомлении). Само решение «каким ключом
//! открывать» — протокольное, поэтому живёт в ядре
//! (`vault_core::identity::decrypt_with_peer_keys`: порядок, дедуп, потолок,
//! четыре разных отказа). Здесь только два дела:
//!
//! 1. **Книга.** Записей два места — `contacts.json` (онбординг бота) и
//!    `keys/peer_keys.json` (Desktop). Читать одно из них значит не видеть
//!    ключ, который лежит в другом.
//! 2. **Применение.** Гибридный `PQ1`-конверт открывается KEM-секретом
//!    получателя, legacy — X25519; выбор формы уже сделан отправителем, а не
//!    нами, поэтому ветка ровно одна и она здесь, а не в каждой вызывающей
//!    точке.
//!
//! Мост отдаёт не только открытый текст, но и АДРЕС, за которым лежал
//! подошедший ключ: расхождение с `From` и есть «у человека второй ящик», и
//! вызывающая сторона обязана это увидеть, а не гадать по `AAD auth failed`.

use crate::{crypto, crypto_pq, key_store};
use serde::Serialize;
use vault_client::vault::contacts::ContactBook;
use vault_core::identity::{self, PeerKey, PeerLetter};
use vault_core::StoredPeerKey;

/// Ключ книги во владении вызывающего: книга переживает вызов, поэтому
/// заимствованные `&str` из `PeerKey` здесь не годятся.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedPeerKey {
    pub address: String,
    pub public_key: String,
    pub pq_ek: Option<String>,
}

/// Подсказка вызывающего (ключ, который фронт уже знает за `From`). Она
/// пробуется ПЕРВОЙ: обычный путь не должен меняться, а книга — лечение
/// случая «подсказка устарела / ключ лежит за другим адресом».
pub struct KeyHint<'a> {
    pub public_key: &'a str,
    pub pq_ek: Option<&'a str>,
}

/// Что открылось и чем. `key_address` — адрес, ЗА КОТОРЫМ лежал ключ, а не
/// обязательно отправитель.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenedLetter {
    pub plain: String,
    pub key_address: String,
    pub key_public: String,
    pub key_pq_ek: Option<String>,
    /// Ключ записан за адресом отправителя — обычный путь, ренейм не нужен.
    pub from_own_address: bool,
}

/// Почему письмо не открылось. Разные отказы не склеиваются в одно молчание:
/// «нет PQ-семени», «конверт PQ1 битый», «в книге нечего пробовать» и
/// «пробовали N ключей, последняя ошибка такая» — это разные диагнозы.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    NoPqSeed,
    MalformedPq,
    NoKey {
        tried: usize,
        last_error: Option<String>,
    },
    EmptyBook,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::NoPqSeed => write!(f, "PQ message but no PQ seed"),
            OpenError::MalformedPq => write!(f, "PQ message but malformed envelope"),
            OpenError::NoKey { tried, last_error } => {
                write!(f, "no key in the book opened the letter (tried {tried})")?;
                match last_error {
                    Some(e) => write!(f, ": {e}"),
                    None => Ok(()),
                }
            }
            OpenError::EmptyBook => write!(f, "no peer key: the key book is empty"),
        }
    }
}

/// Книга из двух мест записи. Дедуп по публичному ключу и порядок делает ядро
/// (`peer_key_candidates`), поэтому склейка ничего не решает и не сортирует.
pub fn book_from(contacts: &ContactBook, stored: &[StoredPeerKey]) -> Vec<OwnedPeerKey> {
    let mut book: Vec<OwnedPeerKey> = contacts
        .all()
        .iter()
        .map(|c| OwnedPeerKey {
            address: c.email.clone(),
            public_key: c.public_key.clone(),
            pq_ek: c.pq_public_key.clone(),
        })
        .collect();
    book.extend(stored.iter().map(|k| OwnedPeerKey {
        address: k.email.clone(),
        public_key: k.public_key.clone(),
        pq_ek: k.pq_public_key.clone(),
    }));
    book
}

/// Прочитать книгу с диска. Ошибка одного источника не отменяет второй:
/// пустая книга из-за недоступного `contacts.json` — это «нечего пробовать»,
/// то есть потерянные письма, а не честный отказ.
pub fn load_book() -> Vec<OwnedPeerKey> {
    let contacts = match ContactBook::load_default() {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[letter] contacts.json не прочитан: {e}");
            ContactBook::new()
        }
    };
    let stored = match key_store::load_peer_keys() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[letter] peer_keys.json не прочитан: {e}");
            Vec::new()
        }
    };
    book_from(&contacts, &stored)
}

/// Форма конверта. Отправитель выбирает её сам (`encrypt_vault_message`):
/// `PQ1:<kemct>|<sender_ek>|<wire>` или legacy `base64(nonce‖ct)`.
enum Wire<'a> {
    Pq { kemct: &'a str, wire: &'a str },
    Legacy,
}

fn parse_wire(body: &str) -> Result<Wire<'_>, OpenError> {
    let trimmed = body.trim();
    let Some(rest) = trimmed.strip_prefix("PQ1:") else {
        return Ok(Wire::Legacy);
    };
    let parts: Vec<&str> = rest.splitn(3, '|').collect();
    if parts.len() != 3 {
        // Раньше такой конверт проваливался в legacy-ветку и отдавал ошибку
        // base64 — по ней нельзя понять, что письмо вообще гибридное.
        return Err(OpenError::MalformedPq);
    }
    Ok(Wire::Pq {
        kemct: parts[0],
        wire: parts[2],
    })
}

/// Одна попытка: ключ книги + форма конверта. Ошибка — строка для диагноза;
/// «подошёл/не подошёл» решает AEAD, а не сравнение адресов.
fn decrypt_one(
    wire: &Wire<'_>,
    body: &str,
    private_key: &str,
    my_pq_seed: Option<&str>,
    key: &PeerKey<'_>,
) -> Result<String, String> {
    match wire {
        Wire::Pq { kemct, wire } => {
            let seed = my_pq_seed.ok_or_else(|| "PQ message but no PQ seed".to_string())?;
            // PQ-ветка: X25519-ключ ОТПРАВИТЕЛЯ обязателен (он входит в KDF),
            // а KEM-секрет даёт наш ek. Поле `sender_ek` в заголовке — это
            // ML-KEM ek отправителя, а не кривая, поэтому подставить его
            // вместо ключа книги нельзя.
            crypto_pq::hybrid_decrypt_vault(wire, private_key, key.public_key, seed, kemct)
                .map_err(|e| format!("pq1: {e:#}"))
        }
        Wire::Legacy => crypto::decrypt_vault_cmd(body, private_key, Some(key.public_key))
            .map_err(|e| format!("legacy: {e:#}")),
    }
}

/// Открыть письмо тем ключом книги, который его открывает.
///
/// Подсказка (если есть) кладётся в книгу ПОД АДРЕСОМ ОТПРАВИТЕЛЯ: так ядро
/// ставит её первой и не теряет при дедупе по публичному ключу. Пустой адрес
/// в подсказке запрещён — «ни от кого» не должен совпадать с письмом.
pub fn open_letter(
    book: &[OwnedPeerKey],
    sender: &str,
    body: &str,
    private_key: &str,
    my_pq_seed: Option<&str>,
    hint: Option<KeyHint<'_>>,
) -> Result<OpenedLetter, OpenError> {
    let wire = parse_wire(body)?;
    if matches!(wire, Wire::Pq { .. }) && my_pq_seed.is_none() {
        return Err(OpenError::NoPqSeed);
    }

    let mut candidates: Vec<OwnedPeerKey> = Vec::with_capacity(book.len() + 1);
    if let Some(h) = hint {
        if !h.public_key.trim().is_empty() {
            candidates.push(OwnedPeerKey {
                address: sender.to_string(),
                public_key: h.public_key.to_string(),
                pq_ek: h.pq_ek.map(str::to_string),
            });
        }
    }
    candidates.extend(book.iter().cloned());

    let keys: Vec<PeerKey<'_>> = candidates
        .iter()
        .map(|k| PeerKey {
            address: k.address.as_str(),
            public_key: k.public_key.as_str(),
            pq_ek: k.pq_ek.as_deref(),
        })
        .collect();

    let mut used: Option<OwnedPeerKey> = None;
    let opened = identity::decrypt_with_peer_keys(sender, &keys, |k| {
        let plain = decrypt_one(&wire, body, private_key, my_pq_seed, &k)?;
        used = Some(OwnedPeerKey {
            address: k.address.to_string(),
            public_key: k.public_key.to_string(),
            pq_ek: k.pq_ek.map(str::to_string),
        });
        Ok::<Option<String>, String>(Some(plain))
    });

    match opened {
        // `used` заполняется ровно в момент успеха, поэтому Opened без него —
        // нарушение контракта ядра; возвращаем отказ, а не панику.
        PeerLetter::Opened {
            value,
            key_address,
            from_own_address,
        } => match used {
            Some(key) => Ok(OpenedLetter {
                plain: value,
                key_address,
                key_public: key.public_key,
                key_pq_ek: key.pq_ek,
                from_own_address,
            }),
            None => Err(OpenError::NoKey {
                tried: 0,
                last_error: Some("ядро вернуло Opened без ключа".to_string()),
            }),
        },
        // Здесь недостижимо: попытка возвращает Ok(Some(_)) на успехе и не
        // различает «не наш конверт» (это делает классификатор после). Ветку
        // держим явно, чтобы новый исход ядра не превратился в молчание.
        PeerLetter::NotOurLetter { key_address } => Err(OpenError::NoKey {
            tried: 1,
            last_error: Some(format!("not a vault letter (key {key_address})")),
        }),
        PeerLetter::NoKey { tried, last_error } => Err(OpenError::NoKey { tried, last_error }),
        PeerLetter::EmptyBook => Err(OpenError::EmptyBook),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_client::vault::contacts::Contact;

    fn x25519() -> (String, String) {
        let kp = crypto::generate_keypair_cmd();
        (kp.public_key, kp.private_key)
    }

    fn legacy_letter(sender_private: &str, recipient_public: &str, text: &str) -> String {
        crypto::encrypt_vault_cmd(text, sender_private, Some(recipient_public)).unwrap()
    }

    fn pq_letter(
        sender_private: &str,
        sender_pq_seed: &str,
        recipient_public: &str,
        recipient_pq_ek: &str,
        text: &str,
    ) -> String {
        let (wire, hdr) = crypto_pq::hybrid_encrypt_vault(
            text,
            sender_private,
            recipient_public,
            Some(sender_pq_seed),
            recipient_pq_ek,
        )
        .unwrap();
        format!(
            "PQ1:{}|{}|{}",
            hdr.kemct.unwrap_or_default(),
            hdr.pq.unwrap_or_default(),
            wire
        )
    }

    fn key(address: &str, public_key: &str) -> OwnedPeerKey {
        OwnedPeerKey {
            address: address.to_string(),
            public_key: public_key.to_string(),
            pq_ek: None,
        }
    }

    #[test]
    fn a_letter_opens_with_the_key_stored_under_an_alias() {
        // Сценарий инцидента 31.10: From — основной ящик, ключ записан за
        // алиасом. Сообщение должно дойти, а вызывающий — узнать адрес ключа.
        let (bob_pub, bob_priv) = x25519();
        let (alice_pub, alice_priv) = x25519();
        let body = legacy_letter(&alice_priv, &bob_pub, "привет");
        let book = [key("alice-old@ya.ru", &alice_pub)];

        let opened = open_letter(&book, "alice@ya.ru", &body, &bob_priv, None, None).unwrap();
        assert_eq!(opened.plain, "привет");
        assert_eq!(opened.key_address, "alice-old@ya.ru");
        assert_eq!(opened.key_public, alice_pub);
        assert!(
            !opened.from_own_address,
            "ключ лежал не за адресом отправителя — это и есть второй ящик"
        );
    }

    #[test]
    fn a_hint_alone_opens_the_letter_and_stays_the_normal_path() {
        // Обычный путь: ключ лежит за `From` и передан подсказкой, книги нет.
        // Подсказка обязана открывать сама — иначе «лечение алиасов» сделало бы
        // обычный переписочный путь зависимым от диска.
        let (bob_pub, bob_priv) = x25519();
        let (alice_pub, alice_priv) = x25519();
        let body = legacy_letter(&alice_priv, &bob_pub, "обычный путь");

        let opened = open_letter(
            &[],
            "alice@ya.ru",
            &body,
            &bob_priv,
            None,
            Some(KeyHint {
                public_key: &alice_pub,
                pq_ek: None,
            }),
        )
        .unwrap();
        assert_eq!(opened.plain, "обычный путь");
        assert!(
            opened.from_own_address,
            "подсказка стоит под адресом отправителя — это обычный путь, ренейм не нужен"
        );
    }

    #[test]
    fn a_stale_hint_does_not_stop_the_book() {
        // Фронт передал ключ, который когда-то лежал за From. Он устарел, но
        // книга знает текущий ключ под другим адресом — письмо не теряется.
        let (bob_pub, bob_priv) = x25519();
        let (alice_pub, alice_priv) = x25519();
        let (stale_pub, _stale_priv) = x25519();
        let body = legacy_letter(&alice_priv, &bob_pub, "не теряй");
        let book = [key("alice-old@ya.ru", &alice_pub)];

        let opened = open_letter(
            &book,
            "alice@ya.ru",
            &body,
            &bob_priv,
            None,
            Some(KeyHint {
                public_key: &stale_pub,
                pq_ek: None,
            }),
        )
        .unwrap();
        assert_eq!(opened.plain, "не теряй");
        assert_eq!(opened.key_address, "alice-old@ya.ru");
    }

    #[test]
    fn the_senders_own_key_is_tried_first_and_wins_the_dedup() {
        // Тот же ключ лежит за двумя адресами. Победить должен адрес
        // отправителя: иначе ответы уходили бы «не туда», а ренейм запускался
        // бы на ровном месте.
        let (bob_pub, bob_priv) = x25519();
        let (alice_pub, alice_priv) = x25519();
        let body = legacy_letter(&alice_priv, &bob_pub, "ok");
        let book = [
            key("aaa@ya.ru", &alice_pub),
            key("alice@ya.ru", &alice_pub),
        ];

        let opened = open_letter(&book, "alice@ya.ru", &body, &bob_priv, None, None).unwrap();
        assert_eq!(opened.key_address, "alice@ya.ru");
        assert!(opened.from_own_address);
    }

    #[test]
    fn a_pq_letter_also_opens_with_the_alias_key() {
        // PQ1 маскировал дефект: кривая отправителя в KDF входит, но ключ
        // брался тот же — по строке From. Проверяем гибрид отдельно, чтобы
        // «legacy зелёный» не выдавался за починку PQ.
        let (bob_pub, bob_priv) = x25519();
        let (alice_pub, alice_priv) = x25519();
        let alice_pq = crypto_pq::pq_generate();
        let bob_pq = crypto_pq::pq_generate();
        let body = pq_letter(
            &alice_priv,
            &alice_pq.seed_hex,
            &bob_pub,
            &bob_pq.ek_b64,
            "гибрид",
        );
        let book = [key("alice-old@ya.ru", &alice_pub)];

        let opened = open_letter(
            &book,
            "alice@ya.ru",
            &body,
            &bob_priv,
            Some(&bob_pq.seed_hex),
            None,
        )
        .unwrap();
        assert_eq!(opened.plain, "гибрид");
        assert_eq!(opened.key_address, "alice-old@ya.ru");
        assert_eq!(opened.key_pq_ek, None, "у алиаса PQ-ключа не было");
    }

    #[test]
    fn a_pq_letter_without_seed_is_a_named_refusal() {
        let (_bob_pub, bob_priv) = x25519();
        let (_alice_pub, alice_priv) = x25519();
        let alice_pq = crypto_pq::pq_generate();
        let bob_pq = crypto_pq::pq_generate();
        let (recipient_pub, _) = x25519();
        let body = pq_letter(
            &alice_priv,
            &alice_pq.seed_hex,
            &recipient_pub,
            &bob_pq.ek_b64,
            "x",
        );
        let book = [key("alice@ya.ru", &recipient_pub)];

        let err = open_letter(&book, "alice@ya.ru", &body, &bob_priv, None, None).unwrap_err();
        assert_eq!(err, OpenError::NoPqSeed);
    }

    #[test]
    fn a_malformed_pq_envelope_is_not_reported_as_bad_base64() {
        let (_pub, priv_key) = x25519();
        let body = "PQ1:только-одно-поле";
        let err = open_letter(&[], "alice@ya.ru", body, &priv_key, Some("00"), None).unwrap_err();
        assert_eq!(err, OpenError::MalformedPq);
    }

    #[test]
    fn an_empty_book_is_a_different_refusal_than_a_wrong_key() {
        let (_pub, priv_key) = x25519();
        let err = open_letter(&[], "alice@ya.ru", "AAAA", &priv_key, None, None).unwrap_err();
        assert_eq!(err, OpenError::EmptyBook);
    }

    #[test]
    fn the_book_is_the_union_of_contacts_and_stored_keys() {
        let mut contacts = ContactBook::new();
        contacts.add(Contact::new("alice@ya.ru", "Alice", "aa"));
        let stored = [StoredPeerKey {
            email: "bob@ya.ru".to_string(),
            public_key: "bb".to_string(),
            label: None,
            added_at: String::new(),
            pq_public_key: Some("pq".to_string()),
        }];

        let book = book_from(&contacts, &stored);
        assert_eq!(book.len(), 2, "оба места записи попадают в книгу");
        assert!(book.iter().any(|k| k.address == "alice@ya.ru"));
        let bob = book.iter().find(|k| k.address == "bob@ya.ru").unwrap();
        assert_eq!(bob.public_key, "bb");
        assert_eq!(bob.pq_ek.as_deref(), Some("pq"));
    }
}
