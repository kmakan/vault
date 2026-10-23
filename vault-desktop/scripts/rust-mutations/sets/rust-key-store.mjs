// Набор мутаций: rust-key-store — форма адреса в хранилище ключей.
//
// ЗАЧЕМ. `vault-core` — общий слой хранилищ CLI и моста — до этой партии не
// мерился НИ ОДНОЙ мутацией: гейт был зашит на `vault-client`. При этом в
// `key_store.rs` жили четыре копии адресного правила:
//   * гейт `em.to_lowercase().starts_with("fp:")` — форма адреса решалась
//     здесь заново, а не ядром;
//   * переименование `eq_ignore_ascii_case` — «Боб@Почта.ру» и
//     «боб@почта.ру» считались разными адресами (кириллица не понижается);
//   * дедуп `k.email == key.email` — тот же адрес в другом написании заводил
//     ВТОРУЮ запись с другим публичным ключом;
//   * удаление `retain(|k| k.email != email)` — контакт по нормальной форме
//     не находился, ключ оставался.
// Теперь правило одно (`crate::identity`), а мутации ниже — ровно те четыре
// дефекта: если кто-то вернёт сравнение адреса на место, тест это поймает.
export default {
  id: 'rust-key-store',
  crate: 'vault-core',
  file: 'vault-core/src/key_store.rs',
  smoke: 'cargo test -p vault-core --lib',
  mutations: [
    { name: 'адресный гейт выключен (fp:-ключ и строка без @ снова становятся контактами)',
      pattern: '    if !identity::is_contact_address(&key.email) {',
      replacement: '    if false {' },
    { name: 'гейт решает форму сам, без нормализации (FP: в верхнем регистре и обрамление проходят)',
      pattern: '    if !identity::is_contact_address(&key.email) {',
      replacement: '    if !key.email.trim().contains(\'@\') || key.email.trim().starts_with("fp:") {' },
    { name: 'переименование при смене почты потеряно (новый адрес не заменяет старый)',
      pattern: '        if !identity::same_address(&keys[idx].email, &key.email) {',
      replacement: '        if false {' },
    { name: 'переименование срабатывает на тот же адрес (написание записи переписывается зря)',
      pattern: '        if !identity::same_address(&keys[idx].email, &key.email) {',
      replacement: '        if true {' },
    { name: 'переименование сравнивает ASCII-регистр (кириллический адрес выглядит как новый)',
      pattern: '        if !identity::same_address(&keys[idx].email, &key.email) {',
      replacement: '        if !keys[idx].email.eq_ignore_ascii_case(&key.email) {' },
    { name: 'дедуп по точному адресу (одно написание заводит вторую запись с другим ключом)',
      pattern: '        .find(|k| identity::same_address(&k.email, &key.email))',
      replacement: '        .find(|k| k.email == key.email)' },
    { name: 'удаление по точному адресу (контакт по нормальной форме не находится)',
      pattern: '    keys.retain(|k| !identity::same_address(&k.email, email));',
      replacement: '    keys.retain(|k| k.email != email);' },
    { name: 'удаление перевёрнуто (удаляются все, кроме запрошенного)',
      pattern: '    keys.retain(|k| !identity::same_address(&k.email, email));',
      replacement: '    keys.retain(|k| identity::same_address(&k.email, email));' },
  ],
};
