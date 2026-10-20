// Набор мутаций: маркеры wire-протокола Vault (Rust-ядро).
//
// Тема и тело помечаются служебными маркерами (`[VAULT]`, `X-Vault-Encrypted: 1`,
// `Message-ID:`). По ним получатель отличает наши письма от чужих, а по
// `Message-ID` — дедуплицирует переотправку. Поломка маркера означает либо
// «наши письма перестали распознаваться» (тишина в чате), либо «чужие письма
// начали распознаваться как наши» (попытка расшифровать чужое).
export default {
  id: 'filter',
  file: 'vault-client/src/vault/filter.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'маркер в теле перестаёт распознаваться (наши письма не видны)',
      pattern: '            .contains(&format!("{}: {}", VAULT_HEADER, VAULT_VERSION));',
      replacement: '            .contains(&format!("{}: {}", VAULT_HEADER, VAULT_VERSION)) && false;' },
    { name: 'тема [VAULT] больше не признаётся',
      pattern: '        let subject_has_marker = msg.subject.starts_with(VAULT_SUBJECT_PREFIX);',
      replacement: '        let subject_has_marker = false;' },
    { name: 'квитанция не отличается от обычного письма',
      pattern: '        msg.subject.starts_with(VAULT_RECEIPT_PREFIX)',
      replacement: '        false' },
    { name: 'префикс квитанции не срезается (в заголовке остаётся мусор)',
      pattern: '            .or_else(|| subject.strip_prefix(VAULT_RECEIPT_PREFIX))',
      replacement: '            .or_else(|| None)' },
    { name: 'Message-ID не извлекается (дедуп переотправки слепнет)',
      pattern: '            .find(|line| line.starts_with("Message-ID:"))',
      replacement: '            .find(|line| false)' },
    { name: 'версия маркера в теле изменена (письма не распознаются)',
      pattern: 'pub const VAULT_VERSION: &str = "1";',
      replacement: 'pub const VAULT_VERSION: &str = "2";' },
    { name: 'фильтр пропускает обычные письма',
      pattern: '            .filter(|m| Self::is_vault_message(m))',
      replacement: '            .filter(|_| true)' },
    { name: 'exclude_vault исключает и наши письма',
      pattern: '        messages.iter().filter(|m| !Self::is_vault_any(m)).collect()',
      replacement: '        messages.iter().filter(|_| true).collect()' },
  ],
};
