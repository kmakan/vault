// Набор мутаций: rust-listen-decrypt — как слушатель применяет ключ книги к
// входящему письму и что он об этом говорит.
//
// ЗАЧЕМ. «Ключ собеседника» раньше выбирался строго по строке `From`, и это
// молча ломало доставку: у человека несколько ящиков, письмо приходит с
// основного адреса, а ТЕКУЩИЙ ключ его автора лежит в книге за адресом-алиасом
// (31.10: koanmak@ya.ru писал письмами, зашифрованными ключом vault-msg@ya.ru;
// AEAD не сходился, письмо отбрасывалось как «не наш», и вместе с ним терялся
// relay-токен — бот переставал доставлять в чат). Гибридный PQ1-конверт это
// маскировал (там ключ сообщения задаёт KEM получателя), поэтому дефект
// проявился ровно тогда, когда отправитель ушёл на legacy-форму.
//
// ГРАНИЦА С `rust-identity`. Сам перебор (порядок, стоп-условие, четыре исхода)
// с 31.10 живёт в ядре — `vault_core::identity::decrypt_with_peer_keys` — и
// меряется набором `rust-identity`. Здесь остаётся ПРИМЕНЕНИЕ: книга из двух
// мест записи и перевод исхода в то, что слушатель скажет и запомнит. Обе части
// нужны: решение без применения теряет письмо, применение без решения —
// перебирает одним ключом.
export default {
  id: 'rust-listen-decrypt',
  crate: 'vault-client',
  kind: 'all',
  file: 'vault-client/src/listen.rs',
  smoke: 'cargo test -p vault-client',
  mutations: [
    // ── Применение исхода перебора: что слушатель сообщит ──
    { name: 'диагноз «чей ключ подошёл» теряется (письмо прочитано, а «у человека второй ящик» никто не увидит)',
      pattern: '            foreign_key_address: (!from_own_address).then_some(key_address),',
      replacement: '            foreign_key_address: None,' },
    { name: 'чужим объявляется каждый подошедший ключ, включая ключ отправителя (шум в логе на каждое обычное письмо)',
      pattern: '            foreign_key_address: (!from_own_address).then_some(key_address),',
      replacement: '            foreign_key_address: Some(key_address),' },
    { name: 'верный ключ, открывший НЕ конверт, записывается как отказ расшифровки (диагноз подменяется: «AAD» вместо «не наш формат»)',
      pattern: '        vault_core::identity::PeerLetter::NotOurLetter { .. } => Decrypted {\n            value: None,\n            foreign_key_address: None,\n            last_error: None,\n        },',
      replacement: '        vault_core::identity::PeerLetter::NotOurLetter { .. } => Decrypted {\n            value: None,\n            foreign_key_address: None,\n            last_error: Some("не наш формат".to_string()),\n        },' },
    { name: 'причина отказа перебора не доезжает до deferred-лога (письмо пропадает без следа)',
      pattern: '            last_error,\n        },\n        // Книги нет вовсе',
      replacement: '            last_error: None,\n        },\n        // Книги нет вовсе' },
    { name: 'пустая книга отменяет прежнюю одиночную попытку (первому contact-инвайту неоткуда расшифроваться)',
      pattern: '                Ok(v) => v,',
      replacement: '                Ok(_) => None,' },
    // ── Книга: ДВА места записи обязаны быть двумя местами чтения ──
    { name: 'хранилище peer-ключей не читается (живой провал 31.10: ключ телефона лежал только в keys/peer_keys.json)',
      pattern: '    book.extend(stored_keys.iter().map(|k| vault_core::identity::PeerKey {\n        address: k.email.as_str(),\n        public_key: k.public_key.as_str(),\n        pq_ek: k.pq_public_key.as_deref(),\n    }));',
      replacement: '    let _ = stored_keys;' },
    { name: 'адрес ключа из хранилища теряется (ранг «ключ отправителя» не сработает, диагноз пустой)',
      pattern: '        address: k.email.as_str(),',
      replacement: '        address: "",' },
    { name: 'ключ из хранилища приходит пустым (кандидаты выкидывают пустой ключ — перебор нечем вести)',
      pattern: '        public_key: k.public_key.as_str(),',
      replacement: '        public_key: "",' },
    { name: 'PQ-ключ собеседника из хранилища не переносится (гибридный конверт нечем открыть)',
      pattern: '        pq_ek: k.pq_public_key.as_deref(),',
      replacement: '        pq_ek: None,' },
  ],
};
