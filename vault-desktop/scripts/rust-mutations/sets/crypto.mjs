// Набор мутаций: криптоядро (Rust-ядро).
//
// Здесь ошибка стоит дороже всего: ключ, fingerprint, «похоже на зашифрованное».
// Правила, которые проверяет набор:
//   * fingerprint — первые 8 байт ПУБЛИЧНОГО ключа в hex через «:» и хвост
//     `****` (формат, который релей-сервер сверяет с токеном: несовпадение =
//     403 «token bound to another account»);
//   * «похоже на зашифрованное» — длина декодированного тела не меньше
//     NONCE_LEN + 17 (nonce + тег + минимум данных) И ключ есть;
//   * ключ голоса — X25519 + HKDF-SHA256; ключи строго 32 байта.
export default {
  id: 'crypto',
  file: 'vault-client/src/crypto.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'fingerprint берётся не из публичного ключа (формат для релея сломан)',
      pattern: '                let fp: String = pub_key.as_bytes()[..8]',
      replacement: '                let fp: String = pub_key.as_bytes()[..4]' },
    { name: 'fingerprint без разделителей (релей не узнаёт формат)',
      pattern: '                    .join(":");',
      replacement: '                    .join("");' },
    { name: 'у ключа без публичной части отдаётся не пустая строка',
      pattern: '            None => "no key".to_string(),',
      replacement: '            None => String::new(),' },
    { name: '«похоже на зашифрованное» без ключа (чужой текст принимается за наш)',
      pattern: '            decoded.len() >= NONCE_LEN + 17 && self.has_keys()',
      replacement: '            decoded.len() >= NONCE_LEN + 17' },
    { name: '«похоже на зашифрованное» без проверки длины (мусор принимается)',
      pattern: '            decoded.len() >= NONCE_LEN + 17 && self.has_keys()',
      replacement: '            true' },
    { name: 'ключ голоса принимается любой длины (не 32 байта)',
      pattern: '    if my_sk.len() != 32 || peer_pk.len() != 32 {',
      replacement: '    if false {' },
    { name: 'HKDF не расширяется (ключ голоса не зависит от info)',
      pattern: '    hk.expand(info, &mut okm)',
      replacement: '    hk.expand(b"", &mut okm)' },
    { name: 'ключ голоса не зависит от ML-KEM-секрета (гибрид вырождается в X25519)',
      pattern: '    if let Some(ss) = mlkem_ss_bytes {\n        ikm.extend_from_slice(ss);\n    }',
      replacement: '    if let Some(_ss) = mlkem_ss_bytes {\n    }' },
  ],
};
