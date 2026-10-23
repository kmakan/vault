// Набор мутаций: rust-key-escrow — формат эскроу-архива ключей.
//
// ЗАЧЕМ. Архив уже создан на устройстве пользователя; слова — единственный
// способ его открыть. Любой дрейф вывода KEK (итерации, passphrase, доменная
// привязка, срез seed, счётчик блока) делает архив неоткрываемым, но
// wrap+unwrap внутри одной версии остаются зелёными — оба конца считают
// одинаково неверно. KAT фиксирует фактический вектор, а не учебный эталон:
// блок-счётчик в мосте был 8-байтовым, и «исправление» на 4 байта — регресс
// совместимости, который этот набор обязан ловить.
export default {
  id: 'rust-key-escrow',
  file: 'vault-client/src/vault/key_escrow.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'итерации PBKDF2 изменены (старые эскроу-письма не открываются)',
      pattern: 'pub const PBKDF2_ITERS: u32 = 2048;',
      replacement: 'pub const PBKDF2_ITERS: u32 = 2047;' },
    { name: 'passphrase изменена (KEK расходится со старыми архивами)',
      pattern: 'pub const PASSPHRASE: &str = "Vault recovery";',
      replacement: 'pub const PASSPHRASE: &str = "Vault Recovery";' },
    { name: 'доменная привязка KEK изменена (тот же seed, другой ключ)',
      pattern: '    hasher.update(b"vault-key-recovery-v1");',
      replacement: '    hasher.update(b"vault-key-recovery-v2");' },
    { name: 'блок-счётчик «исправлен» на 4 байта (старые архивы перестают открываться)',
      pattern: '        mac.update(&(block as u64).to_be_bytes());',
      replacement: '        mac.update(&(block as u32).to_be_bytes());' },
    { name: 'регистр слов не нормализуется (верные слова с заглавной отвергаются)',
      pattern: '        .map(|w| w.to_lowercase())',
      replacement: '        .map(|w| w.to_string())' },
    { name: 'проверка контрольной суммы отключена (опечатка в словах принимается)',
      pattern: '        if *bit != expect {',
      replacement: '        if false {' },
    { name: 'порядок бит слова перевёрнут (валидная мнемоника отвергается)',
      pattern: '        for b in (0..11).rev() {',
      replacement: '        for b in 0..11 {' },
    { name: 'биты энтропии упакованы задом наперёд (сумма считается по другому байту)',
      pattern: '            entropy[i / 8] |= 1 << (7 - (i % 8));',
      replacement: '            entropy[i / 8] |= 1 << (i % 8);' },
    { name: 'нормализация не схлопывает пробелы (лишние пробелы ломают восстановление)',
      pattern: '    mnemonic.split_whitespace().collect::<Vec<_>>().join(" ")',
      replacement: '    mnemonic.split_whitespace().collect::<Vec<_>>().join("  ")' },
    { name: 'проверка числа слов инвертирована (валидную мнемонику отвергает)',
      pattern: '    if words.len() != 12 {',
      replacement: '    if words.len() == 12 {' },
  ],
};
