// Набор мутаций: rust-bridge-crypto-mail — форма письма в мосту.
//
// ЗАЧЕМ. crypto.rs — вторая (и третья, и четвёртая) копия одного и того же
// протокола: base64(nonce‖ciphertext) со стелс-меткой AAD="VAULT", 24-байтный
// nonce, симметричный групповой ключ, DH-ключ собеседника либо самошифровка.
// Тело письма приходит не из памяти, а из SMTP/IMAP: переносы по 76 колонок и
// съеденный decode_quoted_printable пэйдинг лечит ОДНА функция —
// b64_decode_mail, и до этого набора её не мерил никто (roundtrip-тесты
// подавали тело целиком). Приём «наше это письмо или нет» — решение
// безопасности: ошиблась одна копия → переписка либо читается чужим, либо
// перестаёт читаться вовсе.
//
// Мутируем сами решения: длина nonce как точка разбиения, очистка и
// восстановление base64, проверка длины перед split_at, длина ключа, литерал
// метки на каждой из четырёх сторон, порядок legacy-фолбэка и выбор ключа
// (DH против самошифровки) на vault-пути.
//
// Что осталось неизмеримым осознанно: `derive_key` (фиксированный префикс
// «vault-self-encryption-v1») и литерал метки, изменённый НА ОБЕИХ сторонах
// сразу — roundtrip не замечает, нужно сравнение с неподвижной фикстурой
// ядра (M0), а не с собственным шифром.
export default {
  id: 'rust-bridge-crypto-mail',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/crypto.rs',
  smoke: 'cargo test -p vault-desktop --lib crypto',
  timeoutMs: 600_000,
  mutations: [
    { name: 'длина nonce сдвинута — точка разбиения письма больше не формат',
      pattern: 'pub const NONCE_LEN: usize = 24;',
      replacement: 'pub const NONCE_LEN: usize = 16;' },
    { name: 'переносы SMTP не вычищаются (76 колонок = мусор в base64, письмо не читается)',
      pattern: '    let mut cleaned: String = ciphertext.chars().filter(|c| !c.is_whitespace()).collect();',
      replacement: '    let mut cleaned: String = ciphertext.to_string();' },
    { name: 'пэйдинг не восстанавливается (потеря «==» транспортом = ошибка декодера)',
      pattern: '    if rem != 0 {',
      replacement: '    if false {' },
    { name: 'пэйдинг дописывается к каждому телу (валидное становится кратным 4 + 4)',
      pattern: '    if rem != 0 {',
      replacement: '    if true {' },
    { name: 'вместо «=» дописывается посторонний символ (декодер отворачивает письмо)',
      pattern: '        cleaned.push_str(&"=".repeat(4 - rem));',
      replacement: '        cleaned.push_str(&"x".repeat(4 - rem));' },
    { name: 'дописывается четыре символа, а не недостающее (хвост тела уезжает)',
      pattern: '        cleaned.push_str(&"=".repeat(4 - rem));',
      replacement: '        cleaned.push_str(&"=".repeat(4));' },
    { name: 'личное письмо короче nonce не отвергается — split_at паникует',
      pattern: ') -> anyhow::Result<String> {\n    let decoded = b64_decode_mail(ciphertext)?;\n\n    if decoded.len() < NONCE_LEN {',
      replacement: ') -> anyhow::Result<String> {\n    let decoded = b64_decode_mail(ciphertext)?;\n\n    if false {' },
    { name: 'стельс-письмо короче nonce не отвергается — split_at паникует',
      pattern: '    // Пробелы/переносы SMTP + восстановление пэйдинга — см. b64_decode_mail.\n    let decoded = b64_decode_mail(ciphertext)?;\n\n    if decoded.len() < NONCE_LEN {',
      replacement: '    // Пробелы/переносы SMTP + восстановление пэйдинга — см. b64_decode_mail.\n    let decoded = b64_decode_mail(ciphertext)?;\n\n    if false {' },
    { name: 'групповое письмо короче nonce не отвергается — split_at паникует',
      pattern: '    let decoded = b64_decode_mail(ciphertext)?;\n\n    if decoded.len() < NONCE_LEN {\n        anyhow::bail!("Ciphertext too short");\n    }\n\n    let key_bytes = hex::decode(key_hex)',
      replacement: '    let decoded = b64_decode_mail(ciphertext)?;\n\n    if false {\n        anyhow::bail!("Ciphertext too short");\n    }\n\n    let key_bytes = hex::decode(key_hex)' },
    { name: 'короткий групповой ключ прошёл на расшифровке (copy_from_slice паникует вместо ошибки)',
      pattern: '    if key_bytes.len() != 32 {\n        anyhow::bail!("Group key must be 32 bytes");\n    }\n    let mut key_arr = [0u8; 32];\n    key_arr.copy_from_slice(&key_bytes);\n\n    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);',
      replacement: '    if false {\n        anyhow::bail!("Group key must be 32 bytes");\n    }\n    let mut key_arr = [0u8; 32];\n    key_arr.copy_from_slice(&key_bytes);\n\n    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);' },
    { name: 'короткий групповой ключ прошёл на шифровке (мусорное письмо вместо ошибки)',
      pattern: 'pub fn encrypt_symmetric_cmd(plaintext: &str, key_hex: &str) -> anyhow::Result<String> {\n    let key_bytes = hex::decode(key_hex).map_err(|e| anyhow::anyhow!("Invalid key hex: {}", e))?;\n    if key_bytes.len() != 32 {',
      replacement: 'pub fn encrypt_symmetric_cmd(plaintext: &str, key_hex: &str) -> anyhow::Result<String> {\n    let key_bytes = hex::decode(key_hex).map_err(|e| anyhow::anyhow!("Invalid key hex: {}", e))?;\n    if false {' },
    { name: 'метка на шифровке 1-на-1 смещена — письма перестают узнаваться',
      pattern: '        msg: plaintext.as_bytes(),\n        aad: b"VAULT",\n    };\n    let ciphertext = cipher\n        .encrypt(nonce, payload)\n        .map_err(|e| anyhow::anyhow!("Vault encryption failed: {}", e))?;',
      replacement: '        msg: plaintext.as_bytes(),\n        aad: b"VAULT!",\n    };\n    let ciphertext = cipher\n        .encrypt(nonce, payload)\n        .map_err(|e| anyhow::anyhow!("Vault encryption failed: {}", e))?;' },
    { name: 'метка на приёме 1-на-1 смещена — входящие становятся нечитаемыми',
      pattern: '        msg: ciphertext_bytes,\n        aad: b"VAULT",',
      replacement: '        msg: ciphertext_bytes,\n        aad: b"VAULT!",' },
    { name: 'метка на групповой шифровке смещена — группа расшифровать не может',
      pattern: '        msg: plaintext.as_bytes(),\n        aad: b"VAULT",\n    };\n    let ciphertext = cipher\n        .encrypt(nonce, payload)\n        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;',
      replacement: '        msg: plaintext.as_bytes(),\n        aad: b"VAULT!",\n    };\n    let ciphertext = cipher\n        .encrypt(nonce, payload)\n        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;' },
    { name: 'метка на групповом приёме смещена — текущие письма уходят в legacy-ветку',
      pattern: '            msg: ciphertext_bytes,\n            aad: b"VAULT",',
      replacement: '            msg: ciphertext_bytes,\n            aad: b"VAULT!",' },
    { name: 'приём 1-на-1 узнаёт письмо без метки — «наше» определяется длиной тела',
      pattern: '    let plaintext = cipher\n        .decrypt(nonce, payload)\n        .map_err(|_| anyhow::anyhow!("Not a vault message (AAD auth failed) or wrong key"))?;',
      replacement: '    let plaintext = cipher\n        .decrypt(nonce, ciphertext_bytes)\n        .map_err(|_| anyhow::anyhow!("Not a vault message (AAD auth failed) or wrong key"))?;' },
    { name: 'legacy-группа (до метки) больше не читается — фолбэк снят',
      pattern: '        Err(_) => cipher\n            .decrypt(nonce, ciphertext_bytes)\n            .map_err(|_| anyhow::anyhow!("Decryption failed (wrong key or corrupted data)"))?,',
      replacement: '        Err(_) => anyhow::bail!("Decryption failed"),' },
    { name: 'ключ 1-на-1 на шифровке берётся из своего ключа, а не из DH — письмо не долетает',
      pattern: '            *shared.as_bytes()\n        }\n        None => derive_key(&public),\n    };\n\n    let cipher = XChaCha20Poly1305::new((&key).into());\n    let nonce_bytes: [u8; NONCE_LEN] = rand::random();\n    let nonce = XNonce::from_slice(&nonce_bytes);\n\n    let payload = Payload {',
      replacement: '            derive_key(&public)\n        }\n        None => derive_key(&public),\n    };\n\n    let cipher = XChaCha20Poly1305::new((&key).into());\n    let nonce_bytes: [u8; NONCE_LEN] = rand::random();\n    let nonce = XNonce::from_slice(&nonce_bytes);\n\n    let payload = Payload {' },
    { name: 'ключ 1-на-1 на приёме берётся из своего ключа, а не из DH — письмо не читается',
      pattern: '            *shared.as_bytes()\n        }\n        None => derive_key(&public),\n    };\n\n    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);\n    let cipher = XChaCha20Poly1305::new((&key).into());\n    let nonce = XNonce::from_slice(nonce_bytes);\n\n    let payload = Payload {',
      replacement: '            derive_key(&public)\n        }\n        None => derive_key(&public),\n    };\n\n    let (nonce_bytes, ciphertext_bytes) = decoded.split_at(NONCE_LEN);\n    let cipher = XChaCha20Poly1305::new((&key).into());\n    let nonce = XNonce::from_slice(nonce_bytes);\n\n    let payload = Payload {' },
  ],
};
