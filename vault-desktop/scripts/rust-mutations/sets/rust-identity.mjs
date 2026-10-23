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
// Класс мутируемого здесь — НЕ число: здесь правила нормализации и порядок
// «fp-first, адрес как fallback». Отдельно держим пустые значения: «пустой
// адрес == пустой адрес» и «пустой отпечаток совпадает с любым» — это не
// косметика, а дыра (письмо без From считается своим, чужая группа — моей).
export default {
  id: 'rust-identity',
  file: 'vault-client/src/vault/identity.rs',
  smoke: 'cargo test -p vault-client --lib',
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
      pattern: '            .any(|(email, fp)| self.has_address(email) || self.has_fingerprint(fp))',
      replacement: '            .any(|(email, _fp)| self.has_address(email))' },
    { name: 'владение без адреса — fallback для старых записей пропал (участник без fp не виден)',
      pattern: '            .any(|(email, fp)| self.has_address(email) || self.has_fingerprint(fp))',
      replacement: '            .any(|(_email, fp)| self.has_fingerprint(fp))' },
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
  ],
};
