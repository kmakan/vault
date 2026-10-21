// Набор мутаций: m0-wire-mut (Rust-ядро)
// Цель: убедиться, что правила разбора wire-конверта ловятся тестами.
//
// Набор переехал сюда из JS-каталога 21.10: разбор конверта ушёл в Rust
// (ADR-005 R1 / W4), и в JS больше нечего ломать — там только транспорт.
// Фикстура паритета (vault-client/tests/fixtures/m0-wire-contract.json) читается
// обоими гейтами, поэтому правила проверяются и здесь, и там.
//
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'm0-wire-mut',
  file: 'vault-client/src/vault/envelope.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "конверт без метки vault:1 принимается",
      pattern: "    let is_vault = obj.get(\"vault\").and_then(|v| v.as_i64()) == Some(1);",
      replacement: "    let is_vault = true;" },
    { name: "text не-строка принимается за конверт",
      pattern: "    let text_is_string = obj.get(\"text\").map(|v| v.is_string()).unwrap_or(false);",
      replacement: "    let text_is_string = obj.get(\"text\").is_some();" },
    { name: "битый конверт роняет разбор вместо null",
      pattern: "    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;",
      replacement: "    let obj: serde_json::Value = serde_json::from_str(plain).unwrap();" },
  ],
};
