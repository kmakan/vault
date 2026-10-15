// Правило склейки адресов по одному ключу (ADR-003 Этап 3, партия 3).
//
// Здесь проверяется не «функция вызвалась», а СЕМАНТИКА, которая годами жила
// методом App.vue без единого теста. Ошибка в ней не падает — она молча теряет
// историю чата: старый адрес не попадает в алиасы, и перенос при смене почты
// не находит, куда переносить.
//
// Четыре случая, на которых ломается:
//   1. два адреса с ОДНИМ ключом → в списке только более новый (added_at),
//      старый обязан попасть в алиасы к новому;
//   2. адреса приходят в ОБРАТНОМ порядке (новый раньше старого) → результат
//      тот же, но алиаса угадывать нельзя: проверяем именно по added_at;
//   3. контакт БЕЗ public_key → нельзя склеивать по ключу (иначе он схлопнется
//      с чужим), обязан остаться отдельной записью;
//   4. себя в списке быть не должно.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/contacts-load-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

globalThis.__contacts = [];
globalThis.__throw = false;
writeFileSync(MOCKS + '/api.js', `
export default {
  getContacts: async () => {
    if (globalThis.__throw) throw new Error('/api/contacts недоступен');
    return globalThis.__contacts;
  },
};
`);
let s = readFileSync(path.join(ROOT, 'src', 'features', 'contacts-load.js'), 'utf8');
s = s.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
writeFileSync(MOCKS + '/contacts-load.mjs', s, 'utf8');
const CL = await import(MOCKS + '/contacts-load.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, why) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name, why || ''); } };
const emails = (list) => list.map(c => c.email).sort();

console.log('\nADR-003 Этап 3, партия 3 · склейка контактов по ключу');

// 1. Один ключ — два адреса, новый вторым по списку.
globalThis.__contacts = [
  { email: 'old@bk.ru', public_key: 'K1', added_at: '2026-01-01' },
  { email: 'new@bk.ru', public_key: 'K1', added_at: '2026-09-01' },
  { email: 'other@x',    public_key: 'K2', added_at: '2026-01-01' },
];
let r = await CL.loadContacts('me@bk.ru');
ok('в списке один адрес на ключ', emails(r.contacts).join(',') === 'new@bk.ru,other@x');
ok('старый адрес стал алиасом нового',
  JSON.stringify(r.contactAliases) === JSON.stringify({ 'new@bk.ru': ['old@bk.ru'] }));

// 2. Тот же ключ, но новый адрес ПЕРВЫМ по списку — результат обязан быть тот же.
globalThis.__contacts = [
  { email: 'new@bk.ru', public_key: 'K1', added_at: '2026-09-01' },
  { email: 'old@bk.ru', public_key: 'K1', added_at: '2026-01-01' },
];
r = await CL.loadContacts('me@bk.ru');
ok('порядок в ответе не влияет: виден более новый', emails(r.contacts).join(',') === 'new@bk.ru');
ok('алиас восстановлен по added_at, а не по позиции',
  JSON.stringify(r.contactAliases) === JSON.stringify({ 'new@bk.ru': ['old@bk.ru'] }));

// 3. Контакт без ключа не склеивается.
globalThis.__contacts = [
  { email: 'nokey1@x' },
  { email: 'nokey2@x' },
];
r = await CL.loadContacts('me@bk.ru');
ok('контакты без public_key остаются отдельными', emails(r.contacts).join(',') === 'nokey1@x,nokey2@x');
ok('и не порождают алиасов', Object.keys(r.contactAliases).length === 0);

// 4. Себя не показываем.
globalThis.__contacts = [
  { email: 'me@bk.ru',  public_key: 'KM' },
  { email: 'other@x',   public_key: 'K2' },
];
r = await CL.loadContacts('me@bk.ru');
ok('свой контакт отфильтрован', emails(r.contacts).join(',') === 'other@x');

// 5. Три адреса на один ключ.
// Фактическое поведение — ЦЕПОЧКА, а не плоский список: a2→a1, потом a3→a2.
// Алгоритм на каждом шаге помнит только непосредственного предшественника.
// Тест ПЕРВОГО издания утверждал «у нового оба алиаса» и падал. Это не баг
// теста, а находка: contactAliases вообще никем не читается (8 вхождений в
// коде, все на запись), поэтому форма не влияет ни на что. Менять её здесь
// нельзя — это рефакторинг перемещения, а он не должен менять поведение.
// Форма зафиксирована как есть, решение «дописать потребителя или убрать
// вычисление» вынесено в ADR-003 §5.
globalThis.__contacts = [
  { email: 'a1@x', public_key: 'K1', added_at: '2026-01-01' },
  { email: 'a2@x', public_key: 'K1', added_at: '2026-05-01' },
  { email: 'a3@x', public_key: 'K1', added_at: '2026-09-01' },
];
r = await CL.loadContacts('me@bk.ru');
ok('три адреса → виден последний', emails(r.contacts).join(',') === 'a3@x');
ok('алиасы образуют цепочку предшественников, а не плоский список',
  JSON.stringify(r.contactAliases) === JSON.stringify({ 'a2@x': ['a1@x'], 'a3@x': ['a2@x'] }),
  'форма зафиксирована как есть; потребителя у неё нет');

// 6. Ошибка: contacts пустой, а contactAliases = null (НЕ перетираем прежние).
globalThis.__throw = true;
r = await CL.loadContacts('me@bk.ru');
ok('при ошибке contacts пуст', Array.isArray(r.contacts) && r.contacts.length === 0);
ok('при ошибке contactAliases = null, а не {} — иначе потерялась бы привязка истории',
  r.contactAliases === null);
globalThis.__throw = false;

// 7. Пустой ответ.
globalThis.__contacts = [];
r = await CL.loadContacts('me@bk.ru');
ok('пустой ответ → пустой список', r.contacts.length === 0 && Object.keys(r.contactAliases).length === 0);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);