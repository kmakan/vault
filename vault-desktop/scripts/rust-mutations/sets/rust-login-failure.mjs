// Классификация отказа входа по IMAP (`vault-client/src/vault/login_failure.rs`).
//
// ЗАЧЕМ. До 27.10 решение «отказал ли сервер пароль» жило в JS-ветке
// `msg.includes('login failed') → delete_credentials` и ничем не мерялось. На
// живом X50 двусмысленный ответ Яндекса прошёл по этой ветке, сохранённый
// app-пароль стёрся, а восстановление стоило недель. Каждая мутация ниже —
// поломка, после которой фронт получает повод либо забыть учётную запись, либо
// соврать человеку о причине.
//
// Порядок проверок мутится отдельно от состава маркеров: «отказ пароля раньше
// двусмысленного ответа» — это ровно та ошибка, из-за которой всё и случилось.
export default {
  id: 'rust-login-failure',
  file: 'vault-client/src/vault/login_failure.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    {
      name: 'регистр ответа игнорируется — серверные CAPS не распознаются',
      pattern: '    let t = message.to_ascii_lowercase();\n',
      replacement: '    let t = message.to_string();\n',
    },
    {
      name: 'двусмысленный ответ Яндекса читается как отказ пароля',
      pattern: '        return LoginFailure::AccessDisabled;\n',
      replacement: '        return LoginFailure::PasswordRejected;\n',
    },
    {
      name: 'проверка «IMAP выключен» удалена — строка уходит в ветку отказа',
      pattern: '    if t.contains("imap is disabled") || t.contains("imap access is disabled") {\n        return LoginFailure::AccessDisabled;\n    }\n\n',
      replacement: '',
    },
    {
      name: 'троттлинг читается как отказ пароля',
      pattern: '        return LoginFailure::Throttled;\n',
      replacement: '        return LoginFailure::PasswordRejected;\n',
    },
    {
      name: 'проверка троттлинга удалена',
      pattern: '    if t.contains("too many")\n        || t.contains("rate limit")\n        || t.contains("temporarily blocked")\n        || t.contains("temporarily unavailable")\n        || t.contains("try again later")\n    {\n        return LoginFailure::Throttled;\n    }\n\n',
      replacement: '',
    },
    {
      name: 'маркер «rate limit» потерян',
      pattern: '        || t.contains("rate limit")\n',
      replacement: '',
    },
    {
      name: 'маркер «temporarily blocked» потерян',
      pattern: '        || t.contains("temporarily blocked")\n',
      replacement: '',
    },
    {
      name: 'транспорт читается как отказ пароля',
      pattern: '        return LoginFailure::Transport;\n',
      replacement: '        return LoginFailure::PasswordRejected;\n',
    },
    {
      name: 'проверка транспорта удалена',
      pattern: '    if t.contains("failed to connect")\n        || t.contains("failed tls handshake")\n        || t.contains("connection reset")\n        || t.contains("timed out")\n        || t.contains("timeout")\n        || t.contains("name or service not known")\n        || t.contains("network is unreachable")\n    {\n        return LoginFailure::Transport;\n    }\n\n',
      replacement: '',
    },
    {
      name: 'маркер «timed out» потерян — ожидание становится «не знаю»',
      pattern: '        || t.contains("timed out")\n',
      replacement: '',
    },
    {
      name: 'проверка отказа пароля удалена — приговор исчезает совсем',
      pattern: '    if t.contains("authenticationfailed")\n        || t.contains("authentication failed")\n        || t.contains("invalid credentials")\n        || t.contains("invalid username or password")\n        || t.contains("username or password")\n        || t.contains("cannot log in")\n        || t.contains("login failed")\n    {\n        return LoginFailure::PasswordRejected;\n    }\n',
      replacement: '',
    },
    {
      name: 'отказ пароля узнаётся только по «login failed»',
      pattern: '    if t.contains("authenticationfailed")\n        || t.contains("authentication failed")\n        || t.contains("invalid credentials")\n        || t.contains("invalid username or password")\n        || t.contains("username or password")\n        || t.contains("cannot log in")\n        || t.contains("login failed")\n',
      replacement: '    if t.contains("login failed")\n',
    },
    {
      name: 'маркер «cannot log in» потерян',
      pattern: '        || t.contains("cannot log in")\n',
      replacement: '',
    },
    {
      name: 'нераспознанный текст получает приговор вместо «не знаю»',
      pattern: '    LoginFailure::Unknown\n}\n',
      replacement: '    LoginFailure::PasswordRejected\n}\n',
    },
    {
      name: 'код вердикта рассинхронизирован с фронтом («IMAP выключен» = «auth»)',
      pattern: '            LoginFailure::AccessDisabled => "disabled",\n',
      replacement: '            LoginFailure::AccessDisabled => "auth",\n',
    },
    {
      name: 'код вердикта рассинхронизирован с фронтом («троттлинг» = «auth»)',
      pattern: '            LoginFailure::Throttled => "throttled",\n',
      replacement: '            LoginFailure::Throttled => "auth",\n',
    },
  ],
};
