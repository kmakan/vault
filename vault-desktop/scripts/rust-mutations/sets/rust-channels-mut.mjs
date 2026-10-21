// Набор мутаций: rust-channels-mut
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-channels-mut',
  file: 'vault-client/src/vault/channels.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "метка channel не проверяется (любое письмо — канальное)",
      pattern: "    if obj.get(\"channel\").and_then(|v| v.as_i64()) != Some(1) {",
      replacement: "    if false {" },
    { name: "идентификатор канала теряется (пост уходит не в тот канал)",
      pattern: "        chan: str_field(&obj, \"chan\"),",
      replacement: "        chan: String::new()," },
    { name: "meta не распознаётся (обновление метаданных не применяется)",
      pattern: "        is_meta: obj.get(\"meta\").and_then(|v| v.as_i64()) == Some(1),",
      replacement: "        is_meta: false," },
    { name: "hello не распознаётся (подписчик не запоминается)",
      pattern: "        is_hello: obj.get(\"hello\").and_then(|v| v.as_i64()) == Some(1),",
      replacement: "        is_hello: false," },
    { name: "пост без тела не считается постом (счётчик канала не растёт)",
      pattern: "        env.has_post = !post.is_null() && post != &serde_json::Value::Bool(false);",
      replacement: "        env.has_post = false;" },
    { name: "тело поста теряется (пост показывается пустым)",
      pattern: "            env.post_body = post\n                .get(\"body\")\n                .and_then(|v| v.as_str())\n                .unwrap_or(\"\")\n                .to_string();",
      replacement: "            env.post_body = String::new();" },
    { name: "картинки поста теряются",
      pattern: "            env.post_images = post\n                .get(\"images\")\n                .and_then(|v| v.as_array())\n                .map(|arr| {",
      replacement: "            env.post_images = post\n                .get(\"images\")\n                .and_then(|v| v.as_array())\n                .map(|arr| { vec![] })\n                .map(|arr| {" },
    { name: "пустое описание канала не отличить от «не прислали»",
      pattern: "        about: obj\n            .get(\"about\")\n            .and_then(|v| v.as_str())\n            .map(|s| s.to_string()),",
      replacement: "        about: Some(String::new())," },
  ],
};
