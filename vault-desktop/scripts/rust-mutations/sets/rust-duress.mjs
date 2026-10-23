// Набор мутаций: rust-duress — параметры PBKDF2 замка и форма `salt:hash`.
//
// ЗАЧЕМ. PIN/duress-код — протокол: итерации, длины соли и ключа уже записаны
// в сохранённых хэшах, а форму `salt:hash` читает и Kotlin-замок, и JS-замок.
// Round-trip внутри одной версии такого дрейфа не видит: hash_secret и
// verify_secret согласованы сами с собой, а старые PIN-ы молча перестают
// подходить. Поэтому здесь есть KAT с фиксированной солью и
// parameters_match_protocol, и набор требует, чтобы поломка была поймана.
export default {
  id: 'rust-duress',
  file: 'vault-client/src/vault/duress.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'итерации PBKDF2 уменьшены (старые PIN-ы перестают проверяться)',
      pattern: 'pub const ITERATIONS: u32 = 10_000;',
      replacement: 'pub const ITERATIONS: u32 = 9_999;' },
    { name: 'длина соли изменена (форма salt:hash расходится с сохранёнными)',
      pattern: 'pub const SALT_LEN: usize = 16;',
      replacement: 'pub const SALT_LEN: usize = 8;' },
    { name: 'длина ключа изменена (хэш другой длины не сравнится со старым)',
      pattern: 'pub const KEY_LEN: usize = 32;',
      replacement: 'pub const KEY_LEN: usize = 31;' },
    { name: 'лишняя итерация в цепочке U_i (KAT расходится, старые PIN-ы не подходят)',
      pattern: '        for _ in 1..iterations {',
      replacement: '        for _ in 0..iterations {' },
    { name: 'XOR-накопление сломано (U_i не складываются в хэш)',
      pattern: '                *tb ^= ub;',
      replacement: '                *tb ^= 0u8;' },
    { name: 'соль не случайна (у двух хэшей одного PIN-а одна соль)',
      pattern: '    rand::thread_rng().fill_bytes(&mut salt);',
      replacement: '    salt = [7u8; SALT_LEN];' },
    { name: 'сравнение всегда «совпало» (любой код открывает замок)',
      pattern: '    diff == 0',
      replacement: '    diff == 0 || true' },
    { name: 'блок-счётчик PBKDF2 стал 8-байтовым (KAT расходится)',
      pattern: '        mac.update(&block_index.to_be_bytes());',
      replacement: '        mac.update(&(block_index as u64).to_be_bytes());' },
    { name: 'секрет не участвует в выводе (разные коды дают один хэш)',
      pattern: '    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, ITERATIONS, &mut out);',
      replacement: '    pbkdf2_hmac_sha256(b"", &salt, ITERATIONS, &mut out);' },
  ],
};
