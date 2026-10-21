// Набор мутаций: rust-envelope-parse-mut
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-envelope-parse-mut',
  file: 'vault-client/src/vault/envelope.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "метка vault не проверяется (чужой JSON принимается за конверт)",
      pattern: "    let is_vault = obj.get(\"vault\").and_then(|v| v.as_i64()) == Some(1);",
      replacement: "    let is_vault = true;" },
    { name: "text не-строка принимается за конверт (пустое сообщение вместо мусора)",
      pattern: "    let text_is_string = obj.get(\"text\").map(|v| v.is_string()).unwrap_or(false);",
      replacement: "    let text_is_string = obj.get(\"text\").is_some();" },
    { name: "идентификатор сообщения теряется (дедуп по id не работает)",
      pattern: "        id: id.clone(),",
      replacement: "        id: String::new()," },
    { name: "имя отправителя теряется (в шапке чата «нет имени»)",
      pattern: "        name: string_field(&obj, \"name\"),",
      replacement: "        name: String::new()," },
    { name: "ttl теряется (исчезающие сообщения не исчезают)",
      pattern: "        ttl: obj\n            .get(\"ttl\")\n            .and_then(|v| v.as_f64())\n            .map(|v| v as i64)\n            .unwrap_or(0),",
      replacement: "        ttl: 0," },
    { name: "подконверт голосования теряется (опрос не отображается)",
      pattern: "    if let Some(poll) = obj.get(\"poll\") {",
      replacement: "    if let Some(poll) = obj.get(\"poll_typo\") {" },
    { name: "пустой poll-объект считается голосованием",
      pattern: "        if poll.is_object() {",
      replacement: "        if poll.is_object() || poll.is_null() {" },
  ],
};
