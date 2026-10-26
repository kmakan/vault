// Набор мутаций: rust-bridge-credential-store — почтовый пароль на диске.
//
// ЗАЧЕМ (t_043d6a21, слепая зона №2 density-гейта). 238 строк, 4 теста
// (roundtrip, пусто, удаление, чужой ключ), 0 закреплённых мутаций. Модуль
// держит пароль ящика: 32-байтный ключ устройства + XChaCha20-Poly1305, всё
// под 0600/0700. Цена ошибки — не «неудобно», а утечка пароля ящика или
// невозможность его прочитать после апдейта.
//
// Что меряется: свежесть nonce (повтор nonce при том же ключе превращает
// шифр поток-на-поток и сравнивает два снимка пароля), права файлов,
// отвержение ключа неверной длины, наличие зашифрованного текста в файле.
//
// ЧЕСТНАЯ ГРАНИЦА. Два места сюда НЕ включены намеренно:
//  * `hex::decode(hex_str.trim())` → без `.trim()`: мутант равнозначен, потому
//    что файл ключа пишется без завершающего перевода (`fs::write(&path,
//    hex::encode(key))`) — тест его не убьёт никогда;
//  * имя переменной редиректа `VAULT_CREDENTIALS_DIR`: мутация (переименование
//    или игнор) увела бы тесты в ЖИВОЙ `~/.vault/credentials` разработчика.
//    Проверять её ценой чужих данных нельзя, поэтому она закрыта порядком
//    тестов (`with_temp_dir` + единый замок крейта), а не набором.
export default {
  id: 'rust-bridge-credential-store',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/credential_store.rs',
  smoke: 'cargo test -p vault-desktop --lib',
  timeoutMs: 900_000,
  mutations: [
    // ── А. Nonce: каждый снимок должен получать свой ──
    { name: 'nonce не генерируется (обнулён): два сохранения одного пароля дают идентичный шифртекст',
      pattern: '    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);\n    let nonce = XNonce::from_slice(&nonce_bytes);',
      replacement: '    let nonce = XNonce::from_slice(&nonce_bytes);' },
    { name: 'nonce не дописывается в файл: расшифровать сохранённое невозможно',
      pattern: '    out.extend_from_slice(&nonce_bytes);\n    out.extend_from_slice(&ciphertext);',
      replacement: '    out.extend_from_slice(&ciphertext);' },
    { name: 'порядок nonce и шифртекста переставлен (читается мусор вместо пароля)',
      pattern: '    out.extend_from_slice(&nonce_bytes);\n    out.extend_from_slice(&ciphertext);',
      replacement: '    out.extend_from_slice(&ciphertext);\n    out.extend_from_slice(&nonce_bytes);' },
    { name: 'длина nonce взята из классического ChaCha20 (12 вместо 24): XChaCha20 принимает другой префикс',
      pattern: 'const NONCE_LEN: usize = 24;',
      replacement: 'const NONCE_LEN: usize = 12;' },
    // ── Б. Права доступа к ключу и паролю ──
    { name: 'ключ устройства 0644 вместо 0600: приватная часть читается всеми',
      pattern: '    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));',
      replacement: '    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));' },
    { name: 'каталог credentials 0755 вместо 0700: список файлов виден соседним процессам',
      pattern: '    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));',
      replacement: '    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));' },
    { name: 'права не выставляются после записи файла (остаётся режим из umask, обычно 0644)',
      pattern: '    fs::write(&path, encoded)?;\n    set_owner_only(&path);',
      replacement: '    fs::write(&path, encoded)?;' },
    // ── В. Ключ неверной длины и отсутствие файла ──
    { name: 'длина ключа не проверяется: copy_from_slice на обрезанном ключе = паника вместо ошибки',
      pattern: '        if bytes.len() != 32 {',
      replacement: '        if bytes.len() > 64 {' },
    { name: 'отсутствие файла пароля читается как повреждённые данные (вход падает вместо «пусто»)',
      pattern: '    if !path.exists() {\n        return Ok(None);\n    }',
      replacement: '    if path.is_dir() {\n        return Ok(None);\n    }' },
    // ── Г. Удаление ──
    { name: 'удаление сообщает, что ничего не удалило (UI не показывает факт стирания пароля)',
      pattern: '        fs::remove_file(&path)?;\n        return Ok(true);',
      replacement: '        fs::remove_file(&path)?;\n        return Ok(false);' },
  ],
};
