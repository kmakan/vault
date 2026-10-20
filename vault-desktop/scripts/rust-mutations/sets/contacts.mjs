// Набор мутаций: контакты (Rust-ядро).
//
// Правила контакта: fingerprint считается из ПУБЛИЧНОГО ключа (16 байт
// SHA-256, hex через «:») и сверяется при проверке подлинности; «в сети» —
// последняя активность не старше 5 минут; отметка проверки ставится и
// снимается вместе с временем; тег группы не дублируется.
//
// ПРИМЕЧАНИЕ. Мутация «контакт без ключа считается проверенным» УБРАНА как
// эквивалентная: без раннего выхода сверка идёт по compute_fingerprint("") —
// это хеш пустого ключа, тогда как stored fingerprint у контакта без ключа
// пустой, то есть сверка и так даёт false.
export default {
  id: 'contacts',
  file: 'vault-client/src/vault/contacts.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'fingerprint считается по 8 байтам вместо 16 (совпадения ломаются)',
      pattern: '        hash[..16]',
      replacement: '        hash[..8]' },
    { name: 'fingerprint без разделителей (формат для сверки сломан)',
      pattern: '            .join(":")',
      replacement: '            .join("")' },
    { name: 'публичный ключ не сверяется (любой fingerprint считается верным)',
      pattern: '        self.fingerprint == Self::compute_fingerprint(&self.public_key)',
      replacement: '        true' },

    { name: '«в сети» — до 5 часов вместо 5 минут (мёртвый контакт светится)',
      pattern: '                return diff.num_minutes() < 5;',
      replacement: '                return diff.num_minutes() < 300;' },
    { name: 'снятие проверки не чистит время проверки',
      pattern: '        self.is_verified = false;\n        self.last_verified = None;',
      replacement: '        self.is_verified = false;' },
    { name: 'тег группы добавляется дважды',
      pattern: '        if !self.groups.contains(&group.to_string()) {\n            self.groups.push(group.to_string());\n        }',
      replacement: '        self.groups.push(group.to_string());' },
    { name: 'тег группы не снимается',
      pattern: '        self.groups.retain(|g| g != group);',
      replacement: '        self.groups.retain(|_| true);' },
  ],
};
