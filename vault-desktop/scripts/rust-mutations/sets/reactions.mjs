// Набор мутаций: реакции (Rust-ядро).
//
// Правила: эмодзи валиден, если непустой, до 4 code points и без пробелов;
// одна и та же пара (emoji, user) не добавляется дважды; снятие реакции
// сообщает, была ли она; при удалении последней реакции запись сообщения
// убирается из карты.
export default {
  id: 'reactions',
  file: 'vault-client/src/vault/reactions.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'пустой эмодзи принимается (реакция без символа)',
      pattern: '        !emoji.is_empty() && emoji.chars().count() <= 4 && !emoji.contains(char::is_whitespace)',
      replacement: '        emoji.chars().count() <= 4 && !emoji.contains(char::is_whitespace)' },
    { name: 'слишком длинный эмодзи принимается (>4 code points)',
      pattern: '        !emoji.is_empty() && emoji.chars().count() <= 4 && !emoji.contains(char::is_whitespace)',
      replacement: '        !emoji.is_empty() && !emoji.contains(char::is_whitespace)' },
    { name: 'эмодзи с пробелом принимается',
      pattern: '        !emoji.is_empty() && emoji.chars().count() <= 4 && !emoji.contains(char::is_whitespace)',
      replacement: '        !emoji.is_empty() && emoji.chars().count() <= 4' },
    { name: 'дубль реакции добавляется (двойная реакция от одного пользователя)',
      pattern: '        if !cur.iter().any(|r| r.emoji == emoji && r.user == user) {',
      replacement: '        if true {' },
    { name: 'реакция от другого пользователя не снимается (удаляют чужую)',
      pattern: '            let idx = cur.iter().position(|r| r.emoji == emoji && r.user == user);',
      replacement: '            let idx = cur.iter().position(|r| r.emoji == emoji);' },
    { name: 'пустая запись реакций не удаляется (мусор в карте чата)',
      pattern: '            if cur.is_empty() {\n                chat_store.remove(msg_id);\n            }',
      replacement: '            if false {\n                chat_store.remove(msg_id);\n            }' },
    { name: 'снятие реакции всегда сообщает «снято» (даже если её не было)',
      pattern: '        Ok(before > after)',
      replacement: '        Ok(true)' },
  ],
};
