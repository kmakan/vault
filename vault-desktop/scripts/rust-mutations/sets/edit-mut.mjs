// Набор мутаций: rust-edit (правки сообщений)
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-edit',
  file: 'vault-client/src/vault/edit.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "лимит правок не проверяется (сообщение правится бесконечно)",
      pattern: "            if existing.edit_count >= self.max_edits {",
      replacement: "            if false {" },
    { name: "окно правки не проверяется (можно править спустя срок)",
      pattern: "            if time_since_original.num_seconds() > self.edit_window_secs {",
      replacement: "            if false {" },
    { name: "чужой пользователь правит сообщение (автор не единственный редактор)",
      pattern: "            if existing.editor_email != editor_email {",
      replacement: "            if false {" },
    { name: "откат первой правки не удаляет запись (сообщение остаётся «исправленным»)",
      pattern: "            if record.edit_count <= 1 {",
      replacement: "            if false {" },
    { name: "откат не уменьшает счётчик правок",
      pattern: "                record.edit_count -= 1;",
      replacement: "                record.edit_count = record.edit_count;" },
  ],
};
