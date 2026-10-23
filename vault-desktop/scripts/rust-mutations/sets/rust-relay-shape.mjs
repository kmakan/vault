// Набор мутаций: rust-relay-shape — форма адресов виртуальных писем релея.
//
// ЗАЧЕМ. На вопрос «это письмо вообще существует на IMAP?» у CLI (`listen.rs`,
// `repl.rs`) и десктопного моста было ДВА ответа: `id.starts_with("rl-")`
// против `!is_imap_uid(id)`. Пока правила жили порознь, мост ходил на сервер
// по псевдоuid `rl-…`: `UID FETCH` пуст → «рассинхрон сессии» → reconnect по
// лестнице backoff → висевшая отправка, хотя письмо уже пришло релеем. Здесь
// проверяется, что тесты ядра реально держат обе формы и их согласование.
export default {
  id: 'rust-relay-shape',
  file: 'vault-client/src/vault/relay.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'пустая строка считается настоящим uid («undefined»/пустой id уходит на FETCH)',
      pattern: '    !uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit())',
      replacement: '    uid.bytes().all(|b| b.is_ascii_digit())' },
    { name: 'любая непустая строка считается uid (конверт «rl-…» идёт на сервер → reconnect-шторм)',
      pattern: '    !uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit())',
      replacement: '    !uid.is_empty()' },
    { name: 'папка RELAY сравнивается с учётом регистра (фронт шлёт «relay» → SELECT на IMAP)',
      pattern: '    folder.eq_ignore_ascii_case(VIRTUAL_FOLDER)',
      replacement: '    folder == VIRTUAL_FOLDER' },
    { name: 'папка опознаётся по подстроке (INBOX/RELAYX ушёл бы в виртуальный путь)',
      pattern: '    folder.eq_ignore_ascii_case(VIRTUAL_FOLDER)',
      replacement: '    folder.to_ascii_uppercase().contains(VIRTUAL_FOLDER)' },
    { name: 'виртуальный id ищется по суффиксу (конверт перестаёт узнаваться, тело читается с IMAP)',
      pattern: '    id.starts_with(VIRTUAL_ID_PREFIX)',
      replacement: '    id.ends_with(VIRTUAL_ID_PREFIX)' },
    { name: 'префикс виртуального id изменён (CLI и десктоп расходятся в форме адреса)',
      pattern: 'pub const VIRTUAL_ID_PREFIX: &str = "rl-";',
      replacement: 'pub const VIRTUAL_ID_PREFIX: &str = "relay-";' },
    { name: 'id конверта строится без префикса (is_virtual_id его не опознаёт)',
      pattern: '    format!("{VIRTUAL_ID_PREFIX}{env_id}")',
      replacement: '    format!("{env_id}")' },
  ],
};
