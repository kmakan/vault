// Набор мутаций: каналы в мосте (src-tauri/src/channels.rs) — CRUD +
// раскладка capability-токена.
//
// ЗАЧЕМ. Здесь живут два класса решений, за которые ошибка платит данными:
//  • 45-байтовый канальный токен (метки HMAC, key_id из read-подписи,
//    sentinel «бессрочно», scope 'c'/'C', url-safe без паддинга) — формат
//    общий с релеем, а релейная половина уже измерена (rust-relay-tokens
//    26/26). Расхождение молча означает «каналы перестали работать».
//  • правила хранения канала: чей канал (is_owner), что можно патчить (ключ по
//    длине, пустой owner_fpr = «не трогать»), монотонный last_ts, дедуп
//    подписчика по нормализованному адресу, «нет такого канала — ошибка».
// Тестов в модуле было 8, мутационной мерки — ни одной (дыра ратчета).
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (проверено чтением кода, 25.10):
//   * `TEST_CHANNELS_FILE` (приоритет тестового перенаправления над env и
//     `~/.vault`) — мутант «if false» заставил бы тесты писать в НАСТОЯЩИЙ
//     channels.json владельца: гейт не должен иметь возможности тронуть живые
//     данные, это не «дыра в проверке», а запрет на мутант;
//   * атомарная запись (tmp + rename) — видна только на падении между write и
//     rename, без инъекции ФС не измеряется; обе мутации (снятие rename,
//     запись сразу в path) дали бы зелёный тест на сломанном поведении;
//   * `u32::MAX.to_be_bytes()` → `to_le_bytes()` — значение симметрично
//     (FF FF FF FF), мутант эквивалентен;
//   * алфавит ключа (`is_valid_channel_key` меряет только длину) — правило
//     ядра и меряется там (vault-client/src/vault/channels.rs); здесь мутантом
//     было бы «снять вызов предиката», что и делается в обоих местах.
export default {
  id: 'rust-bridge-channels',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/channels.rs',
  smoke: 'cargo test -p vault-desktop --lib channels::',
  timeoutMs: 600_000,
  mutations: [
    // ── раскладка capability-токена (общий формат с релеем) ──
    { name: 'метка read-подписи взята из write (токены обоих ролей читаются иначе)',
      pattern: '\n    let read_mac = mac_of(b"vault-relay-channel-read");',
      replacement: '\n    let read_mac = mac_of(b"vault-relay-channel-write");' },
    { name: 'метка write-подписи взята из read (write-токен совпадает с read)',
      pattern: '\n    let write_mac = mac_of(b"vault-relay-channel-write");',
      replacement: '\n    let write_mac = mac_of(b"vault-relay-channel-read");' },
    { name: 'key_id взят из write-подписи (write не адресуется очереди read)',
      pattern: '    kid.copy_from_slice(&read_mac[..8]);',
      replacement: '    kid.copy_from_slice(&write_mac[..8]);' },
    { name: 'sentinel «бессрочно» снят (релей отклоняет канальный токен)',
      pattern: '\n        raw.extend_from_slice(&u32::MAX.to_be_bytes());',
      replacement: '\n        raw.extend_from_slice(&[0u8; 4]);' },
    { name: 'bytes mac встали раньше expiry (раскладка 45 Б читается со сдвигом)',
      pattern: '        raw.push(byte);\n        raw.extend_from_slice(&u32::MAX.to_be_bytes());\n        raw.extend_from_slice(mac);',
      replacement: '        raw.push(byte);\n        raw.extend_from_slice(mac);\n        raw.extend_from_slice(&u32::MAX.to_be_bytes());' },
    { name: 'scope read/write перменяны (читатель получает право публикации)',
      pattern: "    (pack(b'c', &read_mac), pack(b'C', &write_mac))",
      replacement: "    (pack(b'C', &read_mac), pack(b'c', &write_mac))" },
    { name: 'токен кодируется стандартным base64 (релей читает url-safe без паддинга)',
      pattern: '    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)',
      replacement: '    base64::engine::general_purpose::STANDARD.encode(data)' },
    { name: 'ключ из поля ввода не обрезается (пробелы = «bad channel key»)',
      pattern: '    let trimmed = key_hex.trim();',
      replacement: '    let trimmed = key_hex;' },
    // ── правила хранения канала ──
    { name: 'созданный канал не помечен владельческим (публиковать нечем)',
      pattern: '        is_owner: true,',
      replacement: '        is_owner: false,' },
    { name: 'импортированный канал помечен владельческим (подписчик мнит себя автором)',
      pattern: '        is_owner: false,',
      replacement: '        is_owner: true,' },
    { name: 'префикс id канала сменён на grp_ (роутер не отличит канал от группы)',
      pattern: '    let id = format!("chn_{}", hex::encode(id_bytes));',
      replacement: '    let id = format!("grp_{}", hex::encode(id_bytes));' },
    { name: 'форма id канала при импорте не проверяется (чужая ссылка принимается)',
      pattern: '    if !is_valid_channel_id(channel_id) {',
      replacement: '    if false {' },
    { name: 'длина ключа при импорте не проверяется (подписка на битый канал)',
      pattern: '    if !is_valid_channel_key(key) {\n        anyhow::bail!("Invalid channel key length");',
      replacement: '    if false {\n        anyhow::bail!("Invalid channel key length");' },
    { name: 'длина ключа при патче не проверяется (миграция кладёт мусор)',
      pattern: '        if !is_valid_channel_key(key) {\n            anyhow::bail!("Invalid channel key length");',
      replacement: '        if false {\n            anyhow::bail!("Invalid channel key length");' },
    { name: 'пустой owner_fpr перезаписывает владельца (hello-проверка слепнет)',
      pattern: '        if !owner_fpr.is_empty() {',
      replacement: '        if true {' },
    { name: 'last_ts пишется как есть, без монотонности (курсор откатывается)',
      pattern: '        ch.last_ts = next_last_ts(ch.last_ts, ts);',
      replacement: '        ch.last_ts = ts;' },
    { name: 'нормализация адреса подписчика снята (Боб@Почта.РУ вторым рядом)',
      pattern: '    let email = identity::normalize(email);',
      replacement: '    let email = email.to_string();' },
    { name: 'дедуп подписчика снят (пост уходит дважды)',
      pattern: '    if !email.is_empty() && !known {',
      replacement: '    if !email.is_empty() {' },
    { name: 'пустой адрес подписчика принимается (дубликат-пустышка)',
      pattern: '    if !email.is_empty() && !known {\n        ch.known_subscribers.push(email);',
      replacement: '    if !known {\n        ch.known_subscribers.push(email);' },
    { name: 'удаление несуществующего канала — успех (duress-wipe молча пропускает)',
      pattern: '    if channels.remove(channel_id).is_none() {',
      replacement: '    if false {' },
  ],
};
