// Набор мутаций: rust-identity — форма адреса и предикат «эта запись моя».
//
// ЗАЧЕМ. Вопрос «запись моя?» решает, что удаляется, что пересылается и что
// считается уже импортированным. До переноса в ядро он жил в мосту
// (`src-tauri/src/groups.rs::filter_own_groups`), то есть вне
// `rust-mutation-gate`, а у CLI была вторая, обеднённая копия: `listen.rs`
// отсекал self-копии через `eq_ignore_ascii_case` (адрес с обрамляющим
// пробелом не узнавался → бот отвечал сам себе), а `cli/repl.rs` искал
// участника по `to_lowercase()` без алиасов и отпечатков. Три копии одного
// факта расходятся молча — поэтому каждая мутация ниже это реальный дефект
// из истории или из другой копии правила.
//
// Модуль живёт в `vault-core` (его форму адреса спрашивает хранилище ключей),
// `vault-client` реэкспортирует его как `vault::identity`. Набор остался тем
// же — переехал файл, а не правило.
//
// Класс мутируемого здесь — НЕ число: здесь правила нормализации и порядок
// «fp-first, адрес как fallback». Отдельно держим пустые значения: «пустой
// адрес == пустой адрес» и «пустой отпечаток совпадает с любым» — это не
// косметика, а дыра (письмо без From считается своим, чужая группа — моей).
export default {
  id: 'rust-identity',
  crate: 'vault-core',
  file: 'vault-core/src/identity.rs',
  smoke: 'cargo test -p vault-core --lib',
  mutations: [
    { name: 'регистр ASCII вместо Юникода (кириллические адреса не совпадают никогда — тот же дефект, что был с именами папок)',
      pattern: '    raw.trim().to_lowercase()',
      replacement: '    raw.trim().to_ascii_lowercase()' },
    { name: 'обрамление не срезается (адрес из заголовка с пробелом перестаёт быть моим)',
      pattern: '    raw.trim().to_lowercase()',
      replacement: '    raw.to_lowercase()' },
    { name: 'пустой адрес совпадает с пустым (письмо без From отсекается как своё)',
      pattern: 'pub fn same_address(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    !a.is_empty() && a == b',
      replacement: 'pub fn same_address(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    !a.is_empty() || a == b' },
    { name: 'пустой отпечаток совпадает с любым (чужая группа становится моей)',
      pattern: 'pub fn same_fingerprint(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    !a.is_empty() && a == b',
      replacement: 'pub fn same_fingerprint(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    a == b' },
    { name: 'любой непустой адрес попадёт в моё множество',
      pattern: '        !v.is_empty() && self.addresses.contains(&v)',
      replacement: '        !v.is_empty() || self.addresses.contains(&v)' },
    { name: 'алиасы не попадают в множество (владение только по текущему email: группа с чужого адреса — «не моя»)',
      pattern: '            addresses.insert(v.clone());\n            norm_aliases.push(v);',
      replacement: '            norm_aliases.push(v);' },
    { name: 'пустой алиас заводится в список (сравнение «содержит пустое» ложно срабатывает)',
      pattern: '            if v.is_empty() || addresses.contains(&v) {',
      replacement: '            if addresses.contains(&v) {' },
    { name: 'владение без отпечатка (смена почты прячет группу: регрессия 05–06.10.2026)',
      pattern: '            .any(|(email, fp)| self.member_matches(email, fp))',
      replacement: '            .any(|(email, _fp)| self.has_address(email))' },
    { name: 'владение без адреса — fallback для старых записей пропал (участник без fp не виден)',
      pattern: '            .any(|(email, fp)| self.member_matches(email, fp))',
      replacement: '            .any(|(_email, fp)| self.has_fingerprint(fp))' },
    { name: 'запись участника «моя» только при совпадении И адреса, И отпечатка (ни адрес, ни fp по отдельности не работают)',
      pattern: '        self.has_address(email) || self.has_fingerprint(fingerprint)',
      replacement: '        self.has_address(email) && self.has_fingerprint(fingerprint)' },
    { name: 'запись участника узнаётся только по отпечатку (адрес-фолбэк потерян — старые записи не мои)',
      pattern: '        self.has_address(email) || self.has_fingerprint(fingerprint)',
      replacement: '        self.has_fingerprint(fingerprint)' },
    { name: 'запись участника узнаётся только по адресу (после смены почты права в группе исчезают)',
      pattern: '        self.has_address(email) || self.has_fingerprint(fingerprint)',
      replacement: '        self.has_address(email)' },
    { name: 'создатель группы не проверяется (свои группы исчезают из списка)',
      pattern: '        if self.has_address(created_by) {\n            return true;\n        }',
      replacement: '        if false {\n            return true;\n        }' },
    { name: 'отпечаток участника считается моим без сверки с моим (спуфинг по чужому fp)',
      pattern: '        same_fingerprint(&self.fingerprint, candidate)',
      replacement: '        !candidate.trim().is_empty()' },
    { name: 'пустой адрес заводит ключ хранилища (heartbeat «ни от кого» = запись)',
      pattern: '    if key.is_empty() {\n        None\n    } else {\n        Some(key)\n    }',
      replacement: '    if key.is_empty() {\n        Some(String::new())\n    } else {\n        Some(key)\n    }' },
    { name: 'заполнение затирает уже известный отпечаток (идемпотентность потеряна — обеих миграций)',
      pattern: '    if new_fp.is_empty() || !existing_fp.trim().is_empty() {',
      replacement: '    if new_fp.is_empty() {' },
    { name: 'отпечаток пишется без нормализации (ключи расходятся регистром)',
      pattern: '    let new_fp = normalize(new_fp);',
      replacement: '    let new_fp = new_fp.to_string();' },
    { name: 'своя дописьма ищет адрес по ASCII (тот же дефект, что был в мосту)',
      pattern: '    if same_address(member_email, my_email) {',
      replacement: '    if member_email.to_ascii_lowercase() == my_email.to_ascii_lowercase() {' },
    { name: 'своя дописьма пишет отпечаток любому участнику (условие «это я» потеряно)',
      pattern: '    if same_address(member_email, my_email) {',
      replacement: '    if true {' },
    { name: 'массовая миграция не считает пустой отпечаток пустым (пишет поверх занятого слота)',
      pattern: '    if new_fp.is_empty() || !existing_fp.trim().is_empty() {',
      replacement: '    if new_fp.is_empty() || existing_fp.is_empty() {' },
    // Гейт контактного адреса (партия 4d): его спрашивает хранилище ключей.
    { name: 'служебный fp:-ключ проходит гейт (контакт-отпечаток снова в списке)',
      pattern: "    v.contains('@') && !v.starts_with(\"fp:\")",
      replacement: "    v.contains('@')" },
    { name: 'адрес без @ считается контактом (в peer_keys заводятся не-адреса)',
      pattern: "    v.contains('@') && !v.starts_with(\"fp:\")",
      replacement: "    !v.starts_with(\"fp:\")" },
    { name: 'гейт смотрит на сырую строку (FP: в верхнем регистре и обрамление проходят)',
      pattern: "    let v = normalize(raw);\n    v.contains('@') && !v.starts_with(\"fp:\")",
      replacement: "    let v = raw;\n    v.contains('@') && !v.starts_with(\"fp:\")" },
    // Отпечаток из публичного ключа (партия 4e): форма `xx:…:****` — часть
    // контракта релея и поля `GroupMember::fingerprint`. Срез, длина и
    // починка старого следа меряются здесь, а не в мосте.
    { name: 'отпечаток берёт 9 байт вместо 8 (форма не совпадает с релеем и groups.json)',
      pattern: '    let fp = bytes[..8]',
      replacement: '    let fp = bytes[..9]' },
    { name: 'ключ любой длины принимается за публичный (мусор превращается в отпечаток)',
      pattern: '    if bytes.len() != 32 {\n        return Err("Public key must be 32 bytes".to_string());\n    }',
      replacement: '    if false {\n        return Err("Public key must be 32 bytes".to_string());\n    }' },
    { name: 'след публичного ключа не чинится (в groups.json остаётся 64-hex вместо отпечатка)',
      pattern: '    if existing.is_empty() || existing == normalize(public_key_hex) {',
      replacement: '    if existing.is_empty() {' },
    { name: 'старый отпечаток сравнивается без нормализации (ключ в верхнем регистре не узнаётся)',
      pattern: '    let existing = normalize(existing);\n    if existing.is_empty() || existing == normalize(public_key_hex) {',
      replacement: '    let existing = existing.to_string();\n    if existing.is_empty() || existing == normalize(public_key_hex) {' },
    { name: 'пустой вычисленный отпечаток записывается (поле затирается пустым)',
      pattern: '    if computed.is_empty() {\n        return None;\n    }',
      replacement: '    if false {\n        return None;\n    }' },
    // «Свой аккаунт не контакт» (24.10, живой случай X50): адрес сессии,
    // алиасы, отпечаток и наш ПУБЛИЧНЫЙ КЛЮЧ, записанный_old backfill в поле
    // fingerprint. Прежнее сравнение строк во фронте превращало собственный
    // аккаунт в «контакт без ключа».
    { name: 'пустой публичный ключ совпадает с любым (контакт без ключа = «свой»)',
      pattern: 'pub fn same_public_key(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    !a.is_empty() && a == b',
      replacement: 'pub fn same_public_key(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    a == b' },
    { name: 'срез 16 hex выдаётся за весь ключ (чужой пир с тем же префиксом — «свой»)',
      pattern: 'pub fn same_public_key(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a), normalize(b));\n    !a.is_empty() && a == b\n}',
      replacement: 'pub fn same_public_key(a: &str, b: &str) -> bool {\n    let (a, b) = (normalize(a).into_bytes(), normalize(b).into_bytes());\n    !a.is_empty() && a[..std::cmp::min(a.len(), 16)] == b[..std::cmp::min(b.len(), 16)]\n}' },
    { name: 'свой адрес в составе не узнаётся (регрессия 24.10: аккаунт приложения — «контакт»)',
      pattern: '    id.has_address(member_email)\n        || id.has_fingerprint(member_fingerprint)',
      replacement: '    id.has_fingerprint(member_fingerprint)' },
    { name: 'свой отпечаток не узнаётся (только адрес — починка следа не помогает)',
      pattern: '    id.has_address(member_email)\n        || id.has_fingerprint(member_fingerprint)',
      replacement: '    id.has_address(member_email)' },
    { name: 'след нашего ключа в fingerprint не опознаётся (главная ветка правила)',
      pattern: '        || same_public_key(member_fingerprint, own_public_key_hex)',
      replacement: '' },
    // ── contacts_to_pad: кого звать в контакты из состава групп (X50, 24.10)
    { name: 'свой участник добивается контактом (проверка «это мы» убрана)',
      pattern: '        if email.is_empty() || member_is_account(id, email, fingerprint, own_public_key_hex) {',
      replacement: '        if email.is_empty() {' },
    { name: 'известный адрес участника не узнаётся (вторая строка о том же человеке)',
      pattern: '        if contacts.iter().any(|(c, _)| same_address(c, email)) {',
      replacement: '        if false {' },
    { name: 'адрес участника сравнивается точно (регистр и обрамление плодят дубль)',
      pattern: '        if contacts.iter().any(|(c, _)| same_address(c, email)) {',
      replacement: '        if contacts.iter().any(|(c, _)| c == email) {' },
    { name: 'идентичность по ключу не узнаётся (призрак остаётся в списке)',
      pattern: '        if known {\n            continue;\n        }',
      replacement: '' },
    { name: 'префикс ключа выдаётся за весь ключ (два пира с общим отпечатком сливаются)',
      pattern: '                || trace.as_deref() == Some(key_norm.as_str())',
      replacement: '                || trace\n                    .as_deref()\n                    .map(|t| key_norm.starts_with(&t[..16]))\n                    .unwrap_or(false)' },
    { name: 'участник нескольких групп добавляется несколько раз',
      pattern: '        if !out.iter().any(|e| same_address(e, email)) {',
      replacement: '        if true {' },
    { name: 'любая hex-строка считается полным ключом (префикс или урезанный отпечаток)',
      pattern: '    if v.len() != 64 || !v.chars().all(|c| c.is_ascii_hexdigit()) {',
      replacement: '    if !v.chars().all(|c| c.is_ascii_hexdigit()) && !v.contains(\':\') {' },
    // ── address_variants / resolve_alias: КАКИМИ формами адреса это один пир
    // (смена почты, живой случай X50: тап по известному адресу открывал попап
    // «Добавить контакт», потому что гейт спрашивал голую строку, не зная
    // словаря `email-aliases`) и КАКОЙ адрес у пира сейчас (тем же словарём
    // резолвилась каждая строка письма — цепочка обходилась второй раз уже в
    // JS). Словарь приходит из kv как его записали, поэтому нормализация —
    // обязанность правила, а не вызывающего. Оба вопроса идут ОДНИМ обходом
    // (`alias_chain`), поэтому мутации цепочки бьют по обоим ответам.
    { name: 'адрес не нормализуется в формах адреса (тап по «Petr@Post.RU» не находит ключ)',
      pattern: `pub fn address_variants(aliases: &[(String, String)], address: &str) -> Vec<String> {
    let start = normalize(address);`,
      replacement: `pub fn address_variants(aliases: &[(String, String)], address: &str) -> Vec<String> {
    let start = address.to_string();` },
    { name: 'резолв адреса не нормализует вход (строка из письма «Petr@Post.RU» не находит смену)',
      pattern: `pub fn resolve_alias(aliases: &[(String, String)], address: &str) -> String {
    let start = normalize(address);`,
      replacement: `pub fn resolve_alias(aliases: &[(String, String)], address: &str) -> String {
    let start = address.to_string();` },
    { name: 'пустой адрес всё-таки резолвится (первая попавшаяся запись выдаётся за ключ пира)',
      pattern: '    if start.is_empty() {\n        return Vec::new();\n    }',
      replacement: '    if false {\n        return Vec::new();\n    }' },
    { name: 'пустой адрес резолвится записью с пустым ключом (письмо без From «переименовывается»)',
      pattern: '    if start.is_empty() {\n        return String::new();\n    }',
      replacement: '    if false {\n        return String::new();\n    }' },
    { name: 'резолв обходит цепочку, но отвечает исходным адресом (смена почты не видна)',
      pattern: '    alias_chain(aliases, &start).pop().unwrap_or(start)',
      replacement: '    start' },
    { name: 'ключ словаря сравнивается сырой строкой (пара « Old@X → New@X» не находится)',
      pattern: '        let next = match aliases.iter().find(|(from, _)| normalize(from) == cur) {',
      replacement: '        let next = match aliases.iter().find(|(from, _)| *from == cur) {' },
    { name: 'свежий адрес возвращается без нормализации (ключ ищется по «New@X» и не находится)',
      pattern: '            Some((_, to)) => normalize(to),',
      replacement: '            Some((_, to)) => to.clone(),' },
    { name: 'обратный ход сравнивает сырые пары (старый адрес пира не догоняется)',
      pattern: `    for (from, to) in aliases {
        let (f, t) = (normalize(from), normalize(to));
        if f.is_empty() || t != start {`,
      replacement: `    for (from, to) in aliases {
        let (f, t) = (from.clone(), to.clone());
        if f.is_empty() || t != start {` },
    { name: 'обратный ход берёт ВСЕ пары словаря (чужие алиасы лезут в варианты и подставляют чужой ключ)',
      pattern: '        if f.is_empty() || t != start {',
      replacement: '        if f.is_empty() {' },
    { name: 'вариант добавляется без проверки повтора (цикл A→B→A плодит дубль в списке форм)',
      pattern: '        if !v.is_empty() && !out.contains(&v) {',
      replacement: '        if !v.is_empty() {' },
    // ── is_own_address: «письмо пришло от нас?» — резолв цепочки + нормальная
    // форма, один вопрос для всех handshake-путей фронта. До переноса четыре
    // копии в api.js сравнивали строки ПОСЛЕ резолва регистрозависимо, и своё
    // письмо с адресом в другом регистре возвращало наш ключ в контакты.
    { name: 'своё письмо сравнивается без резолва цепочки (письмо старого нашего адреса после смены считается чужим)',
      pattern: '    same_address(&resolve_alias(aliases, address), own_address)',
      replacement: '    same_address(address, own_address)' },
    { name: 'своё письмо сравнивается сырыми строками (регистр или пробел делают письмо чужим)',
      pattern: '    same_address(&resolve_alias(aliases, address), own_address)',
      replacement: '    resolve_alias(aliases, address) == own_address' },
    { name: 'пустой отправитель считается нашим письмом (письмо без From отсекается как своё)',
      pattern: '    same_address(&resolve_alias(aliases, address), own_address)',
      replacement: '    let resolved = resolve_alias(aliases, address);\n    resolved.is_empty() || resolved == normalize(own_address)' },
    // ── alias_resolutions: словарь для кэша фронта (строка → свежий адрес).
    // Обход — тот же `resolve_alias`; здесь меряется выборка строк и ключи.
    { name: 'ключ разрешённого словаря не нормализуется (кэш фронта ищет « Old@X » и промахивается)',
      pattern: '        let key = normalize(from);',
      replacement: '        let key = from.clone();' },
    { name: 'разрешённый словарь не резолвит строки (кэш пуст, старые письма снова «воскрешают» адрес)',
      pattern: '        let fresh = resolve_alias(aliases, &key);',
      replacement: '        let fresh = key.clone();' },
    { name: 'в разрешённый словарь попадают пары без смены (лишние строки кэша)',
      pattern: '        if fresh != key {',
      replacement: '        if true {' },
    { name: 'повтор ключа в словаре плодит строки кэша (победитель зависит от порядка)',
      pattern: '        if key.is_empty() || out.iter().any(|(seen, _)| *seen == key) {',
      replacement: '        if key.is_empty() {' },
    // ── alias_pairs_after_remember: правило ЗАПИСИ словаря (анти-цикл
    // A→B→A и нормализация). До переноса жило только в JS; ошибка здесь
    // зацикливает резолв и откатывает ренеймы при перечитывании писем.
    { name: 'старый адрес пишется без нормализации (грязная строка не находится резолвом)',
      pattern: '    let old = normalize(old_email);\n    let new = normalize(new_email);',
      replacement: '    let old = old_email.to_string();\n    let new = normalize(new_email);' },
    { name: 'новый адрес пишется без нормализации (ключ ищется по сырому адресу)',
      pattern: '    let old = normalize(old_email);\n    let new = normalize(new_email);',
      replacement: '    let old = normalize(old_email);\n    let new = new_email.to_string();' },
    { name: 'пустой старый адрес считается сменой (в словарь попадает пустой ключ)',
      pattern: '    let real = !old.is_empty() && !new.is_empty() && old != new;',
      replacement: '    let real = !new.is_empty() && old != new;' },
    { name: 'пустой новый адрес затирает старую пару (смена «никуда» удаляет живой резолв)',
      pattern: '    let real = !old.is_empty() && !new.is_empty() && old != new;',
      replacement: '    let real = !old.is_empty() && old != new;' },
    { name: 'смена адреса на себя пишется как настоящая (словарь пухнет самоссылками)',
      pattern: '    let real = !old.is_empty() && !new.is_empty() && old != new;',
      replacement: '    let real = !old.is_empty() && !new.is_empty();' },
    { name: 'анти-цикл потерян: запись со свежим адресом в ключе остаётся ({A:B, B:A})',
      pattern: '        if real && (f == old || f == new) {',
      replacement: '        if real && f == old {' },
    { name: 'прежняя запись не заменяется (по старому ключу две смены сразу)',
      pattern: '        if real && (f == old || f == new) {',
      replacement: '        if real && f == new {' },
    { name: 'существующие пары не нормализуются (грязный словарь переносится в свежую запись)',
      pattern: `    for (from, to) in aliases {
        let (f, t) = (normalize(from), normalize(to));
        if real && (f == old || f == new) {`,
      replacement: `    for (from, to) in aliases {
        let (f, t) = (from.clone(), to.clone());
        if real && (f == old || f == new) {` },
    { name: 'чужие пары теряются при записи (смена одного пира стирает словарь)',
      pattern: `        if real && (f == old || f == new) {
            continue;
        }
        out.push((f, t));`,
      replacement: `        if real && (f == old || f == new) {
            continue;
        }` },
    { name: 'направление смены перевёрнуто (резолв уводит адрес назад)',
      pattern: '        out.push((old, new));',
      replacement: '        out.push((new, old));' },
    { name: 'пара пишется при пустой/равной смене (словарь получает мусорную запись)',
      pattern: '    if real {\n        out.push((old, new));\n    }',
      replacement: '    if !old.is_empty() {\n        out.push((old, new));\n    }' },
    // ── peer_is_self: «эта запись — мы» для чтения списка, добивки и
    // broadcast профиля. Два независимых пути; каждый снимается своим
    // утверждением теста.
    { name: 'предикат забыл про ключ (свой ключ под неизвестным адресом — «контакт», broadcast шлёт себе)',
      pattern: '    id.has_address(address) || same_public_key(public_key, own_public_key)',
      replacement: '    id.has_address(address)' },
    { name: 'предикат забыл про адрес (наша строка без ключа в записи считается чужой)',
      pattern: '    id.has_address(address) || same_public_key(public_key, own_public_key)',
      replacement: '    same_public_key(public_key, own_public_key)' },
    // ── peer_key_candidates: каким порядком слушатель перебирает ключи, когда
    // ключ отправителя не подошёл (31.10: письмо koanmak@ya.ru шифровалось
    // ключом, записанным за vault-msg@ya.ru). Класс — порядок и дедуп, не число.
    { name: 'перебор берёт только записи с ПУСТЫМ ключом (настоящий ключ отсекается до попытки)',
      pattern: '        .filter(|k| !k.public_key.trim().is_empty())',
      replacement: '        .filter(|k| k.public_key.trim().is_empty())' },
    { name: 'ключ отправителя сравнивается строкой (адрес с обрамлением или регистром — и свой ключ ушёл в хвост)',
      pattern: '        let rank = |addr: &str| if same_address(addr, sender) { 0u8 } else { 1u8 };',
      replacement: '        let rank = |addr: &str| if addr == sender { 0u8 } else { 1u8 };' },
    { name: 'ключ отправителя уходит в конец перебора (обычный путь стал последним, а чужой — первым)',
      pattern: '        let rank = |addr: &str| if same_address(addr, sender) { 0u8 } else { 1u8 };',
      replacement: '        let rank = |addr: &str| if same_address(addr, sender) { 1u8 } else { 0u8 };' },
    { name: 'остальные ключи не упорядочены (победитель зависит от порядка перечитывания книги)',
      pattern: '            .then_with(|| normalize(a.address).cmp(&normalize(b.address)))',
      replacement: '            .then_with(|| std::cmp::Ordering::Equal)' },
    { name: 'один и тот же ключ пробуется ещё раз (книга с двумя адресами одного человека перебирается бесконечно дороже)',
      pattern: '            .any(|seen| same_public_key(seen.public_key, k.public_key))',
      replacement: '            .any(|_| false)' },
    { name: 'потолок перебора на единицу шире (обещанное ограничение не держится)',
      pattern: '        if out.len() >= PEER_KEY_CANDIDATES_MAX {',
      replacement: '        if out.len() > PEER_KEY_CANDIDATES_MAX {' },
    { name: 'потолок = 1 (второй ящик того же человека снова остаётся незашифрованным)',
      pattern: 'pub const PEER_KEY_CANDIDATES_MAX: usize = 8;',
      replacement: 'pub const PEER_KEY_CANDIDATES_MAX: usize = 1;' },
  ],
};
