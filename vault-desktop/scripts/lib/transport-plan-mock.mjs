// Тестовый двойник правила плана транспорта (vault-core::transport).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Смоуки send/calls проверяют ПРОВОДКУ исполнения:
// «письмо стартовало», «релей опубликован», «при отказе релея письмо всё-таки
// ушло». Ответ ядра они получают от двойника — как и в случаях wire-signal-
// mock и call-state-mock. Таблица ниже повторяет Rust-правило один в один;
// само правило меряют юнит-тесты vault-core::transport и набор мутаций
// rust-transport (двойник не заменяет их: расхождение здесь поймает только
// живой прогон).
const AUTO = 'auto', MAIL = 'mail', RELAY = 'relay';
const norm = (v) => (v === MAIL || v === RELAY ? v : AUTO);

// `relayAvailable` — ВХОД, а не догадка двойника: его передаёт сам модуль
// (состояние релей-стора), и мутация «передать false вместо стора» обязана
// быть видна. Подменить вход для отдельной проверки —
// globalThis.__transportPlan = { preference, relayAvailable }.
export function transportPlanHandler() {
  return async (account, relayAvailable) => {
    const over = globalThis.__transportPlan || {};
    const pref = norm(over.preference !== undefined ? over.preference : AUTO);
    const live = over.relayAvailable !== undefined ? over.relayAvailable : !!relayAvailable;
    if (pref === MAIL) return { mail: true, relay: false, mailFallback: false };
    if (!live) return { mail: true, relay: false, mailFallback: false };
    if (pref === RELAY) return { mail: false, relay: true, mailFallback: true };
    return { mail: true, relay: true, mailFallback: false };
  };
}
