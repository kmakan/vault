// Тестовый двойник классификации отказа публикации (vault-core::relay).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Смоук `relay-client` проверяет ПРОВОДКУ: при каком
// ответе сервера фронт пишет «лимит дня» в kv, а при каком — нет. Разбор
// ответа — протокольное решение, оно в Rust, и в смоуке его заменяет этот
// двойник (тот же приём, что transport-plan-mock и call-state-mock). Само
// правило меряют юнит-тесты `vault_core::relay` и набор мутаций
// rust-relay-rejection — двойник их не заменяет.
//
// Правило один в один: не 429 → other; 429 с `error`, начинающимся с «daily»
// → daily; любой другой 429 (в т.ч. битое тело) → rate. retry_after принимается
// только целым неотрицательным числом — иначе null.
export function relayRejectionHandler() {
  return async ({ status, body }) => {
    if (Number(status) !== 429) return { kind: 'other', retryAfter: null };
    let parsed = null;
    try {
      parsed = JSON.parse(String(body || ''));
    } catch (e) {
      parsed = null;
    }
    const raw = parsed && parsed.retry_after;
    const retryAfter = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
    const daily = !!(parsed && typeof parsed.error === 'string' && parsed.error.startsWith('daily'));
    return { kind: daily ? 'daily' : 'rate', retryAfter };
  };
}

/// Тексты ответов — те же, что отдаёт `vault-relay` (см. `relay_pub`, `rate`).
export const RELAY_DAILY_BODY =
  '{"error":"daily relay limit reached","limit":100,"retry_after":18640}';
export const RELAY_RATE_BODY = '{"error":"rate limit"}';
