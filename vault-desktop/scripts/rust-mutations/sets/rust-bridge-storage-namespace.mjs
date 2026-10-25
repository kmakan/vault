// Набор мутаций: rust-bridge-storage-namespace — чьё пространство имён в базе.
//
// ЗАЧЕМ. Одна база на несколько аккаунтов: каждая account-таблица (kv_store,
// chat_history, body_cache, tombstones, imap_cursors, emails) фильтрует строки
// по колонке `account`. Значение этой колонки — решение, а не данные: перепутать
// `fp:<fp>` с email или сдвинуть строки глобального namespace в пользовательский
// значит либо потерять историю при смене ключа, либо утащить чужие/системные
// записи. Тесты здесь есть (13 штук в storage/sqlite.rs), но до этого набора ни
// одно из этих решений мутациями не мерилось.
//
// Форма значения (trim + нижний регистр по Юникоду) живёт в ядре
// (`identity::normalize`), а решение «КОГДА fp, а когда email» и список
// глобальных имён — в мосту: мутируем именно их.
export default {
  id: 'rust-bridge-storage-namespace',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/storage/sqlite.rs',
  smoke: 'cargo test -p vault-desktop --lib',
  timeoutMs: 1_200_000,
  mutations: [
    { name: 'fp всегда считается загруженным (пустой ключ → пустой namespace вместо email)',
      pattern: '        if fp.is_empty() {',
      replacement: '        if false {' },
    { name: 'fp никогда не считается загруженным (идентичность = почта, вход с другим адресом видит пустоту)',
      pattern: '        if fp.is_empty() {',
      replacement: '        if true {' },
    { name: 'префикс fp: потерян (тот же ключ живёт под сырым hash и не сходится с миграцией)',
      pattern: '        Ok(format!("fp:{}", fp))',
      replacement: '        Ok(fp)' },
    { name: 'fp не нормализуется (заглавные/пробелы в ключе = второе пустое пространство)',
      pattern: '        let fp = identity::normalize(&fp);',
      replacement: '        let fp = fp;' },
    { name: 'email-фолбэк не нормализуется (Иван@Почта.РФ и иван@почта.рф — два аккаунта)',
      pattern: '            return Ok(identity::normalize(&email));',
      replacement: '            return Ok(email);' },
    { name: 'глобальный anon переносится в fp (настройки приложения уезжают в чужой namespace)',
      pattern: '        let is_global = |a: &str| a.is_empty() || a == "anon" || a == "local";',
      replacement: '        let is_global = |a: &str| a.is_empty() || a == "local";' },
    { name: 'глобальный local переносится в fp (курсоры и конверты IMAP-транспорта уезжают из транспорта)',
      pattern: '        let is_global = |a: &str| a.is_empty() || a == "anon" || a == "local";',
      replacement: '        let is_global = |a: &str| a.is_empty() || a == "anon";' },
    { name: 'пустой namespace считается обычным (BEGIN IMMEDIATE и перенос строк на пустой account)',
      pattern: '        let is_global = |a: &str| a.is_empty() || a == "anon" || a == "local";',
      replacement: '        let is_global = |a: &str| a == "anon" || a == "local";' },
    { name: 'перенос «на себя» не считается no-op (отчёт враньё, транзакция на живой аккаунт)',
      pattern: '        if is_global(&old_account) || is_global(&new_account) || old_account == new_account {',
      replacement: '        if is_global(&old_account) || is_global(&new_account) {' },
  ],
};
