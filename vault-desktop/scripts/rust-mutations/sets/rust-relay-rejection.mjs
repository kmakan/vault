// Набор мутаций: rust-relay-rejection — чем был 429 релея.
//
// ЗАЧЕМ. Сервер отвечает 429 и за суточную квоту издателя, и за вспышку
// запросов; для клиента это противоположные решения (молчать до полуночи UTC
// против «повтори сейчас»). Пока различия не было, пачка сигналов звонка
// (setup + ICE-кандидаты, те же 10 rps) глушила ускорение на сутки. Правило
// читает ответ СЕРВЕРА, значит оно в ядре (ADR-005), и меряется здесь, а не
// двусторонней константой во фронте.
export default {
  id: 'rust-relay-rejection',
  crate: 'vault-core',
  file: 'vault-core/src/relay.rs',
  smoke: 'cargo test -p vault-core --lib',
  mutations: [
    { name: 'любой код, кроме 429, тоже разбирается (401/413 стали бы «лимитом»)',
      pattern: '    if status != HTTP_TOO_MANY {',
      replacement: '    if false {' },
    { name: 'порог класса 429 сдвинут (настоящий 429 уходит в other)',
      pattern: 'pub const HTTP_TOO_MANY: u16 = 429;',
      replacement: 'pub const HTTP_TOO_MANY: u16 = 430;' },
    { name: 'суточный лимит определяется по слову «rate» (ветки перепутаны)',
      pattern: '        .map(|e| e.starts_with("daily"))',
      replacement: '        .map(|e| e.starts_with("rate"))' },
    { name: 'префикс «daily» пишется с заглавной (регистр сервера → вспышка)',
      pattern: '        .map(|e| e.starts_with("daily"))',
      replacement: '        .map(|e| e.starts_with("Daily"))' },
    { name: 'нераспознанный 429 считается суточным лимитом (гасит ускорение на сутки)',
      pattern: '        .unwrap_or(false);',
      replacement: '        .unwrap_or(true);' },
    { name: 'суточный лимит всегда трактуется как вспышка (pub долбится до полуночи)',
      pattern: '        kind: if daily {\n            REJECTION_DAILY\n        } else {\n            REJECTION_RATE\n        },',
      replacement: '        kind: REJECTION_RATE,' },
    { name: 'любой 429 трактуется как суточный лимит',
      pattern: '        kind: if daily {\n            REJECTION_DAILY\n        } else {\n            REJECTION_RATE\n        },',
      replacement: '        kind: REJECTION_DAILY,' },
    { name: 'retry_after читается из чужого поля (сервер назвал срок, клиент его терял)',
      pattern: 'v.get("retry_after").and_then(|r| r.as_u64())',
      replacement: 'v.get("retry").and_then(|r| r.as_u64())' },
    { name: 'retry_after не читается вовсе (сервер назвал срок, клиент его терял)',
      pattern: `    let retry_after = value
        .as_ref()
        .and_then(|v| v.get("retry_after").and_then(|r| r.as_u64()));`,
      replacement: '    let retry_after: Option<u64> = None;' },
    { name: 'имя ветки daily рассинхронизировано с JS-контрактом',
      pattern: 'pub const REJECTION_DAILY: &str = "daily";',
      replacement: 'pub const REJECTION_DAILY: &str = "daily-limit";' },
    { name: 'имя ветки rate рассинхронизировано с JS-контрактом',
      pattern: 'pub const REJECTION_RATE: &str = "rate";',
      replacement: 'pub const REJECTION_RATE: &str = "burst";' },
    { name: 'поле сериализуется не в camelCase (мост отдаёт retry_after, JS ждёт retryAfter)',
      pattern: '#[serde(rename_all = "camelCase")]\npub struct Rejection {',
      replacement: 'pub struct Rejection {' },
  ],
};
