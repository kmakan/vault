// Набор мутаций: rust-relay-accounting-api — вход и действия страницы учёта
// (main.rs). Суммы/налог меряет rust-relay-accounting; здесь измеряется
// граница доступа и «что разрешено отмечать»:
//   • страница/JSON существуют только при VAULT_RELAY_ADMIN_KEY (404);
//   • браузер входит Basic-паролем = ключ (не «любой пароль»);
//   • формы требуют CSRF (иначе чужой сайт отмечает чеки и налог);
//   • чек — только у подтверждённой провайдером оплаты;
//   • налог — только у месяца с доходом и только валидного календарём;
//   • «провайдер недоступен» не выдаётся за «доход 0»;
//   • страница не кэшируется (в ней доходы).
export default {
  id: 'rust-relay-accounting-api',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'all',
  file: 'vault-relay/src/main.rs',
  smoke: 'cargo test -p vault-relay accounting',
  timeoutMs: 600_000,
  mutations: [
    { name: 'Basic-вход принимает любой пароль (доходы видны всем)',
      pattern: '    ct_eq(pass, expected)\n}',
      replacement: '    let _ = expected;\n    true\n}' },
    { name: 'страница учёта живёт без VAULT_RELAY_ADMIN_KEY',
      pattern: '    if app.admin_key.is_none() {\n        return err(StatusCode::NOT_FOUND, "not found");\n    }\n    if !admin_web_ok(&app, &headers) {\n        return basic_401();\n    }',
      replacement: '    if !admin_web_ok(&app, &headers) {\n        return basic_401();\n    }' },
    { name: 'страница учёта кэшируется браузером (доходы остаются на диске)',
      pattern: '    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));\n    h.insert(\n        header::HeaderName::from_static("x-content-type-options"),',
      replacement: '    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));\n    h.insert(\n        header::HeaderName::from_static("x-content-type-options"),' },
    { name: 'чек отмечается без CSRF (любой сайт закрывает чек)',
      pattern: '    if !ct_eq(&form.csrf, &app.accounting_csrf) {\n        return err(StatusCode::FORBIDDEN, "bad csrf");\n    }\n    let id = form.payment_id.trim();',
      replacement: '    let id = form.payment_id.trim();' },
    { name: 'чек отмечается у неоплаченного платежа (реестр расходится с деньгами)',
      pattern: '    if row.status != "succeeded" {',
      replacement: '    if false {' },
    { name: 'налог отмечается без CSRF',
      pattern: '    if !ct_eq(&form.csrf, &app.accounting_csrf) {\n        return err(StatusCode::FORBIDDEN, "bad csrf");\n    }\n    let month = form.month.trim();',
      replacement: '    let month = form.month.trim();' },
    { name: 'месяц налога не проверяется календарём',
      pattern: '    if !accounting::valid_month(month) {',
      replacement: '    if false {' },
    { name: 'налог отмечается у месяца без дохода (скрывает долг)',
      pattern: '    if !report.months.iter().any(|m| m.key == month) {',
      replacement: '    if false {' },
    { name: 'выключенный провайдер выглядит как «дохода нет»',
      pattern: '        None => (Vec::new(), Some("платежи выключены (нет ключей)".to_string())),',
      replacement: '        None => (Vec::new(), None),' },
  ],
};
