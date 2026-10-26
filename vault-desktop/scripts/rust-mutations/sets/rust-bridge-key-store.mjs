// Набор мутаций: rust-bridge-key-store — хранилище ключей в мосте.
//
// ЗАЧЕМ (t_043d6a21, слепая зона №1 из списка density-гейта). Модуль
// `src-tauri/src/key_store.rs` — 777 строк, 12 тестов, НИ ОДНОЙ закреплённой
// мутации. Ядро (`vault-core/src/key_store.rs`) меряется набором
// `rust-key-store`, но мост — это НЕ ядро: здесь права доступа к файлам,
// адрес каталога ключей, захват guard'а и два стража поверх ядровой записи.
// Именно эти решения теряются молча: тесты модуля проверяют содержимое
// записей, а не то, кем и где они лежат.
//
// Цена ошибки здесь — потеря переписки: каталог с другим именем пустой,
// ключ подписи канала не найден, файл ключей читается соседними процессами.
//
// ЧЕСТНАЯ ГРАНИЦА. Внутренняя работа guard'а не наблюдима с хоста и сюда НЕ
// включена: reentrant-`depth` (значение нигде не ветвится), очистка `owner`
// при Drop (после unlock сменщик перезаписывает её сам), ожидание на condvar
// (мутация = зависание всего прогона `--lib`, а не провал проверки). Их
// проверяют компиляция android-таргета и приёмка на телефоне. Молчание
// дешевле ложной зелёной проверки.
export default {
  id: 'rust-bridge-key-store',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/key_store.rs',
  smoke: 'cargo test -p vault-desktop --lib',
  timeoutMs: 900_000,
  mutations: [
    // ── А. Права доступа: ключи должны быть видны только владельцу ──
    { name: 'файл блокировки читается всеми (0666): соседний процесс видит, когда идёт запись',
      pattern: 'let _ = fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600));',
      replacement: 'let _ = fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o666));' },
    { name: 'каталог ключей 0755 вместо 0700: имена и размер ключевых файлов читаются всеми',
      pattern: 'let _ = fs::set_permissions(keys_dir, fs::Permissions::from_mode(0o700));',
      replacement: 'let _ = fs::set_permissions(keys_dir, fs::Permissions::from_mode(0o755));' },
    { name: 'файл ключей 0644 вместо 0600: приватная часть читается группой и всеми',
      pattern: 'let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));',
      replacement: 'let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));' },
    { name: 'права не выставляются вовсе (остаётся режим из umask, обычно 0644)',
      pattern: '    fs::write(path, bytes)?;\n    #[cfg(unix)]',
      replacement: '    fs::write(path, bytes)?;\n    #[cfg(windows)]' },
    // ── Б. Адрес каталога: две копии резолва (get_keys_dir и RAW) ──
    { name: 'имя каталога ключей изменено: у существующей установки ключей нет',
      pattern: 'const KEYS_DIR: &str = "keys";',
      replacement: 'const KEYS_DIR: &str = "keystore";' },
    { name: 'слой .vault пропущен: guard-путь указывает прямо в home',
      pattern: '    Ok(home.join(".vault").join(KEYS_DIR))',
      replacement: '    Ok(home.join(KEYS_DIR))' },
    { name: 'слой .vault пропущен в RAW-резолве: импорт ищет ключи не там',
      pattern: '        Some(home) => home.join(".vault").join(KEYS_DIR),',
      replacement: '        Some(home) => home.join(KEYS_DIR),' },
    { name: 'тестовый redirect проверяется вторым: чужой VAULT_KEYS_DIR уводит запись в живые ключи',
      pattern: '    if let Ok(p) = std::env::var("VAULT_TEST_KEYS_DIR") {\n        return Ok(PathBuf::from(p));\n    }\n    // Tests (and power users) can redirect the storage dir; keeps the real\n    // `~/.vault/keys` untouched.\n    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {\n        return Ok(PathBuf::from(p));\n    }',
      replacement: '    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {\n        return Ok(PathBuf::from(p));\n    }\n    if let Ok(p) = std::env::var("VAULT_TEST_KEYS_DIR") {\n        return Ok(PathBuf::from(p));\n    }' },
    // ── В. Fail-closed: повреждённый журнал блокирует запись ──
    { name: 'ошибка восстановления журнала не блокирует запись (keypair пишется поверх незавершённого импорта)',
      pattern: '            drop(st);\n            GUARD_CV.notify_all();\n            return Err(e);',
      replacement: '            drop(st);\n            GUARD_CV.notify_all();\n            return Ok(Self { lock_file: Some(lock_file), reentrant: false });' },
    // ── Г. Стражи над ядровой записью (OWN-ADDRESS GUARD) ──
    { name: 'алиасы своего ключа собраны по адресу вместо публичного ключа (чужие записи стали «своими»)',
      pattern: '            .filter(|p| identity::same_public_key(&p.public_key, &kp.public_key))',
      replacement: '            .filter(|p| identity::same_address(&p.email, &kp.public_key))' },
    { name: 'страж перевёрнут: чужой адрес отбрасывается как свой, свой — записывается',
      pattern: '        if id.has_address(&key.email) {',
      replacement: '        if !id.has_address(&key.email) {' },
    { name: 'адрес аккаунта не участвует в страже (знает его только фронт — мост слеп)',
      pattern: '        let id = Identity::new(&own_email.unwrap_or_default(), &aliases, "");',
      replacement: '        let id = Identity::new("", &aliases, "");' },
    // ── Д. Ключ подписи канала (ADR-002) ──
    { name: 'файл ключа подписи переименован: у существующего владельца ключ потерян',
      pattern: 'const CHANNEL_SIGNING_FILE: &str = "channel_signing.json";',
      replacement: 'const CHANNEL_SIGNING_FILE: &str = "channel-signing.json";' },
    { name: 'duress-wipe не стирает ключ подписи канала (сброшенный владелец продолжает подписывать посты)',
      pattern: '    let _ = fs::remove_file(dir.join(CHANNEL_SIGNING_FILE));',
      replacement: '    let _ = &CHANNEL_SIGNING_FILE;' },
  ],
};
