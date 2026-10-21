// Набор мутаций: rust-call
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-call',
  file: 'vault-client/src/vault/call.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "сигнал звонка определяется по наличию call_id, а не по type call_*",
      pattern: "        && obj.get(\"type\").and_then(|v| v.as_str()).map(|t| t.starts_with(\"call_\")).unwrap_or(false)",
      replacement: "        && true" },
    { name: "не-конверт принимается за сигнал звонка",
      pattern: "    if !is_call {\n        return None;\n    }",
      replacement: "    if false {\n        return None;\n    }" },
    { name: "тип сигнала не читается (вызывающий не знает, что за сигнал)",
      pattern: "    let call_type = obj.get(\"type\").and_then(|v| v.as_str()).unwrap_or(\"\").to_string();",
      replacement: "    let call_type = String::new();" },
    { name: "идентификатор звонка не читается (звонки смешиваются)",
      pattern: "    let call_id = obj.get(\"call_id\").and_then(|v| v.as_str()).unwrap_or(\"\").to_string();",
      replacement: "    let call_id = String::new();" },
    { name: "время сигнала не читается (звонок приходит в 1970-м)",
      pattern: "    let ts = obj.get(\"ts\").and_then(|v| v.as_i64()).unwrap_or(0);",
      replacement: "    let ts = 0;" },
  ],
};
