// Модуль-владелец состояния отправки (ADR-004, Этап A10).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ, КОГДА sending/pendingOutgoing УЖЕ ЕСТЬ В App.vue.
//
// `sending` (boolean) пишут 7 модулей — forward.js (x2), poll.js (x2),
// send.js (x3). Никакой из них не знает о соседях: переключить `sending`
// в poll.js может одновременно с send.js, и UI увидит конфликтное состояние
// (кнопка отправки на 0.5сек выключена/включена в гонке).
//
// `pendingOutgoing` (chat_id → {msg_id → pendingMsg}) пишут 7 модулей —
// send.js (x3), history.js (x4). Каждый делает spread-and-replace:
// ctx.pendingOutgoing = { ...ctx.pendingOutgoing, [c]: b }.
//
// До A10 `sending` и `pendingOutgoing` жили в ctx как плоские поля. ctx лишь
// ТРАНСПОРТ для канала записи. Владелец централизует все писатели.
//
// Создаётся один раз на приложение (в композиционном корне App.vue).
export function createSendingStore() {
  const state = {
    sending: false,
    pendingOutgoing: {},
  };

  return {
    state,

    setSending(val) {
      state.sending = !!val;
      return state.sending;
    },
    getSending() {
      return state.sending;
    },

    getBucket(chatId) {
      const b = state.pendingOutgoing[chatId];
      if (!b) {
        const fresh = {};
        state.pendingOutgoing[chatId] = fresh;
        return fresh;
      }
      return b;
    },

    setPendingOutgoing(chatId, pendingMsg) {
      const bucket = state.pendingOutgoing[chatId] || {};
      if (pendingMsg && pendingMsg.id) {
        bucket[pendingMsg.id] = pendingMsg;
      } else {
        Object.assign(bucket, pendingMsg || {});
      }
      state.pendingOutgoing[chatId] = bucket;
      return bucket;
    },

    // Полное замещение бакета чата (replace, а не deep-merge).
    // Используется mergePending.js: `remaining` — уже ОтФИЛЬТРОВАННЫЙ набор
    // pending-записей; старые ключи (которых нет в remaining) должны исчезнуть.
    mergePendingOutgoing(chatId, bucket) {
      state.pendingOutgoing[chatId] = bucket || {};
      return state.pendingOutgoing[chatId];
    },

    removePendingOutgoing(chatId, msgId) {
      const bucket = state.pendingOutgoing[chatId];
      if (bucket && Object.prototype.hasOwnProperty.call(bucket, msgId)) {
        delete bucket[msgId];
        state.pendingOutgoing[chatId] = bucket;
      }
      return bucket || null;
    },

    clearPendingOutgoing() {
      state.pendingOutgoing = {};
      return state.pendingOutgoing;
    },

    // Удалить весь бакет для чата (очистка после полного подтверждения).
    dropBucket(chatId) {
      delete state.pendingOutgoing[chatId];
      return state.pendingOutgoing;
    },
  };
}
