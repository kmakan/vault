// Набор мутаций: крипто-обёртка конверта (Rust-ядро).
//
// Формат конверта: заголовок (Version/Type/Filename/Content-Type) + base64
// payload (nonce || ciphertext || ephemeral key) + подпись Ed25519 от payload.
// Проверяем, что тесты действительно держат КАЖДЫЙ элемент: убрав подпись
// или подменив ключ, конверт перестаёт быть проверяемым/расшифровываемым —
// и получатель должен узнать об этом, а не принять «пустоту».
//
// ПРИМЕЧАНИЕ. Мутация «проверка длины payload ослаблена» УБРАНА как
// эквивалентная: подпись проверяется РАНЬШЕ длины, а подпись покрывает
// payload — значит, обрезанный payload всегда отвергается по подписи, и
// длина недостижима для валидного конверта (код мёртвый, но не «дырявый»).
export default {
  id: 'encryptor',
  file: 'vault-client/src/crypto/encryptor.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'подпись не пишется в конверт (получатель не проверит целостность)',
      pattern: '        output.push_str(&signature_b64);',
      replacement: '        output.push_str("");' },
    { name: 'эпизодический ключ в payload заменён на нули (расшифровать нечем)',
      pattern: '        payload.extend_from_slice(&enc_key);',
      replacement: '        payload.extend_from_slice(&[0u8; 32]);' },
    { name: 'nonce в payload заменён на нули (тот же ключ даст тот же шифротекст)',
      pattern: '        payload.extend_from_slice(&nonce_bytes);',
      replacement: '        payload.extend_from_slice(&[0u8; NONCE_LEN]);' },
    { name: 'тип данных не указывается в заголовке (файл приходит как текст)',
      pattern: '                header.push_str("Type: text\\n");',
      replacement: '                header.push_str("Type: unknown\\n");' },
    { name: 'имя файла не указывается (вложение приходит без имени)',
      pattern: '                header.push_str(&format!("Filename: {}\\n", filename));',
      replacement: '                header.push_str("Filename: \\n");' },
    { name: 'признак конверта не проверяется (любой текст считается конвертом)',
      pattern: '    input.contains("---BEGIN VAULT ENCRYPTED---") && input.contains("---END VAULT ENCRYPTED---")',
      replacement: '    true' },
    { name: 'заголовок не отделяется от полезной нагрузки (парсер не разберёт)',
      pattern: '        output.push_str("---\\n");',
      replacement: '        output.push_str("\\n");' },
    { name: 'проверка подписи отключена (подделанный конверт принимается)',
      pattern: '        verifying_key\n            .verify(&payload, &signature)\n            .context("Signature verification failed — wrong key or tampered data")?;',
      replacement: '        let _ = (verifying_key, &payload, &signature);' },
  ],
};
