// Набор мутаций: выдача временных TURN-кредов (vault-relay/src/turn.rs).
//
// ЗАЧЕМ. Формула пары `(username, credential)` — внешний контракт с coturn:
// ошиблись в HMAC, в сроке или в порядке полей — и Allocate отвергается, а
// вместе с ним умирает единственный способ позвонить вне одной подсети.
// Симптом при этом на клиенте молчаливый: «звонок не соединяется», а не
// «креды битые». Поэтому каждая строка решения меряется отдельной мутацией.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ:
//   * `TurnConfig::from_env` — снятие ветки «пустой секрет = None» даёт тот же
//     результат (пары с пустым секретом coturn не принимает), мутант
//     эквивалентный;
//   * величины `CRED_TTL` как число — тест сверяет ответ с константой, а не с
//     требованием «1 час» (соглашение с coturn), замена выживет честно;
//   * квота — её здесь нет: выдача тратит общий бюджет релея, и он меряется
//     в rust-relay-turn-api (ключ счётчика и порог) и rust-relay-limit
//     (сами числа тарифа).
export default {
  id: 'rust-relay-turn',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/turn.rs',
  smoke: 'cargo test -p vault-relay --lib turn',
  timeoutMs: 600_000,
  mutations: [
    // ── username: `<истечение>:<метка>` ──
    { name: 'срок не продлевается на TTL (пара протухает в момент выдачи)',
      pattern: '    format!("{}:{}", now + ttl, tag)',
      replacement: '    format!("{}:{}", now, tag)' },
    { name: 'метка аккаунта не в username (квоту и жреца relay не отличить)',
      pattern: '    format!("{}:{}", now + ttl, tag)',
      replacement: '    format!("{}:{}", now + ttl, "anon")' },
    // ── credential: base64(HMAC-SHA1(secret, username)) ──
    { name: 'HMAC считается от секрета, а не от username (coturn отвергает все пары)',
      pattern: '    mac.update(username.as_bytes());',
      replacement: '    mac.update(secret.as_bytes());' },
    { name: 'credential не base64, а сырые байты (клиент получает мусор)',
      pattern: '    B64.encode(mac.finalize().into_bytes())',
      replacement: '    String::from_utf8_lossy(&mac.finalize().into_bytes()).to_string()' },
    // ── TURN-URL’ы клиента ──
    { name: 'порт UDP-listenера потерян (webrtc-rs не понимает URL без порта)',
      pattern: '        format!("turn:{host}:3478"),',
      replacement: '        format!("turn:{host}"),' },
    { name: 'TCP-страховка превращается в дубль UDP (сети без UDP остаются без relay)',
      pattern: '        format!("turn:{host}:3478?transport=tcp"),',
      replacement: '        format!("turn:{host}:3478"),' },
  ],
};
