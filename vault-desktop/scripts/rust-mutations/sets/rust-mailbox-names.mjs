// Набор мутаций: rust-mailbox-names — классификация папок по LIST.
//
// ЗАЧЕМ. Правило «эта папка — спам / «письма себе» / служебная» раньше жило
// во мосте И копией в CLI (`api/email.rs::inbox_folders`), и копии разошлись:
// в CLI не было «letters to myself», то есть слушатель не читал такую папку
// вообще. В ядре правило проверяется мутациями: каждая поломка ниже —
// потерянная папка (письма не доходят) или ложный выбор (читается Sent/All).
export default {
  id: 'rust-mailbox-names',
  file: 'vault-client/src/vault/mailbox_names.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'регистр кириллицы не учитывается (папки «Спам»/«Письма себе» теряются)',
      pattern: '    let name_l = name.to_lowercase();',
      replacement: '    let name_l = name.to_ascii_lowercase();' },
    { name: 'атрибуты не нормализуются по регистру (\\Junk не узнаётся)',
      pattern: '        attrs.iter().any(|a| a.to_lowercase() == wanted)',
      replacement: '        attrs.iter().any(|a| a == wanted)' },
    { name: 'из таблицы имён выпало русское «спам» (локализованные ящики не читаются)',
      pattern: '        || name_l == "спам"\n',
      replacement: '' },
    { name: '«письма себе» не распознаются вовсе (From==To теряется, Key Recovery молча не работает)',
      pattern: '    if name_l.ends_with("/tomyself")',
      replacement: '    if false' },
    { name: 'первая найденная папка перезаписывается следующей (выбор зависит от порядка ответа сервера)',
      pattern: '            Mailbox::Junk => {\n                if self.junk.is_none() {\n                    self.junk = Some(folder);\n                }\n            }',
      replacement: '            Mailbox::Junk => {\n                self.junk = Some(folder);\n            }' },
    { name: '\\All больше не приоритетна (папка «Вся почта» уходит в Other и не находится)',
      pattern: '    if attr("\\\\all") {\n        return Mailbox::All;\n    }\n',
      replacement: '' },
  ],
};
