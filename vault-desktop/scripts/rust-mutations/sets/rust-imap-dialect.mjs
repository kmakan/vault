// Набор мутаций: rust-imap-dialect — как понимать ответы провайдера.
//
// ЗАЧЕМ. Класс «папки нет» ≠ «сеть упала» определяет, крутится ли лестница
// backoff. Нераспознанная формулировка = сетевой сбой = почта встаёт целиком:
// живые случаи — Gmail/Zoho 22.10.2026 (streak=150, «reconnect deferred»
// каждые 3 мс, письма не приходили вообще, включая сигнал звонка) и
// X50 04.10.2026 (0.1.211). Правило LOGIN-алиаса (@ya.com) — тот же класс:
// оно решает, авторизуемся мы bare-логином или адресом.
export default {
  id: 'rust-imap-dialect',
  file: 'vault-client/src/vault/imap_dialect.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'формулировка Zoho/Gmail «Unknown Mailbox» выпала из таблицы',
      pattern: '        || t.contains("unknown mailbox")\n',
      replacement: '' },
    { name: 'формулировка «does not exist» выпала из таблицы',
      pattern: '        || t.contains("does not exist")\n',
      replacement: '' },
    { name: 'распознанный признак помечается как сетевой сбой (backoff на пустой папке)',
      pattern: '        return Some(ImapFailure::MailboxAbsent);',
      replacement: '        return Some(ImapFailure::Network);' },
    { name: 'цепочка источников не просматривается (признак под anyhow::Context теряется)',
      pattern: '    for text in sources {\n        if let Some(v) = failure_of_text(text) {\n            return v;\n        }\n    }',
      replacement: '    for _text in sources {\n        continue;\n    }' },
    { name: 'алиасный домен @ya.com больше не даёт bare-логин (AUTHENTICATIONFAILED)',
      pattern: '    if ALIAS_DOMAINS.iter().any(|d| lower.ends_with(d)) {',
      replacement: '    if false {' },
    { name: 'домен сравнивается с учётом регистра (@YA.COM не узнаётся)',
      pattern: '    let lower = email.to_ascii_lowercase();',
      replacement: '    let lower = email.to_string();' },
  ],
};
