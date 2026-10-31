// Набор мутаций: rust-listen-decrypt — каким ключом слушатель расшифровывает
// входящее письмо и что он об этом говорит.
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
// Что меряется здесь, а не в `rust-identity`: применение порядка. Перебор обязан
// (1) остановиться на первом совпадении, (2) не соврать в диагнозе «чей ключ
// подошёл», (3) оставить прежнюю одиночную попытку, когда кандидатов нет вовсе
// (первое письмо от незнакомца), (4) не свестись снова к одному ключу.
export default {
  id: 'rust-listen-decrypt',
  crate: 'vault-client',
  kind: 'all',
  file: 'vault-client/src/listen.rs',
  smoke: 'cargo test -p vault-client',
  mutations: [
    { name: 'перебор сведён к первому кандидату (дефект дословно: ключ из-под другого адреса не пробуется)',
      pattern: '    for k in candidates {',
      replacement: '    for k in candidates.iter().take(1) {' },
    { name: 'диагноз «чужой адрес» инвертирован (шум на каждое обычное письмо и молчание на настоящем случае)',
      pattern: '                if !vault_core::identity::same_address(k.address, sender) {',
      replacement: '                if vault_core::identity::same_address(k.address, sender) {' },
    { name: 'в диагноз пишется адрес отправителя вместо адреса подошедшего ключа (лечить становится нечем)',
      pattern: '                    out.foreign_key_address = Some(k.address.to_string());',
      replacement: '                    out.foreign_key_address = Some(sender.to_string());' },
    { name: 'расшифрованное не-письмо не останавливает перебор (вину получает следующий ключ: «AAD» вместо «не наш формат»)',
      pattern: '            Ok(None) => return out,',
      replacement: '            Ok(None) => {}' },
    { name: 'попытка при пустой книге убрана (первому письму от незнакомца неоткуда расшифроваться)',
      pattern: '    if candidates.is_empty() {',
      replacement: '    if false {',
    },
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
