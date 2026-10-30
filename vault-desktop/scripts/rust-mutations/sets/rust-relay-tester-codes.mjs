// Набор мутаций: rust-relay-tester-codes — выдача безлимита по личному коду
// и его отзыв (main.rs).
//
// ЗАЧЕМ. Личный код — единственный способ дать тестеру безлимит на полгода
// и при этом иметь возможность этот безлимит ОТОЗВАТЬ, не задев остальных.
// Токен stateless: отзыв работает только денлистом, который обязан
// спрашиваться на каждом пути чтения/публикации. Мутируем границы доверия:
//   • код вообще распознаётся как приглашение;
//   • код без fp не выдаёт безлимит «в воздух»;
//   • отозванный код не выдаёт повторно, чужой fp по коду не проходит;
//   • приглашённый не тратит IP-квоту «3 в сутки»;
//   • срок берётся из записи кода (полгода), а не общий десятилетний;
//   • привязка fp → код и hash выданного токена записываются (иначе отзыв
//     некого гасить);
//   • денлист спрашивается при чтении, админ-роуты закрыты секретом и
//     сравнивают его постоянным временем;
//   • отзыв по коду и по fp гасит и токен, и код.
//
// Что осталось неизмеримым осознанно: «nginx не проксирует /admin» — это
// конфиг машины, а не код (проверяется живой проверкой при деплое); ротация
// VAULT_RELAY_ADMIN_KEY — операция, не ветка.
export default {
  id: 'rust-relay-tester-codes',
  crate: 'vault-relay',
  kind: 'all',
  file: 'vault-relay/src/main.rs',
  smoke: 'cargo test -p vault-relay',
  timeoutMs: 600_000,
  mutations: [
    { name: 'личный код не распознаётся (тестер получает обычный установочный токен)',
      pattern: '    let code_hash = req.promo.as_deref().and_then(test_codes::hash);',
      replacement: '    let code_hash: Option<String> = None;' },
    { name: 'код без fp выдаёт безлимит «в воздух» (нечем привязать и нечего отзывать)',
      pattern: '    if code_rec.is_some() && fp.is_none() {',
      replacement: '    if false {' },
    { name: 'отозванный код снова выдаёт безлимит',
      pattern: '            Claim::Revoked => return err(StatusCode::FORBIDDEN, "tester code revoked"),',
      replacement: '            Claim::Revoked => {}' },
    { name: 'код тестера достаётся второму аккаунту (чужой fp проходит)',
      pattern: '            Claim::Other => {\n                return err(StatusCode::CONFLICT, "tester code bound to another account")\n            }',
      replacement: '            Claim::Other => {}' },
    { name: 'приглашённый тратит IP-квоту (четвёртый тестер за сутки получает 429)',
      pattern: '    if !invite_ok {\n        let mut rl = app.registrations.lock().unwrap();',
      replacement: '    if true {\n        let mut rl = app.registrations.lock().unwrap();' },
    { name: 'срок кода игнорируется (тестеру выдаётся общий десятилетний токен)',
      pattern: '        (Kind::Test, false) => {\n            vault_relay::tokens::issue_test_days(&app.keys, now32, code_days)\n        }',
      replacement: '        (Kind::Test, false) => vault_relay::tokens::issue_test(&app.keys, now32),' },
    { name: 'код не закрепляется за fp (кодом может войти кто угодно)',
      pattern: '            rec.fp = Some(fp_ref.to_string());',
      replacement: '            rec.fp = None;' },
    { name: 'hash выданного токена не запоминается (отзыв по коду гасит пустоту)',
      pattern: '            rec.token_hash = Some(topic.clone());',
      replacement: '            rec.token_hash = None;' },
    { name: 'денлист не спрашивается (отозванный безлимит работает до конца срока)',
      pattern: '        .contains(hash)',
      replacement: '        .contains("")' },
    { name: 'админ-роуты работают без секрета (кто угодно выдаёт себе безлимит)',
      pattern: '    let Some(expected) = app.admin_key.as_deref() else {\n        return false;\n    };',
      replacement: '    let Some(expected) = app.admin_key.as_deref() else {\n        return true;\n    };' },
    { name: 'админ-ключ сравнивается без сверки содержимого (любой ключ той же длины)',
      pattern: '            .fold(0u8, |acc, (a, b)| acc | (a ^ b))',
      replacement: '            .fold(0u8, |acc, _| acc)' },
    { name: 'отзыв по коду не помечает запись (повторный ввод снова даёт безлимит)',
      pattern: '                    rec.revoked = true;\n                    rec.token_hash.clone()',
      replacement: '                    rec.revoked = false;\n                    rec.token_hash.clone()' },
    { name: 'отзыв по fp не помечает связанные коды (безлимит возвращается по коду)',
      pattern: '                    c.revoked = true;\n                    marked += 1;',
      replacement: '                    c.revoked = c.revoked;\n                    marked += 1;' },
    { name: 'отзыв по fp не гасит выданный токен (аккаунт остаётся безлимитным)',
      pattern: '        if let Some(rec) = rec {\n            found = true;\n            if let Some(t) = vault_relay::parse(&app.keys, &rec.token) {\n                if app\n                    .revoked_tokens\n                    .lock()\n                    .expect("revoked_tokens lock")\n                    .insert(t.hash)',
      replacement: '        if let Some(rec) = rec {\n            found = true;\n            if let Some(t) = vault_relay::parse(&app.keys, &rec.token) {\n                if app\n                    .revoked_tokens\n                    .lock()\n                    .expect("revoked_tokens lock")\n                    .insert("deadbeef".to_string())' },
  ],
};
