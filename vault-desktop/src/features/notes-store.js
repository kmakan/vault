// Модуль-владелец состояния заметок для себя (ADR-004, Этап A15).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ, КОГДА loadNotes/saveNotes УЖЕ ЕСТЬ В App.vue.
//
// `loadNotes` и `saveNotes` писали три модуля независимо: attachments.js
// (L251, L420), send.js (L90) — каждый делал `const list = ctx.loadNotes();
// list.push(...)`. Это одновременно (а) ложное срабатывание alias-эвристики
// (loadNotes() = JSON.parse, свежая копия), и (b) НАСТОЯЩАЯ связность: три
// модуля ходят в один и тот же localStorage-ключ `vault-notes-<email>`,
// мутируя массив, который считали не зная друг о друге.
//
// notes-store.js переносит владение ключом в одно место. После правки
// `loadNotes`/`saveNotes` исчезают из moduleFields feature-модулей, а `notes`
// остаётся только READ (вызов методов через ctx.notes.*). Метрика
// sharedWriteFields падает с 1 до 0 — и это факт, а не артефакт эвристики.
//
// ЭТО ЕДИНСТВЕННОЕ место, знающее про хранилище заметок (key 'vault-notes-<email>').
// При переносе на Rust меняются только этот файл (storage — прослойка), логика —
// владелец: createNotesStore() просто перестраивается на db.kvGet/db.kvSet.
//
// Никаких импортов (ни Vue, ни localStorage-обёртка извне). Vue-реактивность
// не нужна: заметки читаются по запросу — они не рендерятся в реальном времени,
// а отображаются после явного load().
//
// ПОЧЕМУ НЕТ `state` (как в chat-store/sending-store). Эти хранилища держат
// состояние в памяти и мутируют его через this.state.* через Vue Proxy. Заметки
// живут только в localStorage: каждый метод load() читает свежий JSON, каждый
// save() пишет. Состояние в памяти не нужно — иначе оно просто расходится с
// localStorage, как расходилось в App.vue до A15.
export function createNotesStore() {
  return {
    // Формат ключа localStorage. Вынесен сюда из App.vue notesStoreKey():
    // теперь ключ считает владелец, а не вызывающий.
    keyFor(email) {
      return 'vault-notes-' + (email || 'anon');
    },

    // Чтение: массив заметок или [] при битом JSON (как было в App.vue).
    load(email) {
      try {
        return JSON.parse(localStorage.getItem(this.keyFor(email)) || '[]');
      } catch (e) {
        return [];
      }
    },

    // Запись: сериализуем массив. Ошибка записи → false (как было).
    save(email, list) {
      try {
        localStorage.setItem(this.keyFor(email), JSON.stringify(list));
        return true;
      } catch (e) {
        console.error('Failed to save notes:', e);
        return false;
      }
    },

    // Добавление одной заметки: load → push → save.
    // Защита от дубля по id, если у note есть id (как в chat.append).
    // При ошибке save откат (pop) и false — заметка не добавилась.
    add(email, note) {
      const list = this.load(email);
      if (note && note.id != null && list.some((n) => n && n.id === note.id)) return false;
      list.push(note);
      if (!this.save(email, list)) {
        list.pop();
        return false;
      }
      return true;
    },

    // Удаление по id: load → фильтр → save.
    removeById(email, id) {
      const list = this.load(email);
      const filtered = list.filter((n) => n && n.id !== id);
      return this.save(email, filtered);
    },

    // Очистка всех заметок владельца.
    clear(email) {
      return this.save(email, []);
    },
  };
}