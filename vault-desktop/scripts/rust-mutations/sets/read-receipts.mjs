// Набор мутаций: квитанции о прочтении/доставке (Rust-ядро).
//
// Квитанции рисуются в чате двумя галочками: одна — «доставлено», две —
// «прочитано». Правила: «прочитано» и «доставлено» — РАЗНЫЕ статусы (нельзя
// отвечать «прочитано» за «доставлено»), у входящих сообщений значка нет вовсе,
// тело квитанции разбирается строго (без message_id квитанция не наша).
export default {
  id: 'read-receipts',
  file: 'vault-client/src/vault/read_receipts.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: '«прочитано» считается «доставлено» (вторая галочка без первого)',
      pattern: '.map(|records| records.iter().any(|r| r.status == MessageStatus::Read))',
      replacement: '.map(|records| records.iter().any(|r| r.status == MessageStatus::Delivered))' },
    { name: '«доставлено» считается «прочитано» (двойная галочка без прочтения)',
      pattern: '.map(|records| records.iter().any(|r| r.status == MessageStatus::Delivered))',
      replacement: '.map(|records| records.iter().any(|r| r.status == MessageStatus::Read))' },
    // Мутация «.push(record) → void 0» была НЕВАЛИДНОЙ: компилятор её
    // отверг (тип записи), то есть это не пробел в тестах, а опечатка в
    // наборе. Заменена на валидную: запись есть, но НЕ СОХРАНЯЕТСЯ на диск —
    // после перезапуска приложения квитанок нет.
    { name: 'квитанция не сохраняется на диск (после перезапуска её нет)',
      pattern: '        self.save()\n    }\n\n    /// Record a delivery receipt',
      replacement: '        Ok(())\n    }\n\n    /// Record a delivery receipt' },
    { name: 'у входящего сообщения показывается значок доставки',
      pattern: '        if !is_outgoing {\n            // Incoming messages don\'t have outgoing receipt status\n            return String::new();\n        }',
      replacement: '        if false {\n            return String::new();\n        }' },
    { name: '«доставлено» рисуется двумя галочками (как прочитано)',
      pattern: '            Some(MessageStatus::Delivered) => " ✓✓".to_string(),',
      replacement: '            Some(MessageStatus::Delivered) => " ✓".to_string(),' },
    { name: 'квитанция без message_id принимается (чужая квитанция)',
      pattern: '        let message_id = parsed.get("message_id")?.as_str()?.to_string();',
      replacement: '        let message_id = parsed.get("message_id").and_then(|v| v.as_str()).unwrap_or("").to_string();' },
    { name: 'квитанция без отправителя принимается (непонятно, кто прочитал)',
      pattern: '        let reader = parsed.get("from_email")?.as_str()?.to_string();',
      replacement: '        let reader = parsed.get("from_email").and_then(|v| v.as_str()).unwrap_or("").to_string();' },
  ],
};
