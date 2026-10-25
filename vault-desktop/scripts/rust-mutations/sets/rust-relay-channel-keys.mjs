// Набор мутаций: ключи подписи постов канала (vault-relay/src/channel_keys.rs).
//
// ЗАЧЕМ. Канальный токен — bearer-credential, который сервер проверить не
// может, поэтому «публикует только владелец» держится на Ed25519-подписи
// конверта и на политике регистрации ключа. Обе вещи — протокольные решения
// (ADR-002), и каждое из них можно молча снять одной строкой: канонический
// поток подписи, алфавит подписи, «только read-токен канала», «только живой
// личный токен», форма kid в карте, требование подписи в режиме REQUIRE_SIG.
// Тестов здесь было много (11), мутационной мерки — ни одной: дыра из
// ратчета плотности 25.10, очередь t_a134786c.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (проверено чтением кода, 25.10):
//   * `sig_raw.len() != 64` — следующий `Signature::from_slice` сам отвергает
//     любую другую длину, поэтому и инверсия, и снятие проверки дают то же
//     поведение на всех достижимых входах: эквивалентный мутант;
//   * `verify_strict` → `verify` (неканонические подписи) — чтобы увидеть
//     разницу, нужна подпись, полученная вне этого набора (malleated), её
//     здесь не от кого принять: это свойство держится выбором метода, а не
//     тестом, и в набор оно не включено, чтобы не выдавать декорацию за
//     покрытие;
//   * `hex_decode32` после `decide_registration` — та же форма проверки,
//     но уже на хранящемся ключе: мутируется отдельно (trim), дублировать
//     длину/алфавит смысла нет.
export default {
  id: 'rust-relay-channel-keys',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/channel_keys.rs',
  smoke: 'cargo test -p vault-relay --lib channel_keys',
  timeoutMs: 600_000,
  mutations: [
    // ── канонический поток подписи (обязан совпадать с клиентом байт-в-байт) ──
    { name: 'домен подписи сдвинут с v2 на v1 (клиент и сервер подписывают разные байты)',
      pattern: '    buf.extend_from_slice(b"channel-post:v2\\0");',
      replacement: '    buf.extend_from_slice(b"channel-post:v1\\0");' },
    { name: 'kid кладётся little-endian (общий вектор с клиентом расходится)',
      pattern: '    buf.extend_from_slice(&kid.to_be_bytes());',
      replacement: '    buf.extend_from_slice(&kid.to_le_bytes());' },
    { name: 'env_id и body склеены в обратном порядке (подпись не привязана к паре)',
      pattern: '    buf.extend_from_slice(env_id.as_bytes());\n    buf.extend_from_slice(body.as_bytes());',
      replacement: '    buf.extend_from_slice(body.as_bytes());\n    buf.extend_from_slice(env_id.as_bytes());' },
    // ── разбор подписи ──
    { name: 'подпись в url-safe алфавите не читается (общий вектор падает)',
      pattern: '    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()',
      replacement: '    base64::engine::general_purpose::STANDARD.decode(s).ok()' },
    { name: 'длина подписи проверена наоборот (правильная подпись отвергается)',
      pattern: '    if sig_raw.len() != 64 {',
      replacement: '    if sig_raw.len() == 64 {' },
    { name: 'пробелы в сохранённом ключе ломают проверку (ключ из JSON не читается)',
      pattern: '    let s = s.trim();',
      replacement: '    let s = s;' },
    // ── политика: что считать подписью вообще ──
    { name: 'REQUIRE_SIG не закрывает незарегистрированный канал (флаг ничего не значит)',
      pattern: '            if require_sig {',
      replacement: '            if false {' },
    { name: 'зарегистрированный канал без подписи принимается (подписчик публикует без ключа)',
      pattern: '            None => Verdict::Invalid,',
      replacement: '            None => Verdict::Unregistered,' },
    // ── политика регистрации ──
    { name: 'личным считается любой scope (канальный токен регистрирует чужую очередь)',
      pattern: "    if !matches!(os, 'r' | 'w') {",
      replacement: '    if false {' },
    { name: 'протухший личный токен принимается (право на ключ не проверяется)',
      pattern: '    if owner_expired {',
      replacement: '    if false {' },
    { name: 'write-токен канала принимается как адрес очереди',
      pattern: "    if cs != 'c' {",
      replacement: '    if false {' },
    { name: 'kid канала не обязателен (регистрация ложится на нулевую очередь)',
      pattern: '    let Some(kid) = chan_kid else {\n        return bad(400, "bad channel token");\n    };',
      replacement: '    let kid = chan_kid.unwrap_or(0);' },
    { name: 'форма pubkey не проверяется (мусор вместо ключа уходит в карту)',
      pattern: "    if pk.len() != 64 || !pk.chars().all(|c| c.is_ascii_hexdigit()) {",
      replacement: '    if false {' },
    { name: 'пробелы в pubkey при регистрации отвергаются (вставка из буфера обмена = 400)',
      pattern: '    let pk = pubkey.trim();',
      replacement: '    let pk = pubkey;' },
    { name: 'kid в карте хранится hex-строкой (проверка ищет не тот ключ)',
      pattern: '    Accept { kid: kid.to_string() }',
      replacement: '    Accept { kid: format!("{:016x}", kid) }' },
  ],
};
