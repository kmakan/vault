// Набор мутаций: хранилище сообщений — дедуп и порядок (Rust-ядро).
//
// Дедуп по message_id — правило 07.10 (переотправка не должна давать вторую
// копию в чате), порядок — «свежие сверху» по ts (иначе лента прыгает при
// доставке пачки писем), ключ чата — `group:<id>` для групп и адрес для 1:1
// (иначе групповой чат смешивается с перепиской).
export default {
  id: 'messages',
  file: 'vault-client/src/vault/messages.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'дедуп отключён (дубли переотправки попадают в чат)',
      pattern: '        if chat.iter().any(|m| m.id == msg.id) {\n            return false; // дедуп\n        }',
      replacement: '        if false {\n            return false; // дедуп\n        }' },
    { name: 'свежие вставляются в конец (порядок по времени ломается)',
      pattern: '        let pos = chat.iter().position(|m| m.ts < msg.ts).unwrap_or(chat.len());',
      replacement: '        let pos = chat.len();' },
    { name: 'ключ чата не учитывает группу (групповой чат смешан с 1:1)',
      pattern: '            Some(g) => format!("group:{}", g),',
      replacement: '            Some(g) => format!("group:{}ignored", g),' },
    { name: 'правка сообщения не находит его (правки перестают применяться)',
      pattern: '            if let Some(msg) = chat.iter_mut().find(|m| m.id == id) {',
      replacement: '            if let Some(msg) = chat.iter_mut().find(|_| false) {' },
    { name: 'счётчик добавленных не растёт (событие о новом письме теряется)',
      pattern: '            if self.append_message(email, group_id, msg) { added += 1; }',
      replacement: '            if self.append_message(email, group_id, msg) { added += 0; }' },
    { name: 'store_incoming всегда отвечает «сохранено» (дедуп результата теряется)',
      pattern: '    pub fn store_incoming(&mut self, email: &str, group_id: Option<&str>, msg: VaultMessage) -> bool {\n        self.append_message(email, group_id, msg)\n    }',
      replacement: '    pub fn store_incoming(&mut self, email: &str, group_id: Option<&str>, msg: VaultMessage) -> bool {\n        let _ = self.append_message(email, group_id, msg);\n        true\n    }' },
  ],
};
