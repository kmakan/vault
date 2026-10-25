// Набор мутаций: rust-crypto-pq — гибрид PQ-V1 (ML-KEM-768 + X25519).
//
// ЗАЧЕМ. Соль, домен info, порядок ikm, каноническая сортировка pub-ключей и
// длины wire-формата — это протокол, а не реализация. Обе стороны считают
// ОДНОЙ константой, поэтому round-trip остаётся зелёным при любом дрейфе
// домена, а уже отправленные конверты молча перестают открываться.
// Векторы в `crypto_pq::tests` посчитаны независимо (HKDF-SHA256), поэтому
// набор ловит смену соли/домена, перестановку ног гибрида, инверсию
// сортировки, потерю whitespace-фильтра (SMTP fold) и дрейф длин.
export default {
  id: 'rust-crypto-pq',
  crate: 'vault-core',
  file: 'vault-core/src/crypto_pq.rs',
  smoke: 'cargo test -p vault-core --lib',
  mutations: [
    { name: 'соль гибридного KDF изменена (ключи расходятся со старыми конвертами)',
      pattern: 'pub const PQ_SALT: &[u8] = b"VAULT-PQ-V1";',
      replacement: 'pub const PQ_SALT: &[u8] = b"VAULT-PQ-V2";' },
    { name: 'домен info гибрида изменён (KAT расходится, round-trip зелёный)',
      pattern: '    info.extend_from_slice(b"VAULT-PQ-V1-hybrid");',
      replacement: '    info.extend_from_slice(b"VAULT-PQ-V2-hybrid");' },
    { name: 'порядок pub-ключей в info не канонизирован (стороны не сходятся)',
      pattern: '    let (first, second) = if my_pub <= peer_pub {',
      replacement: '    let (first, second) = if my_pub > peer_pub {' },
    // Порядок ног в ikm решается ДВУМЯ KDF: чатовым (`hybrid_key`) и медиа
    // (`media_hybrid_kdf`). Строка-паттерн без контекста матчила только
    // первую, и медиа-ключ жил без проверки (t_e1dbc7c7, 25.10).
    { name: 'чат: X25519-секрет выброшен из ikm (гибрид деградировал до ML-KEM)',
      pattern: '    ikm.extend_from_slice(x25519_ss);\n    ikm.extend_from_slice(mlkem_ss);\n    let mut info = Vec::with_capacity(64);',
      replacement: '    ikm.extend_from_slice(mlkem_ss);\n    ikm.extend_from_slice(mlkem_ss);\n    let mut info = Vec::with_capacity(64);' },
    { name: 'чат: ML-KEM-секрет выброшен из ikm (гибрид деградировал до X25519)',
      pattern: '    ikm.extend_from_slice(mlkem_ss);\n    let mut info = Vec::with_capacity(64);',
      replacement: '    ikm.extend_from_slice(x25519_ss);\n    let mut info = Vec::with_capacity(64);' },
    { name: 'медиа: X25519-секрет выброшен из ikm (звонковый ключ = ML-KEM)',
      pattern: '    ikm.extend_from_slice(x25519_ss);\n    ikm.extend_from_slice(mlkem_ss);\n    let hk = Hkdf::<Sha256>::new(Some(PQ_SALT), &ikm);',
      replacement: '    ikm.extend_from_slice(mlkem_ss);\n    ikm.extend_from_slice(mlkem_ss);\n    let hk = Hkdf::<Sha256>::new(Some(PQ_SALT), &ikm);' },
    { name: 'медиа: ML-KEM-секрет выброшен из ikm (звонковый ключ = X25519)',
      pattern: '    ikm.extend_from_slice(mlkem_ss);\n    let hk = Hkdf::<Sha256>::new(Some(PQ_SALT), &ikm);',
      replacement: '    ikm.extend_from_slice(x25519_ss);\n    let hk = Hkdf::<Sha256>::new(Some(PQ_SALT), &ikm);' },
    { name: 'домен медиа-ключа слит с чатовым (звонок и чат делят KDF)',
      pattern: '    hk.expand(b"VAULT-PQ-V1-media", &mut okm)',
      replacement: '    hk.expand(b"VAULT-PQ-V1-hybrid", &mut okm)' },
    // AAD пишут ДВА места — упаковка конверта и его чтение. Третье совпадение
    // той же строки было внутри теста (`test_hybrid_rejects_legacy_ciphertext`),
    // где оно подделывает legacy-письмо: правка его ничего не меняла в
    // проверке, и паттерн без контекста мог уйти туда.
    { name: 'чат: AAD упаковки изменён (свои письма не расшифровываются)',
      pattern: '                msg: plaintext.as_bytes(),\n                aad: b"VAULT",',
      replacement: '                msg: plaintext.as_bytes(),\n                aad: b"VAULT2",' },
    { name: 'чат: AAD чтения изменён (своё письмо считается чужим)',
      pattern: '                msg: ct_bytes,\n                aad: b"VAULT",',
      replacement: '                msg: ct_bytes,\n                aad: b"VAULT2",' },
    { name: 'длина ek изменена (валидный ключ контакта отвергается)',
      pattern: 'pub const PQ_EK_LEN: usize = 1184;',
      replacement: 'pub const PQ_EK_LEN: usize = 1183;' },
    { name: 'длина kemct изменена (wire-конверты не принимаются)',
      pattern: 'pub const PQ_CT_LEN: usize = 1088;',
      replacement: 'pub const PQ_CT_LEN: usize = 1087;' },
    { name: 'длина seed сверяется с неправильным числом (свой ключ не восстанавливается)',
      pattern: '    if seed_bytes.len() != PQ_SEED_LEN {',
      replacement: '    if seed_bytes.len() != PQ_SEED_LEN - 1 {' },
    // Фильтр пробелов живёт в ЧЕТЫРЁХ местах (ek, kemct медиа, kemct чата,
    // сам конверт). Один голый паттерн матчил первое из них: остальные
    // оставались без проверки, поэтому у каждого свой контекст.
    { name: 'whitespace в ek не удаляется (ключ из письма с переносами не парсится)',
      pattern: '        .filter(|c| !c.is_whitespace())\n        .collect();\n    let ek_bytes = base64::engine::general_purpose::STANDARD',
      replacement: '        .filter(|_| true)\n        .collect();\n    let ek_bytes = base64::engine::general_purpose::STANDARD' },
    { name: 'whitespace в чатовом kemct не удаляется (ответ на письмо с fold не собрать)',
      pattern: '    let kemct_clean: String = kemct_b64\n        .trim()\n        .chars()\n        .filter(|c| !c.is_whitespace())',
      replacement: '    let kemct_clean: String = kemct_b64\n        .trim()\n        .chars()\n        .filter(|_| true)' },
    { name: 'whitespace в медиа-kemct не удаляется (сигналинг с переносами ломается)',
      pattern: '    let cleaned: String = kemct_b64\n        .trim()\n        .chars()\n        .filter(|c| !c.is_whitespace())\n        .collect();',
      replacement: '    let cleaned: String = kemct_b64\n        .trim()\n        .chars()\n        .filter(|_| true)\n        .collect();' },
    { name: 'whitespace в конверте не удаляется (письмо с переносами не читается)',
      pattern: '    let cleaned: String = ciphertext.chars().filter(|c| !c.is_whitespace()).collect();',
      replacement: '    let cleaned: String = ciphertext.chars().filter(|_| true).collect();' },
    { name: 'проверка длины seed инвертирована (любой корректный seed отвергается)',
      pattern: '    if seed_bytes.len() != PQ_SEED_LEN {',
      replacement: '    if seed_bytes.len() == PQ_SEED_LEN {' },
    { name: 'проверка длины ek инвертирована (любой корректный ek отвергается)',
      pattern: '    if ek_bytes.len() != PQ_EK_LEN {',
      replacement: '    if ek_bytes.len() == PQ_EK_LEN {' },
    // Длина kemct сверяется ДВАЖДЫ: в медиа-пути и при чтении чатового
    // конверта. Голый паттерн брал первый.
    { name: 'проверка длины kemct инвертирована в медиа-пути (соединение не принимается)',
      pattern: '        .decode(&cleaned)\n        .map_err(|e| anyhow::anyhow!("Invalid kemct base64: {e}"))?;\n    if ct_bytes.len() != PQ_CT_LEN {',
      replacement: '        .decode(&cleaned)\n        .map_err(|e| anyhow::anyhow!("Invalid kemct base64: {e}"))?;\n    if ct_bytes.len() == PQ_CT_LEN {' },
    { name: 'проверка длины kemct инвертирована при чтении конверта (мусор принимается)',
      pattern: '        .decode(&kemct_clean)\n        .map_err(|e| anyhow::anyhow!("Invalid kemct base64: {e}"))?;\n    if ct_bytes.len() != PQ_CT_LEN {',
      replacement: '        .decode(&kemct_clean)\n        .map_err(|e| anyhow::anyhow!("Invalid kemct base64: {e}"))?;\n    if ct_bytes.len() == PQ_CT_LEN {' },
    { name: 'pq конверта не заполняется (получатель не может ответить гибридом)',
      pattern: '            pq: my_ek_b64,',
      replacement: '            pq: None,' },
    { name: 'в конверт кладётся обрезанный ek (контакт не сможет ответить гибридом)',
      pattern: '    let my_ek_b64 = base64::engine::general_purpose::STANDARD.encode(my_ek.to_bytes().as_slice());',
      replacement: '    let my_ek_b64 = base64::engine::general_purpose::STANDARD.encode(&my_ek.to_bytes().as_slice()[..32]);' },
    // X25519-нога передаётся в hybrid_key ДВАЖДЫ — при упаковке и при чтении;
    // голый паттерн брал первую, и «DH не участвует» во второй ветке никто не
    // проверял (25.10, t_e1dbc7c7).
    { name: 'X25519-нога упаковки подменена публичным ключом (DH не участвует)',
      pattern: '    // --- Hybrid key + encrypt ---\n    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");\n    let key = hybrid_key(\n        x25519_ss.as_bytes(),',
      replacement: '    // --- Hybrid key + encrypt ---\n    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");\n    let key = hybrid_key(\n        peer_pub.as_bytes(),' },
    { name: 'X25519-нога чтения подменена публичным ключом (ключ не сходится)',
      pattern: '    // отправителя) — None: info-связка выполняется my_pub+peer_pub.\n    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");\n    let key = hybrid_key(\n        x25519_ss.as_bytes(),',
      replacement: '    // отправителя) — None: info-связка выполняется my_pub+peer_pub.\n    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");\n    let key = hybrid_key(\n        peer_pub.as_bytes(),' },
  ],
};
