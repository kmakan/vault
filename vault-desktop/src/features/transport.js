// Выбор транспорта (чип в рядку фич): почта / релей / авто. ADR-005.
//
// ПРАВИЛО — НЕ ЗДЕСЬ. «Каким транспортом уходит это сообщение» решает
// vault-core::transport (план и порядок переключения), а исполнение — send.js
// и calls.js. Модуль делает ровно две вещи: переводит имя выбора в оформление
// (иконка + подпись) и дергает мост. Собственно ветвления по протоколу тут нет
// намеренно: таблица оформления — это UI, а не вторая копия правила.
//
// deps (ADR-001 R3): setTransportPreference(value) — запись во Vue-состояние
// (реактивность принадлежит компоненту), showToast/t — эффекты интерфейса.
// Текущий адрес модуль берёт у владельца сессии, как send.js и calls.js:
// настройка хранится на аккаунт.
import api from '../api.js';
import { sessionStore } from './session-store.js';

const myEmail = () => sessionStore.getCurrentEmail();

const VIEW = {
  auto: { icon: 'send', titleKey: 'transport_auto' },
  relay: { icon: 'globe', titleKey: 'transport_relay' },
  mail: { icon: 'mail', titleKey: 'transport_mail' },
};

// Неизвестное значение показывается как «авто»: ядро для него и план считает
// авто, так что подпись не расходится с поведением.
export function transportView(preference) {
  return VIEW[preference] || VIEW.auto;
}

// Чтение выбора при входе в аккаунт. `null` (мост не ответил) — оставляем то,
// что уже показано: нарисовать «авто» вместо реального «только почта» хуже,
// чем задержанная подпись.
export async function loadTransportPreference(deps) {
  const value = await api.transportPreference(myEmail());
  if (value !== null) deps.setTransportPreference(value);
  return value;
}

// Клик по чипу: следующий выбор считает и запишет Rust, вернётся новое имя.
export async function cycleTransportPreference(deps) {
  const value = await api.transportPreferenceNext(myEmail());
  if (value === null) return null;
  deps.setTransportPreference(value);
  if (deps.showToast) {
    deps.showToast(deps.t ? deps.t(transportView(value).titleKey) : value, 2200);
  }
  return value;
}
