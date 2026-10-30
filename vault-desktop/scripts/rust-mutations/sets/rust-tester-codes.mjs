// Набор мутаций: rust-tester-codes — персональный код тестера.
//
// ЗАЧЕМ. Код — bearer-секрет, по которому выдаётся безлимитный тестовый токен
// на ограниченный срок. Правила, которые нельзя «увидеть глазами»: канон кода
// (регистр, пробелы, обязательный префикс, hex и длина), хеширование ИМЕННО
// канона (иначе тот же код в другом регистре — другой ключ в state, и отзыв по
// одному написанию не гасит другое), срок по умолчанию (полгода) с клампом в
// [1, 3650], и правило claim: отзыв важнее привязки, чужой fp не проходит,
// свой — тот же (без регистра).
//
// Что осталось неизмеримым осознанно: 128 бит энтропии из OsRng — тест ловит
// только форму (префикс/длина/различие двух вызовов), не качество ГПСЧ;
// уникальность кодов в вероятностном смысле мутацией не проверить.
export default {
  id: 'rust-tester-codes',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/test_codes.rs',
  smoke: 'cargo test -p vault-relay --lib test_codes',
  timeoutMs: 600_000,
  mutations: [
    { name: 'код выдаётся на 8 байт энтропии (64 бита — перебор реален)',
      pattern: '    let mut raw = [0u8; 16];',
      replacement: '    let mut raw = [0u8; 8];' },
    { name: 'канон не приводит регистр (VT1-… и vt1-… — разные коды)',
      pattern: '    let lowered = raw.trim().to_ascii_lowercase();',
      replacement: '    let lowered = raw.trim().to_string();' },
    { name: 'пробелы вокруг кода не срезаются (вставка из чата не работает)',
      pattern: '    let lowered = raw.trim().to_ascii_lowercase();',
      replacement: '    let lowered = raw.to_ascii_lowercase();' },
    { name: 'префикс кода не обязателен (общий промо-ключ принимают за код)',
      pattern: '    let body = lowered.strip_prefix(CODE_PREFIX)?;',
      replacement: '    let body = lowered.as_str();' },
    { name: 'hex не проверяется (мусор в hex-части даёт «валидный» код)',
      pattern: '    if !body.bytes().all(|b| b.is_ascii_hexdigit()) {\n        return None;\n    }',
      replacement: '    if false {\n        return None;\n    }' },
    { name: 'хешируется сырой ввод, а не канон (два написания = два ключа в state)',
      pattern: '    h.update(norm.as_bytes());',
      replacement: '    h.update(code.as_bytes());' },
    { name: 'срок по умолчанию — месяц, а не полгода',
      pattern: '    requested.unwrap_or(DEFAULT_DAYS).clamp(MIN_DAYS, MAX_DAYS)',
      replacement: '    requested.unwrap_or(30).clamp(MIN_DAYS, MAX_DAYS)' },
    { name: 'нижняя граница срока снята (0 дней = уже истёкший токен)',
      pattern: '    requested.unwrap_or(DEFAULT_DAYS).clamp(MIN_DAYS, MAX_DAYS)',
      replacement: '    requested.unwrap_or(DEFAULT_DAYS).clamp(0, MAX_DAYS)' },
    { name: 'верхняя граница срока снята (код «на полгода» можно выдать на 100 лет)',
      pattern: '    requested.unwrap_or(DEFAULT_DAYS).clamp(MIN_DAYS, MAX_DAYS)',
      replacement: '    requested.unwrap_or(DEFAULT_DAYS).clamp(MIN_DAYS, 999_999)' },
    { name: 'отзыв кода игнорируется (отозванный безлимит выдаётся снова)',
      pattern: '    if record.revoked {\n        return Claim::Revoked;\n    }',
      replacement: '    if false {\n        return Claim::Revoked;\n    }' },
    { name: 'чужой fp проходит как свой (код тестера достаётся второму аккаунту)',
      pattern: '        Some(_) => Claim::Other,',
      replacement: '        Some(_) => Claim::Same,' },
    { name: 'fp сравнивается с регистром (AA:BB и aa:bb — разные аккаунты)',
      pattern: '        Some(bound) if bound.eq_ignore_ascii_case(fp) => Claim::Same,',
      replacement: '        Some(bound) if bound == fp => Claim::Same,' },
  ],
};
