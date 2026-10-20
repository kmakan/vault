// Набор мутаций: роутер входящих конвертов (Rust-ядро).
//
// `classify` — единственный источник правды о типе входящего письма. Его
// проверяют и модульные тесты, и общая фикстура wire-контракта
// (vault-client/tests/fixtures/m0-wire-contract.json), которую читает и
// JS-сторона. Поэтому набор гоняем по ВСЕМ тестам крейта (`kind: 'all'`):
// фикстура ловит то, чего не видит модульный тест, и наоборот.
export default {
  id: 'incoming',
  file: 'vault-client/src/vault/incoming.rs',
  smoke: 'cargo test -p vault-client',
  kind: 'all',
  mutations: [
    { name: 'vault-метка не проверяется (чужой JSON принимается за конверт)',
      pattern: '    let is_vault = obj.get("vault").and_then(|v| v.as_i64()) == Some(1);',
      replacement: '    let is_vault = true;' },
    { name: 'text любого типа считается строкой (text:123 — конверт)',
      pattern: '    let text_is_string = obj.get("text").map(|v| v.is_string()).unwrap_or(false);',
      replacement: '    let text_is_string = obj.get("text").is_some();' },
    { name: 'call-сигнал определяется наличием call_id, а не типом call_*',
      pattern: '            .map(|t| t.starts_with("call_"))',
      replacement: '            .map(|t| !t.is_empty())' },
    { name: 'presence принимается и как строка ("1" — heartbeat)',
      pattern: '    if obj.get("presence").and_then(|v| v.as_i64()) == Some(1) {',
      replacement: '    if obj.get("presence").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))) == Some(1) {' },
    { name: 'письмо профиля больше не отличается от сообщения',
      pattern: '        let kind = if obj.get("type").and_then(|v| v.as_str()) == Some("profile") {',
      replacement: '        let kind = if obj.get("type").and_then(|v| v.as_str()) == Some("__never__") {' },
    { name: 'канальный конверт не распознаётся (канал молча теряется)',
      pattern: '    if obj.get("channel").and_then(|v| v.as_i64()) == Some(1) {',
      replacement: '    if false {' },
    { name: 'сервисное письмо группы (hav) не распознаётся',
      pattern: '    if obj.get("hav").and_then(|v| v.as_i64()) == Some(1) {',
      replacement: '    if false {' },
    { name: 'пустое имя попадает в заголовок чата',
      pattern: '        .filter(|s| !s.is_empty())',
      replacement: '        .filter(|_| true)' },
  ],
};
