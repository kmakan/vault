// Справочник «адрес контакта → публичный ключ».
//
// Форму адреса и предикат «тот ли это человек» решает ядро
// (`vault_client::vault::identity`, ADR-005 §W4); здесь только обход списка и
// адаптация формы. Вынесено из `service_monitor` в отдельный модуль по двум
// причинам: `service_monitor` компилируется только под `target_os = "android"`
// и его тесты на хосте не запускаются вообще (ни один прогон `cargo test` их не
// видел), а этот обход — единственное место, где монитор ищет ключ собеседника
// (сигнал звонка, письмо-отказ, SOS) и строит карту для расшифровки входящих.
//
// До переноса в каждом из трёх мест было своё сравнение:
// `eq_ignore_ascii_case` не фолдит кириллицу, поэтому письмо от «Боб@mail.ru»
// монитору было «not in peers», а сигнал звонка уходил в `warn!("no peer key")`
// — на реальных адресах звонок молча не доходил. Ключи карты и пространство
// имён БД — та же нормальная форма из ядра: без обрезки контакт с обрамляющим
// пробелом терялся, а пустой адрес заводил запись «ни от кого».

use crate::key_store::StoredPeerKey;
use std::collections::HashMap;
use vault_client::vault::identity;

/// Публичный ключ контакта по адресу. «Тот ли это человек» решает
/// [`identity::same_address`], а не монитор.
pub fn peer_key_for(list: &[StoredPeerKey], address: &str) -> Option<String> {
    list.iter()
        .find(|p| identity::same_address(&p.email, address))
        .map(|p| p.public_key.clone())
}

/// Карта «адрес → публичный ключ» для расшифровки входящих. Ключи — нормальная
/// форма адреса; контакт без адреса в карту не попадает (иначе пустой `From`
/// письма совпадал бы с этой записью).
pub fn peer_map(list: &[StoredPeerKey]) -> HashMap<String, String> {
    let mut peers = HashMap::new();
    for p in list {
        if let Some(key) = identity::ledger_key(&p.email) {
            peers.insert(key, p.public_key.clone());
        }
    }
    peers
}

/// Эхо-стража: письмо, зашифрованное НАШИМ же публичным ключом — это наше
/// письмо, отвечать на него нельзя. Сравнение отпечатка — в ядре
/// ([`identity::same_fingerprint`]), пустое значение ни с чем не совпадает.
pub fn is_own_public_key(env_key: &str, my_pub_hex: &str) -> bool {
    identity::same_fingerprint(env_key, my_pub_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(email: &str, key: &str) -> StoredPeerKey {
        StoredPeerKey {
            email: email.to_string(),
            public_key: key.to_string(),
            label: None,
            added_at: String::new(),
            pq_public_key: None,
        }
    }

    #[test]
    fn peer_key_ignores_case_and_surrounding_space() {
        let list = vec![peer(" Боб@Mail.RU ", "key-bob")];
        // Письмо приходит в нормальной форме — контакт с обрамляющим пробелом
        // и кириллицей в локальной/доменной части должен находиться.
        assert_eq!(
            peer_key_for(&list, "боб@mail.ru").as_deref(),
            Some("key-bob")
        );
        assert_eq!(
            peer_key_for(&list, "  БОБ@MAIL.RU  ").as_deref(),
            Some("key-bob")
        );
        assert_eq!(peer_key_for(&list, "bob@mail.ru"), None);
    }

    #[test]
    fn empty_address_matches_no_peer() {
        let list = vec![peer("", "key-anon"), peer("x@y.z", "key-x")];
        assert_eq!(peer_key_for(&list, ""), None);
        assert_eq!(peer_key_for(&list, "   "), None);
        assert_eq!(peer_key_for(&list, "x@y.z").as_deref(), Some("key-x"));
    }

    #[test]
    fn peer_map_keys_by_normalised_form_and_drops_addressless() {
        let list = vec![peer(" Alice@Mail.ru ", "key-a"), peer("  ", "key-empty")];
        let map = peer_map(&list);
        assert_eq!(map.get("alice@mail.ru").map(String::as_str), Some("key-a"));
        assert_eq!(map.len(), 1, "контакт без адреса не попадает в карту");
        assert!(!map.contains_key(""), "пустой ключ = письмо «ни от кого»");
    }

    #[test]
    fn echo_guard_compares_fingerprint_case_insensitively() {
        assert!(is_own_public_key("AB12cd", "ab12CD"));
        assert!(!is_own_public_key("ab12cd", "ab12ce"));
        assert!(!is_own_public_key("", ""), "пустой отпечаток — не «наш»");
        assert!(!is_own_public_key("ab12cd", ""));
    }
}
