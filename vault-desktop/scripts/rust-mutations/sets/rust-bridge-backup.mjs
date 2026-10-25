// Набор мутаций: путь восстановления из backup (src-tauri/src/backup_import.rs
// + backup_import/ops.rs) — разбор, писатель и валидация журнала.
//
// ЗАЧЕМ. Backup — единственная вещь, которая стоит аккаунта целиком: ключи и
// всё локальное состояние. До этой волны в модуле было 35 тестов движка
// (атомарность, rollback, маркер коммита) и ни одной мутационной мерки, а
// писатель (`export_backup`) не был измерен НИЧЕМ — то есть «экспорт делает
// файл, который импорт не читает» был сценарием без проверки.
//
// Что показал сам процесс (зафиксировано в журнале 25.10):
//  * правила разбора были сгруппированы — один тест «битый peer» валил три
//    правила сразу, поэтому снятие ЛЮБОГО из них оставляло тест зелёным;
//  * писатель тихо проглатывал неразобранные ключи (`unwrap_or({})`):
//    пользователь получал backup без ключей, и видно это только тогда, когда
//    старое устройство уже стёрто. Мутант, возвращающий это поведение, ловится
//    `writer_rejects_unparseable_keys`;
//  * псевдоним поля `kv` в читателе скрывает переименование `kv_store` в
//    писателе — поэтому round-trip сверяет ИМЯ поля, а не только смысл.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (проверено чтением кода, 25.10):
//   * `if !is_valid_txid(&m.txid) ||` в read_manifest — второй член того же
//     условия (`m.txid != txid`) отлавливает любой невалидный txid раньше, и
//     вызов сюда недостижим изолированно (каталог с невалидным именем не
//     считается журналом). Это defense-in-depth: тест, который его «мерил»,
//     был бы вакуумным. Само ПРАВИЛО (форма txid) меряется мутантами тела
//     `is_valid_txid` и site'ом в find_active_journal;
//   * проверка `is_symlink` в read_target — эквивалентный мутант: сразу за
//     ней идёт `!meta.is_file()` на ТОМ ЖЕ symlink_metadata, и symlink — не
//     regular file, так что отказ происходит и без неё. Мутант «снять первую
//     проверку» зелёный по причине, а не из-за дыры в тестах;
//   * `TxMode`/сериализация манифеста — мутанты «поменять строку режима»
//     падают у serde (поймал десериализатор, не тест);
//   * права 0600/0700 и fsync — наблюдаются только на чужой ФС/при падении
//     процесса, без инъекции не измеряются.
export default {
  id: 'rust-bridge-backup',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/backup_import.rs',
  smoke: 'cargo test -p vault-desktop --lib backup_import',
  timeoutMs: 600_000,
  mutations: [
    // ── разбор: версия и состав backup ──
    { name: 'единственной принятой версией стала 2 (письмо пишет 1 — импорт отказывает)',
      pattern: '            Some(1) => {}',
      replacement: '            Some(2) => {}' },
    { name: 'любая версия принята (backup неизвестного формата восстанавливается как знакомый)',
      pattern: '            Some(1) => {}\n            _ => bail!(ERR_UNSUPPORTED_VERSION),',
      replacement: '            _ => {}' },
    { name: 'псевдоним поля kv снят (старые backup\'ы читаются как «нет состояния»)',
      pattern: '    let kv = match obj.get("kv_store").or_else(|| obj.get("kv")) {',
      replacement: '    let kv = match obj.get("kv_store") {' },
    { name: 'основное имя KV-поля перестало быть основным (экспорт этого приложения не читается)',
      pattern: '    let kv = match obj.get("kv_store").or_else(|| obj.get("kv")) {',
      replacement: '    let kv = match obj.get("kv") {' },
    { name: 'keypair больше не считается содержимым (backup только с ключами — «нечего восстанавливать»)',
      pattern: '            keypair: Some(_), ..\n        }) => true,',
      replacement: '            keypair: Some(_), ..\n        }) => false,' },
    { name: 'peers больше не считаются содержимым (backup контактов отклоняется как пустой)',
      pattern: '        Some(ParsedKeys { peers: Some(_), .. }) => true,',
      replacement: '        Some(ParsedKeys { peers: Some(_), .. }) => false,' },
    { name: 'KV больше не считается содержимым (backup без ключей отклонён как пустой)',
      pattern: '    } || kv.is_some();',
      replacement: '    };' },

    // ── разбор: форма ключевой пары ──
    { name: 'приватный ключ не проверяется на форму (битый PQ/X25519 уезжает на диск)',
      pattern: '    if !is_hex64(&kp.public_key) || !is_hex64(&kp.private_key) {',
      replacement: '    if !is_hex64(&kp.public_key) {' },
    { name: 'публичный ключ не проверяется на форму (половинка пары молча невалидна)',
      pattern: '    if !is_hex64(&kp.public_key) || !is_hex64(&kp.private_key) {',
      replacement: '    if !is_hex64(&kp.private_key) {' },
    { name: 'совпадение pub и priv больше не дефект (Self-guard в backup исчез)',
      pattern: '    if kp.public_key == kp.private_key {',
      replacement: '    if false {' },
    { name: 'пустой created_at принят (дата рождения ключа потеряна без ошибки)',
      pattern: '    if kp.created_at.trim().is_empty() {',
      replacement: '    if false {' },
    { name: 'длина ключа перестала быть проверкой (63 символа = «ключ»)',
      pattern: '    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())' },
    { name: 'алфавит ключа перестал быть проверкой (не-hex символы проходят)',
      pattern: '    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '    s.len() == 64' },
    { name: 'hex обязан нижним регистром (uppercase-ключи из CLI отклоняются)',
      pattern: '    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '    s.len() == 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())' },

    // ── разбор: peers ──
    { name: 'пустой email peer\'а принят (контакт без адреса = ключ никто не найдёт)',
      pattern: '        if peer.email.trim().is_empty() {',
      replacement: '        if false {' },
    { name: 'пустой added_at peer\'а принят (метка времени контакта потеряна)',
      pattern: '        if peer.added_at.trim().is_empty() {',
      replacement: '        if false {' },
    { name: 'форма адреса взята ascii-нижним регистром (кириллический дубль не познан)',
      pattern: '        let norm = vault_client::vault::identity::normalize(&peer.email);',
      replacement: '        let norm = peer.email.to_ascii_lowercase();' },
    { name: 'форма адреса не нормализуется вовсе (дубль с обрамлением = два контакта)',
      pattern: '        let norm = vault_client::vault::identity::normalize(&peer.email);',
      replacement: '        let norm = peer.email.clone();' },
    { name: 'дедуп peer\'ов по адресу снят (в backup два ключа одного адреса)',
      pattern: '        if !seen_emails.insert(norm) {',
      replacement: '        if false {' },

    // ── разбор: KV ──
    { name: 'длина кортежа KV не проверяется (четвёртый элемент — неизвестный смысл)',
      pattern: '        if tuple.len() != 3 {',
      replacement: '        if false {' },
    { name: 'значение KV берётся из ключа (состояние восстанавливается испорченным)',
      pattern: '        let value = tuple[2]\n            .as_str()',
      replacement: '        let value = tuple[1]\n            .as_str()' },
    { name: 'дедуп KV по (account,key) снят (одна запись дважды с разными значениями)',
      pattern: '        if !seen.insert((account.clone(), key.clone())) {',
      replacement: '        if false {' },
    { name: 'дедуп KV свёл account к пустой строке (один ключ в разных аккаунтах = конфликт)',
      pattern: '        if !seen.insert((account.clone(), key.clone())) {',
      replacement: '        if !seen.insert((String::new(), key.clone())) {' },

    // ── писатель: сборка backup (команда export_backup) ──
    { name: 'писатель вернул тихий unwrap_or({}) на неразобранных ключах (backup без ключей)',
      pattern: '        serde_json::from_str(keys).map_err(|_| anyhow!(ERR_EXPORT_KEYS_UNPARSED))?;',
      replacement: '        serde_json::from_str(keys).unwrap_or(serde_json::json!({}));' },
    { name: 'писатель пишет версию, которую его же читатель отвергает',
      pattern: '        "version": 1,',
      replacement: '        "version": 2,' },
    { name: 'писатель переименовал секцию ключей (импорт видит «ключей нет»)',
      pattern: '        "keys": keys_value,',
      replacement: '        "keypair": keys_value,' },
    { name: 'писатель кладёт KV в псевдоним kv (вне этого дерева backup читается как пустой)',
      pattern: '        "kv_store": kv,',
      replacement: '        "kv": kv,' },
    { name: 'писатель кладёт KV в незнакомое имя (kv_store потерян для всех читателей)',
      pattern: '        "kv_store": kv,',
      replacement: '        "kv_items": kv,' },

    // ── журнал: валидация манифеста и имён (ops.rs) ──
    { name: 'allowlist цели снят (манифест продвигает произвольный путь)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    matches!(name, TARGET_KEYPAIR | TARGET_PEERS)',
      replacement: '    true' },
    { name: 'allowlist цели сузился до keypair (контакты не восстанавливаются)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    matches!(name, TARGET_KEYPAIR | TARGET_PEERS)',
      replacement: '    matches!(name, TARGET_KEYPAIR)' },
    { name: 'форма txid не проверяется при поиске журнала (чужой каталог = транзакция)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '        if is_valid_txid(&name) {',
      replacement: '        if true {' },
    { name: 'длина txid перестала быть проверкой',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    txid.len() == 32 && txid.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '    !txid.is_empty() && txid.bytes().all(|b| b.is_ascii_hexdigit())' },
    { name: 'алфавит txid перестал быть проверкой (каталог из 32 букв = журнал)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    txid.len() == 32 && txid.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '    txid.len() == 32' },
    { name: 'версия манифеста не проверяется (структура неизвестной версии читается как v1)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    if m.version != 1 {',
      replacement: '    if false {' },
    { name: 'txid манифеста не сверяется с именем каталога (чужой манифест решает за этот журнал)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    if !is_valid_txid(&m.txid) || m.txid != txid {',
      replacement: '    if !is_valid_txid(&m.txid) {' },
    { name: 'пустой список целей принят (журнал без единой цели считается восстановленным)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    if m.targets.is_empty() {',
      replacement: '    if false {' },
    { name: 'дубль цели в манифестах не отвергается (вторая запись продвигает другие байты)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '        if !seen.insert(t.name.clone()) {',
      replacement: '        if !seen.insert(t.name.clone()) && false {' },
    { name: 'пустой db_path принят (маркер коммита ищется «неизвестно где»)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    if m.db_path.trim().is_empty() {\n        bail!(ERR_MALFORMED_JOURNAL);',
      replacement: '    if false {\n        bail!(ERR_MALFORMED_JOURNAL);' },
    { name: 'манифест читается по симлинку (чужой файл решает состояние ключей)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    if !meta.is_file() {\n        bail!(ERR_MALFORMED_JOURNAL);',
      replacement: '    if false {\n        bail!(ERR_MALFORMED_JOURNAL);' },
    { name: 'нечитаемый маркер коммита толкуется как «маркера нет» (откат уже закоммиченного импорта)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '        Ok(v) => v,\n        Err(_) => bail!(ERR_IO),\n    };\n\n    if committed {',
      replacement: '        Ok(v) => v,\n        Err(_) => false,\n    };\n\n    if committed {' },
    { name: 'после durable-маркера цели откатываются к OLD вместо доведения до NEW',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '            promote_target(&cfg.keys_dir, &journal, &t.name, t.old_present)?;',
      replacement: '            restore_target(&cfg.keys_dir, &journal, &t.name, t.old_present)?;' },
    { name: 'при отсутствии маркера цели доводятся до NEW вместо отката (сбой до commit стал «успехом»)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '            restore_target(&cfg.keys_dir, &journal, &t.name, t.old_present)?;\n        }\n    }',
      replacement: '            promote_target(&cfg.keys_dir, &journal, &t.name, t.old_present)?;\n        }\n    }' },
    { name: 'запись по симлинк-цели не отвергается (байты уходят вне каталога ключей)',
      file: 'vault-desktop/src-tauri/src/backup_import/ops.rs',
      pattern: '    if let Ok(meta) = fs::symlink_metadata(target) {\n        if meta.file_type().is_symlink() {\n            bail!(ERR_IO);',
      replacement: '    if let Ok(meta) = fs::symlink_metadata(target) {\n        if false {\n            bail!(ERR_IO);' },
  ],
};
