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
    { name: 'новое всегда первым (вставка игнорирует время совсем)',
      pattern: '        let pos = chat.iter().position(|m| m.ts < msg.ts).unwrap_or(chat.len());',
      replacement: '        let pos = 0;' },
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
    // Маппинг payload → VaultMessage: id-цепочка важна для дедупа relay-копии
    // и email-копии одного письма, а «нейтральные» умолчания не должны
    // выдумывать данные (edited=true или ts=now сделали бы пустое письмо
    // похожим на настоящее).
    { name: 'envId из JS игнорируется (дедуп relay/email копии ломается)',
      pattern: '    let id = env_id\n        .or_else(|| p.get("id").and_then(|v| v.as_str()))',
      replacement: '    let id = p.get("id").and_then(|v| v.as_str())\n        .or_else(|| p.get("id").and_then(|v| v.as_str()))' },
    { name: 'legacy message_id не читается (старые письма теряют id)',
      pattern: '        .or_else(|| p.get("message_id").and_then(|v| v.as_str()))',
      replacement: '        .or_else(|| None::<&str>)' },
    { name: 'ts по умолчанию 1 вместо 0 (письмо без данных выглядит настоящим)',
      pattern: '        ts: p.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),',
      replacement: '        ts: p.get("ts").and_then(|v| v.as_i64()).unwrap_or(1),' },
    { name: 'edited по умолчанию true (письмо без данных помечается правленым)',
      pattern: '        edited: p.get("edited").and_then(|v| v.as_bool()).unwrap_or(false),',
      replacement: '        edited: p.get("edited").and_then(|v| v.as_bool()).unwrap_or(true),' },
    { name: 'пустой текст заменяется заглушкой (выдуманные данные в ленте)',
      pattern: '        text: p\n            .get("text")\n            .and_then(|v| v.as_str())\n            .unwrap_or("")\n            .to_string(),',
      replacement: '        text: p\n            .get("text")\n            .and_then(|v| v.as_str())\n            .unwrap_or("?")\n            .to_string(),' },
    { name: 'from и to переставлены (письмо приписывается получателю)',
      pattern: '        from: from.to_string(),\n        to: to.to_string(),',
      replacement: '        from: to.to_string(),\n        to: from.to_string(),' },
    { name: 'ttl теряется (самоуничтожающееся письмо становится вечным)',
      pattern: '        ttl: p.get("ttl").and_then(|v| v.as_u64()),',
      replacement: '        ttl: None,' },
    { name: 'не-JSON payload проглатывается (письмо сохраняется пустым)',
      pattern: '        serde_json::from_str(plain).map_err(|e| format!("payload parse: {}", e))?;',
      replacement: '        serde_json::from_str(plain).unwrap_or_default();' },
  ],
};
