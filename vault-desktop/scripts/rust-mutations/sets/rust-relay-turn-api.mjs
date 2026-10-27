// Набор мутаций: rust-relay-turn-api — HTTP-контракт выдачи TURN-кредов
// (GET /relay/turn в vault-relay/src/main.rs).
//
// ЗАЧЕМ. turn.rs считает пару, но решение «кому отказывать, чем отвечать и
// каким счётом мерить сутки» живёт в самом роуте. Именно здесь возникают дырки
// вида «канальному токену выдали relay» и «звонок перестал стоить денег».
// Последняя теперь особенно тихая: квота TURN — общий бюджет релея с
// конвертами, поэтому сбой выглядит как «лимит в тарифе есть, а расходы
// мимо кассы». Меряем статусы, ttl, порог и ключ счётчика.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ: `app.persist_daily_quota()` (есть мерка в
// rust-relay-persist) и троттлинг записи на диск.
export default {
  id: 'rust-relay-turn-api',
  crate: 'vault-relay',
  kind: 'all',
  file: 'vault-relay/src/main.rs',
  smoke: 'cargo test -p vault-relay',
  mutations: [
    { name: 'эндпоинт без конфигурации притворяется успешным (клиент ждёт креды, которых нет)',
      pattern: '        return err(StatusCode::SERVICE_UNAVAILABLE, "turn not configured");',
      replacement: '        return err(StatusCode::OK, "turn not configured");' },
    { name: 'просроченный токен получает relay-креды (402-гейт снят)',
      pattern: '    if t.is_expired() {\n        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");\n    }\n    // Канальный токен — не аккаунт звонящего: права на relay-трафик нет.',
      replacement: '    if false {\n        return err(StatusCode::PAYMENT_REQUIRED, "subscription expired");\n    }\n    // Канальный токен — не аккаунт звонящего: права на relay-трафик нет.' },
    { name: 'канальный токен проходит гейт (чужой relay-трафик за наш счёт)',
      pattern: '    if t.scope.is_channel() {\n        return err(StatusCode::FORBIDDEN, "channel token");',
      replacement: '    if false {\n        return err(StatusCode::FORBIDDEN, "channel token");' },
    { name: 'выдачи идут в отдельный счётчик — лимит обходится одним звонком, деньги мимо кассы',
      pattern: '            tally_daily(&mut map, &format!("t:{}", t.hash), day, limit, now())',
      replacement: '            tally_daily(&mut map, &format!("turn:{}", t.hash), day, limit, now())' },
    { name: 'порог выдач перестаёт зависеть от тарифа (купленный лимит на звонки не влияет)',
      pattern: '    let limit = daily_limit_for_token(&t, app.free_daily_limit);',
      replacement: '    let limit = Some(1_000_000);' },
    { name: 'выключатель бесплатного лимита гасит выдачи (на стенде звонки молча умирают)',
      pattern: '    if let Some(limit) = limit.filter(|l| *l > 0) {',
      replacement: '    if let Some(limit) = limit {' },
    { name: 'срок пары не из CRED_TTL (клиент кэширует на час, coturn отвергает через минуту)',
      pattern: '    let username = vault_relay::turn::username(now(), vault_relay::turn::CRED_TTL, &t.hash);',
      replacement: '    let username = vault_relay::turn::username(now(), 60, &t.hash);' },
    { name: 'ttl в ответе не совпадает со сроком пары (кэш клиента протухает молча)',
      pattern: '            "ttl": vault_relay::turn::CRED_TTL,',
      replacement: '            "ttl": 60,' },
    { name: 'срабатывание лимита не считается в метрике (429 незаметен для мониторинга)',
      pattern: '            tally_daily(&mut map, &format!("t:{}", t.hash), day, limit, now())\n        };\n        if let Some(retry_after) = retry_after {\n            app.metrics.limit_hit.fetch_add(1, Ordering::Relaxed);',
      replacement: '            tally_daily(&mut map, &format!("t:{}", t.hash), day, limit, now())\n        };\n        if let Some(retry_after) = retry_after {' },
  ],
};
