// Набор мутаций: rust-relay
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).
//
// ПРИМЕЧАНИЕ. Мутации по publish() убраны: путь сетевой (HTTPS к релею), и
// юнит-тестами он не покрывается — проверять его можно только e2e-сценарием
// с живым релеем. Проверяемая часть (состояние релея: включён, токен, дневной
// лимит) — здесь.

export default {
  id: 'rust-relay',
  file: 'vault-client/src/vault/relay.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "выключенный релей всё равно публикует",
      pattern: "    if !state.enabled {\n        return PubOutcome::Disabled;\n    }",
      replacement: "    if false {\n        return PubOutcome::Disabled;\n    }" },
    { name: "без своего токена публикация всё равно уходит",
      pattern: "    if state.my_token.is_empty() {\n        return PubOutcome::NoMyToken;\n    }",
      replacement: "    if false {\n        return PubOutcome::NoMyToken;\n    }" },
    { name: "дневной лимит не проверяется (429 игнорируется)",
      pattern: "    if state.limit_day == Some(today) {\n        return PubOutcome::DailyLimit;\n    }",
      replacement: "    if false {\n        return PubOutcome::DailyLimit;\n    }" },
  ],
};
