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
    { name: 'версия конверта не закрепляется (1 не значит)',
      pattern: '                version: "1".to_string(),',
      replacement: '                version: "2".to_string(),' },
  ],
};
