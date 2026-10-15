// Модуль-владелец состояния групп (ADR-004, Этап A9).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ, КОГДА groupKeys/groupAvatars УЖЕ ЕСТЬ В App.vue.
//
// Пять модулей пишут в groupKeys — groups, send, incoming,
// group-avatars, group-meta — и между ними нет ничего, кроме имени поля.
// Правка одного может испортить ключи группы и сломать остальных, а они
// об этом не узнают. Три пишут в groupAvatars — groups, group-avatars,
// group-meta. Всё то же самое: невидимый канал записи друг в друга через
// имя поля, без единого общего интерфейса.
//
// До A9 эти поля жили прямо в ctx как groupKeys/groupAvatars — ctx лишь
// ТРАНСПОРТ для этого канала. Пока канал есть, переименовать
// его в «зависимость» не поможет: канал останется, изменится имя.
//
// Владелец и его API появились раньше первого конвертируемого модуля, чтобы
// каждая последующая замена была механической.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ ИМПОРТА VUE.
// Первая версия брала `reactive` из vue внутри себя, и смоук не запускался:
// копия модуля лежит в /tmp, а node_modules оттуда не достижим. Это отказ
// инструмента, но он указал на более правильную форму: владелец состояния
// НЕ ДОЛЖЕН знать о фреймворке — тогда он тестируется где угодно и чем
// угодно (Node, vitest, будущий отдельный процесс), а решение о
// реактивности принимает композиционный корень: `const groups =
// reactive(createGroupsStore())`.
//
// Реактивность сохраняется, и не случайно: методы мутируют state ЧЕРЕЗ
// объект-параметр (this.state), поэтому проходят через прокси, и
// подписки срабатывают.
//
// Создаётся один раз на приложение (в композиционном корне App.vue).
export function createGroupsStore() {
  return {
    state: {
      // group_id → groupKeyHex (shared symmetric key)
      groupKeys: {},
      // group_id → dataUrl/avatar объект
      groupAvatars: {},
    },

    // ── groupKeys ──────────────────────────────────────────────────
    getGroupKey(id) {
      return this.state.groupKeys[id];
    },

    // Запись владельца: единственный способ изменить group key.
    // Возвращает ключ для удобства цепочки вызовов (lazy-backfill паттерн).
    setGroupKey(id, key) {
      this.state.groupKeys[id] = key;
      return key;
    },

    // Batch-merge для загрузки из локального kv_store (одна операция).
    mergeGroupKeys(map) {
      Object.assign(this.state.groupKeys, map);
      return this.state.groupKeys;
    },

    // groupAvatars ───────────────────────────────────────────────────
    getGroupAvatar(id) {
      return this.state.groupAvatars[id];
    },

    setGroupAvatar(id, avatar) {
      this.state.groupAvatars[id] = avatar;
      return avatar;
    },

    mergeGroupAvatars(map) {
      Object.assign(this.state.groupAvatars, map);
      return this.state.groupAvatars;
    },

    // Полный сброс (logout/reset). Используется в App.vue resetState,
    // где раньше был прямой `this.groupKeys = {}` — теперь поле в computed
    // getter, set игнорируется, поэтому нужен метод владельца.
    clearGroupKeys() {
      this.state.groupKeys = {};
      return this.state.groupKeys;
    },
    clearGroupAvatars() {
      this.state.groupAvatars = {};
      return this.state.groupAvatars;
    },
  };
}
