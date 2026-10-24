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
      pattern: '    let (a, b) = (normalize(a), normalize(b));\n    !a.is_empty() && a == b\n}\n\n/// Участник — ЭТОТ ЖЕ аккаунт',
      replacement: '    let (a, b) = (normalize(a).into_bytes(), normalize(b).into_bytes());\n    !a.is_empty() && a[..std::cmp::min(a.len(), 16)] == b[..std::cmp::min(b.len(), 16)]\n}\n\n/// Участник — ЭТОТ ЖЕ аккаунт' },
    { name: 'свой адрес в составе не узнаётся (регрессия 24.10: аккаунт приложения — «контакт»)',
      pattern: '    id.has_address(member_email)\n        || id.has_fingerprint(member_fingerprint)',
      replacement: '    id.has_fingerprint(member_fingerprint)' },
    { name: 'свой отпечаток не узнаётся (только адрес — починка следа не помогает)',
      pattern: '    id.has_address(member_email)\n        || id.has_fingerprint(member_fingerprint)',
      replacement: '    id.has_address(member_email)' },
    { name: 'след нашего ключа в fingerprint не опознаётся (главная ветка правила)',
      pattern: '        || same_public_key(member_fingerprint, own_public_key_hex)',
      replacement: '' },
  ],
};
