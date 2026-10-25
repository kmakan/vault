// Набор мутаций: конверт сообщения (Rust-ядро, X-header формат).
//
// Формат (НЕ транспорт shipping-приложения — отдельный, X-header вариант):
//   X-Vault-Encrypted: 1
//   X-Vault-Type: …
//   X-Vault-ID: …
//   X-Vault-From: …
//   X-Vault-Reply-To: …
//   (пустая строка)
//   envelope_json
//   encrypted_payload
//
// Проверяем, что разбор/сборка держат ФОРМАТ: заголовки пишутся, разделитель
// «пустая строка» обязателен, payload берётся ЦЕЛИКОМ (в нём бывают переводы
// строк — брать первую строку значит потерять половину шифротекста).
export default {
  id: 'protocol',
  file: 'vault-client/src/vault/protocol.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'разделитель «пустая строка» не обязателен (формат разъезжается)',
      pattern: '        let (_, rest) = body.split_once("\\n\\n")?;',
      replacement: '        let (_, rest) = body.split_once("\\n").unwrap_or(("", body));' },
    // split_once делит ОДИН раз: остаток после первого перевода строки — это
    // ВЕСЬ payload (в нём бывают переводы строк). Поэтому ломать надо не
    // «вторую строку», а ОТСУТСТВИЕ payload: конверт без шифротекста.
    { name: 'конверт без payload принимается (расшифровывать нечего)',
      pattern: '        let (envelope_json, encrypted_payload) = rest.split_once(\'\\n\')?;',
      replacement: '        let (envelope_json, encrypted_payload) = rest.split_once(\'\\n\').unwrap_or((rest, ""));' },
    { name: 'заголовок типа не пишется (получатель не знает, что это)',
      pattern: '            self.envelope.msg_type.as_str(),',
      replacement: '            "",' },
    { name: 'заголовок ID не пишется (дедуп по Message-ID сломан)',
      pattern: '            self.envelope.message_id,',
      replacement: '            "",' },
    { name: 'заголовок отправителя не пишется (кто прислал — неизвестно)',
      pattern: '            self.envelope.from,',
      replacement: '            "",' },
    { name: 'маркер шифрования не пишется (письмо не распознается как наше)',
      pattern: '            "X-Vault-Encrypted: 1\\nX-Vault-Type: {}\\nX-Vault-ID: {}\\nX-Vault-From: {}\\nX-Vault-Reply-To: {}\\n\\n{}\\n{}",',
      replacement: '            "X-Vault-Type: {}\\nX-Vault-ID: {}\\nX-Vault-From: {}\\nX-Vault-Reply-To: {}\\n\\n{}\\n{}",' },
    // Версия конверта пишется в ТРЁХ конструкторах (new / reply / receipt).
    // Одна общая строка-паттерн ловила только первый из них: `src.replace`
    // берёт первое совпадение, а тестов на версию у reply и receipt не было
    // (добавлены 25.10 рядом с разделкой паттернов — t_e1dbc7c7). Поэтому
    // каждый конструктор называется своим паттерном со своим контекстом.
    { name: 'версия не закреплена в new (1 не значит)',
      pattern: '                version: "1".to_string(),\n                msg_type: VaultMsgType::Message,\n                from: from.to_string(),\n                to: to.to_string(),\n                message_id: message_id.to_string(),\n                in_reply_to: None,',
      replacement: '                version: "2".to_string(),\n                msg_type: VaultMsgType::Message,\n                from: from.to_string(),\n                to: to.to_string(),\n                message_id: message_id.to_string(),\n                in_reply_to: None,' },
    { name: 'версия не закреплена в reply (ответ уезжает другим протоколом)',
      pattern: '                version: "1".to_string(),\n                msg_type: VaultMsgType::Message,\n                from: from.to_string(),\n                to: to.to_string(),\n                message_id: message_id.to_string(),\n                in_reply_to: Some(reply_to.to_string()),',
      replacement: '                version: "2".to_string(),\n                msg_type: VaultMsgType::Message,\n                from: from.to_string(),\n                to: to.to_string(),\n                message_id: message_id.to_string(),\n                in_reply_to: Some(reply_to.to_string()),' },
    { name: 'версия не закреплена в receipt (квитанция читается другим парсером)',
      pattern: '                version: "1".to_string(),\n                msg_type: VaultMsgType::Receipt,',
      replacement: '                version: "2".to_string(),\n                msg_type: VaultMsgType::Receipt,' },
  ],
};
