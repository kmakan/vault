// Набор мутаций: подпись постов канала на клиенте (src-tauri/src/channel_signing.rs).
//
// ЗАЧЕМ. Это второй конец того же контракта ADR-002: канонический поток
// `channel-post:v2\0 ‖ kid_be ‖ env_id ‖ body` собирают здесь владелец, а на
// релее — проверяющий (vault-relay/src/channel_keys.rs, измерен 25.10 — 15/15).
// Расхождение сторон молчит до первого поста: подпись просто перстаёт быть
// валидной, и «публикует только владелец» превращается в «публикует никто».
// Поэтому здесь меряется не только логика, но и Совместимость с релеем — через
// общий вектор `shared_vector_with_relay` (то же значение проверяет тест
// `shared_vector_matches_client` на релее).
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (проверено чтением кода, 25.10):
//   * `verify_strict` → `verify` — разница видна только на неканонической
//     (malleated) подписи, взять её в тесте негде: это свойство держится
//     выбором метода, а не проверкой, и выдавать его за покрытие нельзя;
//   * `s.len() != 64 || !is_ascii_hexdigit` в hex_to_32 — следующий
//     `hex::decode_to_slice` в [u8; 32] сам отвергает и другую длину, и не-hex
//     (проверено на обоих существующих кейсах): эквивалентный мутант;
//   * `pk.len() != 32` в verify — мутируется (снимет проверку длины ключа),
//     дублировать её инверсию вторым мутантом смысла нет.
export default {
  id: 'rust-bridge-channel-signing',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/channel_signing.rs',
  smoke: 'cargo test -p vault-desktop --lib channel_signing',
  timeoutMs: 600_000,
  mutations: [
    // ── канонический поток: обязан совпадать с релеем байт-в-байт ──
    { name: 'домен подписи сдвинут на v1 (клиент подписывает не то, что проверяет релей)',
      pattern: 'const DOMAIN: &[u8] = b"channel-post:v2\\0";',
      replacement: 'const DOMAIN: &[u8] = b"channel-post:v1\\0";' },
    { name: 'kid кладётся little-endian (общий вектор с релеем расходится)',
      pattern: '    buf.extend_from_slice(&kid.to_be_bytes());',
      replacement: '    buf.extend_from_slice(&kid.to_le_bytes());' },
    { name: 'env_id и body склеены в обратном порядке (подпись не привязана к паре)',
      pattern: '    buf.extend_from_slice(env_id.as_bytes());\n    buf.extend_from_slice(body.as_bytes());',
      replacement: '    buf.extend_from_slice(body.as_bytes());\n    buf.extend_from_slice(env_id.as_bytes());' },
    // ── форма подписи и ключа в протоколе ──
    { name: 'подпись кодируется стандартным base64 (релей читает url-safe без паддинга)',
      pattern: '    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)',
      replacement: '    base64::engine::general_purpose::STANDARD.encode(data)' },
    { name: 'url-safe подпись не декодируется (проверка на клиенте глохнет)',
      pattern: '    base64::engine::general_purpose::URL_SAFE_NO_PAD\n        .decode(s)\n        .ok()',
      replacement: '    base64::engine::general_purpose::STANDARD\n        .decode(s)\n        .ok()' },
    { name: 'длина публичного ключа проверена наоборот (валидный ключ отвергается)',
      pattern: '    if pk.len() != 32 {',
      replacement: '    if pk.len() == 32 {' },
    { name: 'длина подписи проверена наоборот (валидная подпись отвергается)',
      pattern: '    if sig_raw.len() != 64 {',
      replacement: '    if sig_raw.len() == 64 {' },
    // ── чтение приватного ключа ──
    { name: 'пробелы вокруг ключа из файла делают его непригодным (импорт падает)',
      pattern: '    let s = s.trim();',
      replacement: '    let s = s;' },
    { name: 'публичный ключ отдаётся равным приватному (регистрация сливает секрет)',
      pattern: '    Ok(hex::encode(sk.verifying_key().to_bytes()))',
      replacement: '    Ok(hex::encode(seed))' },
    { name: 'генерация пишет в поле privateHex публичный ключ (подпись невозможна)',
      pattern: '        hex::encode(seed),',
      replacement: '        hex::encode(sk.verifying_key().to_bytes()),' },
  ],
};
