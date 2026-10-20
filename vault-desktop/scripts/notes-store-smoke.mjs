// Node-смоук features/notes-store.js — владелец заметок «для себя» (ADR-004 A15).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. features/notes.js (фича) и features/attachments.js
// (вложения) ЧИТАЮТ заметки через владельца, но сам владелец (add/removeById/
// clear/load/save) не был проверен ни одним смоуком: его покрытие было
// случайным (смоук фичи дёргал store.add побочно). Владелец — единственное
// место, которое знает про ключ localStorage 'vault-notes-<email>'; поломка
// него теряет заметки пользователя, и заметки — не то, что можно
// восстановить.
//
// ПРОВЕРЯЕМ:
//   * keyFor — формат ключа (и 'anon' для пустого email);
//   * load — массив; [] на отсутствующем ключе; [] на битом JSON;
//   * save — true; JSON в localStorage; false на исключении записи;
//   * add — добавление; ЗАЩИТА ОТ ДУБЛЯ по id; откат (false) при ошибке
//     записи — заметка НЕ остаётся в хранилище;
//   * removeById — удаление по id; чужие заметки целы;
//   * clear — список пуст.
//
// localStorage в Node нет — ставим заглушку ДО вызовов (модуль читает
// глобал в момент вызова, не на импорте).
import { createNotesStore } from '../src/features/notes-store.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

// ── Заглушка localStorage ───────────────────────────────────────────────
const mem = new Map();
let failWrite = false;
globalThis.localStorage = {
  getItem(k) { return mem.has(k) ? mem.get(k) : null; },
  setItem(k, v) {
    if (failWrite) throw new Error('quota exceeded');
    mem.set(k, String(v));
  },
  removeItem(k) { mem.delete(k); },
  clear() { mem.clear(); },
};

const store = createNotesStore();
const EMAIL = 'a@x.ru';

// ── keyFor ───────────────────────────────────────────────────────────────
ok('keyFor: email', store.keyFor(EMAIL) === 'vault-notes-a@x.ru', store.keyFor(EMAIL));
ok('keyFor: пустой email → anon', store.keyFor('') === 'vault-notes-anon', store.keyFor(''));
ok('keyFor: undefined → anon', store.keyFor(undefined) === 'vault-notes-anon', store.keyFor(undefined));

// ── load ─────────────────────────────────────────────────────────────────
ok('load: неизвестный ключ → []', JSON.stringify(store.load(EMAIL)) === '[]');
mem.set(store.keyFor(EMAIL), JSON.stringify([{ id: 1, text: 'раз' }]));
ok('load: читает сохранённое', store.load(EMAIL).length === 1 && store.load(EMAIL)[0].text === 'раз');
mem.set(store.keyFor(EMAIL), '{битый json');
ok('load: битый JSON → [] (не исключение)', JSON.stringify(store.load(EMAIL)) === '[]');

// ── save ─────────────────────────────────────────────────────────────────
ok('save: возвращает true', store.save(EMAIL, [{ id: 2 }]) === true);
ok('save: пишет JSON в localStorage',
  JSON.parse(mem.get(store.keyFor(EMAIL)))[0].id === 2, mem.get(store.keyFor(EMAIL)));
failWrite = true;
ok('save: ошибка записи → false', store.save(EMAIL, [{ id: 3 }]) === false);
failWrite = false;
ok('save: после ошибки данные прежние (запись не прошла)',
  JSON.parse(mem.get(store.keyFor(EMAIL)))[0].id === 2, mem.get(store.keyFor(EMAIL)));

// ── add ──────────────────────────────────────────────────────────────────
mem.set(store.keyFor(EMAIL), JSON.stringify([]));
ok('add: добавляет заметку', store.add(EMAIL, { id: 10, text: 'a' }) === true);
ok('add: заметка в хранилище', store.load(EMAIL).length === 1 && store.load(EMAIL)[0].id === 10);
ok('add: дубль по id отклонён (false)', store.add(EMAIL, { id: 10, text: 'dup' }) === false);
ok('add: после отказа дубля заметок по-прежнему одна', store.load(EMAIL).length === 1, store.load(EMAIL));
ok('add: заметка без id добавляется (id=null не считается дублем)',
  store.add(EMAIL, { text: 'без id' }) === true && store.load(EMAIL).length === 2, store.load(EMAIL));
ok('add: заметка с id=null добавляется', store.add(EMAIL, { id: null, text: 'n' }) === true);
// Откат при ошибке записи: заметка НЕ должна остаться.
failWrite = true;
ok('add: ошибка записи → false', store.add(EMAIL, { id: 20, text: 'rollback' }) === false);
failWrite = false;
ok('add: откат — заметка не осталась в хранилище',
  !store.load(EMAIL).some((n) => n && n.id === 20), store.load(EMAIL));
ok('add: чужая почта не затронута',
  JSON.stringify(store.load('b@x.ru')) === '[]', store.load('b@x.ru'));

// ── removeById ───────────────────────────────────────────────────────────
ok('removeById: удаляет по id', store.removeById(EMAIL, 10) === true);
ok('removeById: удалённой заметки нет',
  !store.load(EMAIL).some((n) => n && n.id === 10), store.load(EMAIL));
ok('removeById: чужие заметки целы', store.load(EMAIL).length === 2, store.load(EMAIL));
ok('removeById: несуществующий id — данные целы', store.removeById(EMAIL, 999) === true);
ok('removeById: количество не изменилось', store.load(EMAIL).length === 2, store.load(EMAIL));

// ── clear ────────────────────────────────────────────────────────────────
ok('clear: возвращает true', store.clear(EMAIL) === true);
ok('clear: список пуст', store.load(EMAIL).length === 0, store.load(EMAIL));

// ── Разделение по владельцу ─────────────────────────────────────────────
store.save('c@x.ru', [{ id: 1 }]);
ok('ключи разных владельцев не смешиваются',
  store.load('c@x.ru').length === 1 && store.load(EMAIL).length === 0);

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
