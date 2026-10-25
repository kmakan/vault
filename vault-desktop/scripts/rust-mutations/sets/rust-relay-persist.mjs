// Набор мутаций: rust-relay-persist — что переживает рестарт релея.
//
// ЗАЧЕМ. `state.json` — единственное, из чего релей после рестарта поднимает
// адресные связки (fp → read-токен), привязки купленных токенов, подписки и
// суточный счётчик конвертов. Если при загрузке проскакивает мусорная запись,
// релей либо отправит push в несуществующий адрес, либо (хуже) потеряет
// привязку оплаченного токена; если счётчик не переживёт рестарт, free-лимит
// «100 конвертов в сутки» обходится `systemctl restart`.
//
// Мутируем сами правила: фильтры каждой карты (тема = 64 hex, reg_token —
// словарь символов, рингтон — http, fp — hex через «:», токен — base64url,
// publisher — `t:<64 hex>` или `ip:<адрес>`), границу суток UTC, отсечение
// прошлых счетов, sanitize при загрузке, rename как способ атомарной записи и
// права 0600 (в файле лежат адреса доставки).
//
// Что осталось неизмеримым осознанно: `fsync` (tmp и каталога) — переживание
// обрыва питания мутацией не проверяется, это проверяет только живая машина;
// потолок MAX_ENTRIES — потребовал бы синтетической карты на десятки тысяч
// записей, сейчас это защита от роста файла, а не решение о форме данных.
export default {
  id: 'rust-relay-persist',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/persist.rs',
  smoke: 'cargo test -p vault-relay --lib persist',
  timeoutMs: 600_000,
  mutations: [
    { name: 'тема FCM не проверяется (мусорная ключевая строка едет в push)',
      pattern: '        self.topic_fcm.retain(|k, v| valid_topic(k) && valid_reg_token(v));',
      replacement: '        self.topic_fcm.retain(|k, v| valid_reg_token(v));' },
    { name: 'пустой reg_token остаётся (push в никуда, доставка молча не работает)',
      pattern: '        self.topic_fcm.retain(|k, v| valid_topic(k) && valid_reg_token(v));',
      replacement: '        self.topic_fcm.retain(|k, v| valid_topic(k));' },
    { name: 'URL рингтона не проверяется (ftp:// и мусор уезжает на устройство)',
      pattern: '        self.topic_ringtone.retain(|k, v| valid_topic(k) && valid_ringtone(v));',
      replacement: '        self.topic_ringtone.retain(|k, v| valid_topic(k));' },
    { name: 'fp аккаунта не проверяется (адрес очереди привязывается к мусору)',
      pattern: '        self.fp_tokens\n            .retain(|k, v| valid_fp(k) && valid_token(&v.token));',
      replacement: '        self.fp_tokens\n            .retain(|k, v| valid_token(&v.token));' },
    { name: 'read-токен в fp-записи не проверяется (под связкой — битый токен)',
      pattern: '        self.fp_tokens\n            .retain(|k, v| valid_fp(k) && valid_token(&v.token));',
      replacement: '        self.fp_tokens\n            .retain(|k, v| valid_fp(k));' },
    { name: 'тема обязана быть длиной 64, но не hex (не-подписанные ключи остаются)',
      pattern: '    v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '    v.len() == 64' },
    { name: 'пустой reg_token считается валидным',
      pattern: 'fn valid_reg_token(v: &str) -> bool {\n    !v.is_empty()',
      replacement: 'fn valid_reg_token(v: &str) -> bool {\n    true' },
    { name: 'словарь символов reg_token сужен (настоящие токены FCM отсекаются)',
      pattern: "            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.' | '~' | '%'))",
      replacement: '            .all(|c| c.is_ascii_alphanumeric())' },
    { name: 'рингтон не проверяется на http',
      pattern: '    v.trim().starts_with("http")',
      replacement: '    true' },
    { name: 'пустой fp допускается в связку',
      pattern: 'fn valid_fp(v: &str) -> bool {\n    !v.is_empty()',
      replacement: 'fn valid_fp(v: &str) -> bool {\n    true' },
    { name: 'fp без двоеточий не проходит (отпечаток перестаёт узнаваться)',
      pattern: "            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_'))",
      replacement: "            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))" },
    { name: 'base64url-токен со «-» считается мусором',
      pattern: "            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))",
      replacement: "            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_'))" },
    { name: 'ключ издателя принимается по длине без проверки hex',
      pattern: '        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())',
      replacement: '        hash.len() == 64' },
    { name: 'любой текст после ip: считается адресом',
      pattern: '        ip.parse::<std::net::IpAddr>().is_ok()',
      replacement: '        true' },
    { name: 'префикс ключа издателя не обязателен (мусорная строка = счётчик)',
      pattern: '    if let Some(hash) = v.strip_prefix("t:") {',
      replacement: '    if let Some(hash) = v.strip_prefix("") {' },
    { name: 'счётчик прошлых суток переживает рестарт (лимит зависает навсегда)',
      pattern: '            .retain(|k, (day, _)| valid_publisher(k) && *day == today);',
      replacement: '            .retain(|k, (_, _)| valid_publisher(k));' },
    { name: 'ключ счётчика не проверяется (поддельный publisher обнуляет чужие лимиты)',
      pattern: '            .retain(|k, (day, _)| valid_publisher(k) && *day == today);',
      replacement: '            .retain(|k, (day, _)| *day == today);' },
    { name: 'граница счётчика — час, а не сутки UTC (квота сбрасывается 24 раза в день)',
      pattern: '        let today = now_unix() / 86_400;\n        let before = self.daily_pub.len();',
      replacement: '        let today = now_unix() / 3_600;\n        let before = self.daily_pub.len();' },
    { name: 'при загрузке состояние не sanitizируется (весь мусор файла живёт в памяти)',
      pattern: '                st.sanitize();',
      replacement: '                // sanitize снят' },
    { name: 'запись идёт без rename (читатель видит половину JSON)',
      pattern: '        std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;',
      replacement: '        // rename снят' },
    { name: 'файл состояния остаётся world-readable (адреса доставки читаются снаружи)',
      pattern: '            set_private_mode(&tmp);',
      replacement: '            // 0600 не ставится' },
    { name: 'пробелы в пути состояния не срезаются (« none » включает персист)',
      pattern: '            let v = v.trim();',
      replacement: '            let v = v;' },
    { name: '«none» не выключает персист (файл состояния пишется там, где обещано off)',
      pattern: '            } else if matches!(v, "off" | "none" | "0" | "disabled") {',
      replacement: '            } else if matches!(v, "off" | "0" | "disabled") {' },
    { name: 'пустое значение пути = персист выключен (релей теряет состояние после деплоя)',
      pattern: '            if v.is_empty() {',
      replacement: '            if false {' },
  ],
};
