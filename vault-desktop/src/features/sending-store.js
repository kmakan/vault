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
function isPlainRecord(v) {
  return typeof v === 'object' && !Array.isArray(v);
}

export function createSendingStore() {
  const state = {
    sending: false,
    pendingOutgoing: {},
  };

  return {
    state,

    setSending(val) {
      this.state.sending = !!val;
      return this.state.sending;
    },
    getSending() {
      return this.state.sending;
    },

    getBucket(chatId) {
      const b = this.state.pendingOutgoing[chatId];
      if (!b) {
        const fresh = {};
        this.state.pendingOutgoing[chatId] = fresh;
        return fresh;
      }
      return b;
    },

    // Бакет — это {msg_id → pendingMsg}. Строка/массив/число сюда попасть не
    // могут: Object.assign по строке рассыпает её по символам, и поллинг
    // подмешивает символы в чат как сообщения (жалоба 22.10 — «пустые пузыри»).
    // Проверка живёт во ВЛАДЕЛЬЦЕ: вызвать передачу с другой арностью могут в
    // семи местах, забыть проверку в одном — нельзя.
    setPendingOutgoing(chatId, pendingMsg) {
      const bucket = this.state.pendingOutgoing[chatId] || {};
      // Форма фиксирована ДО содержимого: слот бакета всегда запись. Иначе
      // отказ записи оставил бы `undefined`, и читающий `Object.keys(bucket)`
      // упал бы на пустом чате.
      this.state.pendingOutgoing[chatId] = bucket;
      if (pendingMsg == null) return bucket;
      if (!isPlainRecord(pendingMsg)) {
        console.warn('[sending] setPendingOutgoing: ожидали запись pending, получили', typeof pendingMsg);
        return bucket;
      }
      if (pendingMsg.id) {
        bucket[pendingMsg.id] = pendingMsg;
      } else {
        Object.assign(bucket, pendingMsg);
      }
      return bucket;
    },

    // Полное замещение бакета чата (replace, а не deep-merge).
    // Используется mergePending.js: `remaining` — уже ОтФИЛЬТРОВАННЫЙ набор
    // pending-записей; старые ключи (которых нет в remaining) должны исчезнуть.
    mergePendingOutgoing(chatId, bucket) {
      if (bucket != null && !isPlainRecord(bucket)) {
        console.warn('[sending] mergePendingOutgoing: ожидали бакет, получили', typeof bucket);
        return this.state.pendingOutgoing[chatId] || null;
      }
      this.state.pendingOutgoing[chatId] = bucket || {};
      return this.state.pendingOutgoing[chatId];
    },

    removePendingOutgoing(chatId, msgId) {
      const bucket = this.state.pendingOutgoing[chatId];
      if (bucket && Object.prototype.hasOwnProperty.call(bucket, msgId)) {
        delete bucket[msgId];
        this.state.pendingOutgoing[chatId] = bucket;
      }
      return bucket || null;
    },

    clearPendingOutgoing() {
      this.state.pendingOutgoing = {};
      return this.state.pendingOutgoing;
    },

    // Удалить весь бакет для чата (очистка после полного подтверждения).
    dropBucket(chatId) {
      delete this.state.pendingOutgoing[chatId];
      return this.state.pendingOutgoing;
    },
  };
}
