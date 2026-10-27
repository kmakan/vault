// Набор мутаций: rust-duress — параметры PBKDF2 замка и форма `salt:hash`.
//
// ЗАЧЕМ. PIN/duress-код — протокол: итерации, длины соли и ключа уже записаны
// в сохранённых хэшах, а форму `salt:hash` читает и Kotlin-замок, и JS-замок.
// Round-trip внутри одной версии такого дрейфа не видит: hash_secret и
// verify_secret согласованы сами с собой, а старые PIN-ы молча перестают
// подходить. Поэтому здесь есть KAT с фиксированной солью и
// parameters_match_protocol, и набор требует, чтобы поломка была поймана.
export default {
  id: 'rust-duress',
  file: 'vault-client/src/vault/duress.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'итерации PBKDF2 уменьшены (старые PIN-ы перестают проверяться)',
      pattern: 'pub const ITERATIONS: u32 = 10_000;',
      replacement: 'pub const ITERATIONS: u32 = 9_999;' },
    { name: 'длина соли изменена (форма salt:hash расходится с сохранёнными)',
      pattern: 'pub const SALT_LEN: usize = 16;',
      replacement: 'pub const SALT_LEN: usize = 8;' },
    { name: 'длина ключа изменена (хэш другой длины не сравнится со старым)',
      pattern: 'pub const KEY_LEN: usize = 32;',
      replacement: 'pub const KEY_LEN: usize = 31;' },
    { name: 'лишняя итерация в цепочке U_i (KAT расходится, старые PIN-ы не подходят)',
      pattern: '        for _ in 1..iterations {',
      replacement: '        for _ in 0..iterations {' },
    { name: 'XOR-накопление сломано (U_i не складываются в хэш)',
      pattern: '                *tb ^= ub;',
      replacement: '                *tb ^= 0u8;' },
    { name: 'соль не случайна (у двух хэшей одного PIN-а одна соль)',
      pattern: '    rand::thread_rng().fill_bytes(&mut salt);',
      replacement: '    salt = [7u8; SALT_LEN];' },
    { name: 'сравнение всегда «совпало» (любой код открывает замок)',
      pattern: '    diff == 0',
      replacement: '    diff == 0 || true' },
    { name: 'блок-счётчик PBKDF2 стал 8-байтовым (KAT расходится)',
      pattern: '        mac.update(&block_index.to_be_bytes());',
      replacement: '        mac.update(&(block_index as u64).to_be_bytes());' },
    { name: 'секрет не участвует в выводе (разные коды дают один хэш)',
      pattern: '    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, ITERATIONS, &mut out);',
      replacement: '    pbkdf2_hmac_sha256(b"", &salt, ITERATIONS, &mut out);' },
    // ── Конверт SOS (26.10): сборка переехала из `service_monitor.rs`, где её
    // не мерил никто — модуль компилируется только под Android и с хоста в
    // прогоне не участвует. Ошибка в этом формате — письмо беды, которое
    // получатель показывает как обычное сообщение.
    { name: 'маркер формата SOS уезжает (получатель не признаёт письмо своим)',
      pattern: '        vault: 1,',
      replacement: '        vault: 2,' },
    { name: 'метка sos в идентификаторе теряется',
      pattern: '        id: format!("{ts_ms}sos"),',
      replacement: '        id: format!("{ts_ms}"),' },
    { name: 'тип собирается под другим именем (разбор на том конце не видит sos)',
      pattern: '        #[serde(rename = "type")]\n        msg_type: &\'a str,',
      replacement: '        #[serde(rename = "typ")]\n        msg_type: &\'a str,' },
    { name: 'тип сигнала беды подменяется обычным сообщением (SOS молчит)',
      pattern: '        msg_type: "sos",',
      replacement: '        msg_type: "text",' },
    { name: 'текст беды не попадает в конверт (получатель видит пустое письмо)',
      pattern: '        text,',
      replacement: '        text: "",' },

    // ── Правило текста SOS (27.10, #38): сюда переехало из моста, вторую копию
    // которого держал фронт. Ошибка в нём — письмо беды без слов, без места
    // или с местом не того человека.
    { name: 'дефолт не подставляется, когда настройка пуста (письмо без слов)',
      pattern: `    let base = if rule.text.trim().is_empty() {
        rule.default_text`,
      replacement: `    let base = if rule.text.trim().is_empty() {
        ""`,
    },
    { name: 'пустая настройка не считается пустой (дефолт не нужен никогда)',
      pattern: '    let base = if rule.text.trim().is_empty() {',
      replacement: '    let base = if false {' },
    { name: 'пробелы в настройке считаются текстом (письмо из одного пробела)',
      pattern: '    let base = if rule.text.trim().is_empty() {',
      replacement: '    let base = if rule.text.is_empty() {' },
    { name: 'без координат плейсхолдер остаётся в письме (служебная метка на глазах)',
      pattern: `    if rule.geo.is_empty() {
        return base.replace("{coords}", "");`,
      replacement: `    if rule.geo.is_empty() {
        return base.to_string();`,
    },
    { name: 'координаты никогда не встают вместо плейсхолдера',
      pattern: '    if rule.geo.is_empty() {',
      replacement: '    if true {' },
    { name: 'подстановка наоборот: координаты затираются плейсхолдером',
      pattern: '        return base.replace("{coords}", rule.geo);',
      replacement: '        return base.replace(rule.geo, "{coords}");' },
    { name: 'хвост теряет координаты (место человека не уезжает)',
      pattern: '        return format!("{base}{}{}", rule.separator, rule.geo);',
      replacement: '        return format!("{}", base);' },
    { name: 'в хвосте текст и координаты меняются местами',
      pattern: '        return format!("{base}{}{}", rule.separator, rule.geo);',
      replacement: '        return format!("{}{}{}", rule.geo, rule.separator, base);' },
    { name: 'разделитель хвоста теряется (читается как одно слово)',
      pattern: '        return format!("{base}{}{}", rule.separator, rule.geo);',
      replacement: '        return format!("{base}{}", rule.geo);' },
    { name: 'флаг гео не читается — координаты дописываются всегда',
      pattern: '    if rule.geo_on {',
      replacement: '    if true {' },
    { name: 'гео включено, но хвост не дописывается (флаг всегда выключен)',
      pattern: '    if rule.geo_on {',
      replacement: '    if false {' },
    { name: 'хвост без гео теряет текст письма',
      pattern: `    base.to_string()
}`,
      replacement: `    String::new()
}`,
    },
    { name: 'разряды координат теряются (место с точностью до километра)',
      pattern: '    format!(", {label}: {lat:.5}, {lon:.5}")',
      replacement: '    format!(", {label}: {lat:.3}, {lon:.3}")' },
    { name: 'без подписи координат всё равно печатается двоеточие',
      pattern: '    if label.is_empty() {',
      replacement: '    if false {' },
    { name: 'фраза координат теряет ведущую запятую (слипается с текстом)',
      pattern: '        return format!(", {lat:.5}, {lon:.5}");',
      replacement: '        return format!("{lat:.5}, {lon:.5}");' },
  ],
};
