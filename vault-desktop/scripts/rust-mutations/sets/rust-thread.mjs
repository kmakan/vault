// Набор мутаций: rust-thread
// Цель: убедиться, что cargo test ЛОВИТ эти поломки.
// Если мутация выжила — тест ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-thread',
  file: 'vault-client/src/vault/thread.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "непрочитанные сообщения не считаются",
      pattern: "        if !msg.is_read {\n            self.unread_count += 1;\n        }",
      replacement: "        if !msg.is_read {\n            self.unread_count += 0;\n        }" },
    { name: "счётчик непрочитанных не сбрасывается после «прочитать всё»",
      pattern: "        self.unread_count = 0;",
      replacement: "        self.unread_count += 0;" },
    { name: "участник добавляется в список повторно",
      pattern: "        if !self.participants.contains(&msg.from) {",
      replacement: "        if true {" },
    { name: "треды не сортируются по активности (старые сверху)",
      pattern: "        threads.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));",
      replacement: "        threads.sort_by(|a, b| a.last_activity.cmp(&b.last_activity));" },
    { name: "поиск треда по теме отключён (каждое письмо — новый тред)",
      pattern: "        let idx = self.threads.iter().position(|t| t.subject == subject);",
      replacement: "        let idx: Option<usize> = None;" },
    { name: "корневое сообщение ищется не по parent_id",
      pattern: "        self.messages.iter().find(|m| m.parent_id.is_none())",
      replacement: "        self.messages.iter().find(|m| m.parent_id.is_some())" },
    { name: "ответы ищутся не по parent_id",
      pattern: "            .filter(|m| m.parent_id.as_deref() == Some(message_id))",
      replacement: "            .filter(|m| m.parent_id.as_deref() == Some(\"нет\"))" },
  ],
};
