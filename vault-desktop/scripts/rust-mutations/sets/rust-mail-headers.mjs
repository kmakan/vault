// Набор мутаций: rust-mail-headers — разбор заголовков письма.
//
// ЗАЧЕМ. `extract_header` был скопирован дословно в двух местах (мост
// `src-tauri/src/email.rs` и CLI `api/email.rs`). Заголовок — это то, откуда
// берутся From/To (ключ шифрования и идентификация собеседника) и Message-ID
// (ключ дедупликации): «значение не то» = письмо приписано не тому чату или
// дублируется в ленте.
export default {
  id: 'rust-mail-headers',
  file: 'vault-client/src/vault/mail_headers.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'поле ищется по подстроке (X-From/IP spoof перехватывает значение From)',
      pattern: '        .find(|line| line.to_ascii_lowercase().starts_with(&prefix))',
      replacement: '        .find(|line| line.to_ascii_lowercase().contains(&prefix))' },
    { name: 'регистр имени поля учитывается (заголовок «from:» не находится)',
      pattern: '    let key = name.trim().trim_end_matches(\':\').to_ascii_lowercase();',
      replacement: '    let key = name.trim().trim_end_matches(\':\').to_string();' },
    { name: 'значение берётся до ПЕРВОГО двоеточия строки (Date/Subject с «:» обрезаются)',
      pattern: '        .and_then(|line| line.splitn(2, \':\').nth(1))',
      replacement: '        .and_then(|line| line.split(\':\').last())' },
    { name: 'пробел после двоеточия остаётся в значении (« alice@…» не совпадает с адресом чата)',
      pattern: '        .map(|v| v.trim().to_string())',
      replacement: '        .map(|v| v.to_string())' },
    { name: 'отсутствующее поле отдаёт пустую строку вместо None (мусорный адресант в БД)',
      pattern: '        .map(|v| v.trim().to_string())',
      replacement: '        .map(|v| v.trim().to_string())\n        .or_else(|| Some(String::new()))' },
  ],
};
