// Набор мутаций: rust-folders
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-folders',
  file: 'vault-client/src/vault/folders.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "папка с тем же именем создаётся второй раз",
      pattern: "        if self.folders.values().any(|f| f.name == name) {\n            return Ok(false);\n        }",
      replacement: "        if false {\n            return Ok(false);\n        }" },
    { name: "переименование в имя существующей папки разрешено (две папки с одним именем)",
      pattern: "            .any(|f| f.name == new_name && f.id != folder_id);",
      replacement: "            .any(|_| false);" },
    { name: "удаление папки не удаляет её из списка",
      pattern: "        let removed = self.folders.remove(folder_id).is_some();",
      replacement: "        let removed = self.folders.contains_key(folder_id);" },
    { name: "чат добавляется в папку повторно",
      pattern: "            if folder.contains_chat(chat_id) {",
      replacement: "            if false {" },
    { name: "иконка папки не меняется",
      pattern: "            folder.icon = icon.to_string();",
      replacement: "            folder.icon = String::new();" },
  ],
};
