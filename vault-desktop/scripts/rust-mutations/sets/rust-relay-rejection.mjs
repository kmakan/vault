// Набор мутаций: rust-relay-rejection — чем отказ релея отличается от другого
// отказа (429 ДВА и 402).
//
// ЗАЧЕМ. Сервер отвечает 429 и за суточную квоту издателя, и за вспышку
// запросов; для клиента это противоположные решения (молчать до полуночи UTC
// против «повтори сейчас»). Пока различия не было, пачка сигналов звонка
// (setup + ICE-кандидаты, те же 10 rps) глушила ускорение на сутки.
// Третья ветка — 402: адрес очереди протух, и это единственный отказ, который
// не лечится ни повтором, ни молчанием (перерегистрация своего / забывание
// чужого). Различать 402 по ОДНОМУ статусу нельзя: те же 402 отдают платёжные
// ответы (`not_paid_yet`, `plan_expired`), где от клиента ждут денег, а не
// нового адреса.
// Правило читает ответ СЕРВЕРА, значит оно в ядре (ADR-005), и меряется здесь,
// а не двусторонней константой во фронте.
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
    { name: 'протухание определяется только по тексту (любой 401/403 со словом «expired» стал бы перерегистрацией)',
      pattern: '    status == HTTP_SUBSCRIPTION_EXPIRED && body.contains(SUBSCRIPTION_EXPIRED_MARK)',
      replacement: '    body.contains(SUBSCRIPTION_EXPIRED_MARK)' },
    { name: 'протухание определяется только по коду (402 «bad recipient token» вёл бы к ложной перерегистрации)',
      pattern: '    status == HTTP_SUBSCRIPTION_EXPIRED && body.contains(SUBSCRIPTION_EXPIRED_MARK)',
      replacement: '    status == HTTP_SUBSCRIPTION_EXPIRED' },
    { name: 'порог 402 сдвинут (настоящее протухание очереди не узнаётся никогда)',
      pattern: 'pub const HTTP_SUBSCRIPTION_EXPIRED: u16 = 402;',
      replacement: 'pub const HTTP_SUBSCRIPTION_EXPIRED: u16 = 403;' },
    { name: 'маркер текста изменён (poll/pub 402 перестают распознаваться)',
      pattern: 'const SUBSCRIPTION_EXPIRED_MARK: &str = "subscription expired";',
      replacement: 'const SUBSCRIPTION_EXPIRED_MARK: &str = "queue expired";' },
    { name: 'срок v1-токена читается из чужого поля (v2-профиль → мёртвые адреса живых)',
      pattern: '        TOKEN_V1_LEN => TOKEN_V1_EXP,',
      replacement: '        TOKEN_V1_LEN => TOKEN_V2_EXP,' },
    { name: 'срок v2-токена читается из чужого поля (вер+план+sub вместо paid_until)',
      pattern: '        TOKEN_V2_LEN => TOKEN_V2_EXP,',
      replacement: '        TOKEN_V2_LEN => TOKEN_V1_EXP,' },
    { name: 'длина v1-токена сдвинута (настоящий v1 не узнаётся и живёт вечно)',
      pattern: 'pub const TOKEN_V1_LEN: usize = 45;',
      replacement: 'pub const TOKEN_V1_LEN: usize = 46;' },
    { name: 'последняя секунда жизни токена считается живой (402 вместо пропуска)',
      pattern: '    token_expiry(token).is_some_and(|exp| exp <= now)',
      replacement: '    token_expiry(token).is_some_and(|exp| exp < now)' },
    { name: 'неизвестная форма токена считается мёртвой (живой адрес выбрасывается)',
      pattern: '    token_expiry(token).is_some_and(|exp| exp <= now)',
      replacement: '    token_expiry(token).map_or(true, |exp| exp <= now)' },
    { name: 'токен декодируется стандартным алфавитом (url-safe с -/_ не читается никогда)',
      pattern: '        &base64::engine::general_purpose::URL_SAFE_NO_PAD,',
      replacement: '        &base64::engine::general_purpose::STANDARD,' },
  ],
};
