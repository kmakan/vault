// Архив переписки (chat_history) — на ДЕФЕКТ, а не на строки.
//
// Наблюдаемый дефект (живые данные 22.10.2026): только что отправленное
// сообщение исчезало из чата, «чат менялся», переписка пропадала после
// перезапуска. Причина — saveHistory перезаписывал архив тем, что лежит на
// экране СЕЙЧАС. Пустой или неполный список (гонка открытия чата с поллингом,
// письма ещё не расшифровались, контакт без ключа) затирал переписку насовсем:
// chat_history для активного чата превращался в "[]".
//
// Правило, которое проверяем: история — АРХИВ. Запись дополняет его и
// обновляет статусы/правки, но никогда не укорачивает и не обнуляет. Мусорные
// записи ("{}" из старых сборок) не хранятся и не рендерятся.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/history-archive-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// sqlite-двойник: та же семантика «одна строка на (account, chat_key)».
globalThis.__historyRows = new Map();
writeFileSync(
  MOCKS + '/api.js',
  `export const db = {
    historyLoad: async (account, chatKey) => globalThis.__historyRows.get(account + '||' + chatKey) ?? null,
    historySave: async (account, chatKey, json) => { globalThis.__historyRows.set(account + '||' + chatKey, json); },
  };`,
);
// namespace-двойник: резолвер идемпотентен, как настоящий.
writeFileSync(
  MOCKS + '/identity.js',
  `export const accountNamespace = async (email) => 'fp:test:' + String(email || 'anon').toLowerCase();`,
);
writeFileSync(
  MOCKS + '/history.mjs',
  readFileSync(path.join(ROOT, 'src', 'history.js'), 'utf8'),
);
const H = await import(MOCKS + '/history.mjs');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ПРОВАЛ: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

const ME = 'icemaksim@gmail.com';
const CHAT = 'koanmak@ya.ru';
const load = async () => (await H.loadHistory(ME, CHAT)) || [];

console.log('\nАрхив переписки: запись не укорачивает историю');

// 1. Базовая запись
await H.saveHistory(ME, CHAT, [
  { id: 'a', content: 'привет', from: 'them', ts: 1000 },
  { id: 'b', content: 'ответ', from: 'me', ts: 2000, status: 'sent' },
]);
check('два сообщения записались', (await load()).length === 2);

// 2. ГЛАВНОЕ: пустой список не стирает архив (так переписка и пропадала)
await H.saveHistory(ME, CHAT, []);
check('saveHistory([]) НЕ стирает архив', (await load()).length === 2, await load());

// 3. Неполный список (гонка: чат успел показать одно письмо) — остальные живы
await H.saveHistory(ME, CHAT, [
  { id: 'b', content: 'ответ', from: 'me', ts: 2000, status: 'delivered' },
]);
{
  const list = await load();
  check('неполный список не укорачивает архив', list.length === 2, list.map(m => m.id));
  check('новый статус существующего сообщения выигрывает',
    list.find(m => m.id === 'b')?.status === 'delivered', list.find(m => m.id === 'b'));
  check('сообщение, которого нет в новом списке, осталось',
    list.some(m => m.id === 'a'));
}

// 4. Новое сообщение добавляется, порядок не теряется
await H.saveHistory(ME, CHAT, [
  { id: 'c', content: 'новое', from: 'me', ts: 3000, status: 'sending' },
]);
check('новое сообщение добавилось к архиву', (await load()).length === 3);

// 5. Мусор "{}" из старых сборок: не хранится, не рендерится
await H.saveHistory(ME, CHAT, [{}, {}, { id: 'd', content: 'живое', from: 'them', ts: 4000 }]);
{
  const list = await load();
  check('пустые объекты не попадают в архив', list.every(m => m && (m.id || m.content !== undefined)), list);
  check('живое сообщение сохранилось', list.some(m => m.id === 'd'));
}

// 6. Тот же текст в разное время — это РАЗНЫЕ сообщения (не схлопываются)
await H.saveHistory(ME, CHAT, [
  { id: 'e1', content: 'ок', from: 'me', ts: 5000 },
  { id: 'e2', content: 'ок', from: 'me', ts: 6000 },
]);
{
  const list = await load();
  check('два «ок» с разными id — обе записи', list.some(m => m.id === 'e1') && list.some(m => m.id === 'e2'));
}

// 7. Другой чат не затронут
await H.saveHistory(ME, 'другой@x.ru', [{ id: 'z', content: 'чужой чат', from: 'them', ts: 7000 }]);
check('изоляция чатов: второй чат не влияет на первый',
  (await load()).length >= 4 && (await H.loadHistory(ME, 'другой@x.ru')).length === 1);

// 8. Слияние — это read-modify-write. Два поллинга одного чата, запущенные
// подряд без await, обязаны дать ОБА набора: без очереди на ключ они читают
// один и тот же prev, и позже записанный затирает более свежий (сообщение
// «исчезает» из архива).
{
  const P = 'parallel@x.ru';
  const before = (await H.loadHistory(ME, P)) || [];
  const p1 = H.saveHistory(ME, P, [...before, { id: 'p1', content: 'раз', from: 'me', ts: 8000 }]);
  const p2 = H.saveHistory(ME, P, [...before, { id: 'p2', content: 'два', from: 'me', ts: 9000 }]);
  await Promise.all([p1, p2]);
  const list = (await H.loadHistory(ME, P)) || [];
  check('параллельные записи не затирают друг друга',
    list.some(m => m.id === 'p1') && list.some(m => m.id === 'p2'), list.map(m => m.id));
}

// 9. Чтение сразу после записи видит запись (чтением нельзя «откатиться»)
{
  const P = 'fresh-read@x.ru';
  H.saveHistory(ME, P, [{ id: 'fr', content: 'свежее', from: 'me', ts: 8500 }]);
  const list = (await H.loadHistory(ME, P)) || [];
  check('чтение сразу после записи видит записанное', list.some(m => m.id === 'fr'), list.map(m => m.id));
}

// 10. ЧИТАТЕЛЬ чистит архив сам, а не полагается на писателя. Строку могли
// оставить старые сборки (и любой прямой писатель в sqlite): если фильтр
// живёт только в merge при записи — мутация чтения незамеченной и чат
// откроется пустыми пузырями.
{
  const P = 'junk@x.ru';
  const rows = globalThis.__historyRows;
  rows.set('fp:test:' + ME.toLowerCase() + '||' + P,
    JSON.stringify([{}, {}, { id: 'ok', content: 'живое', from: 'them', ts: 9000 }]));
  const list = (await H.loadHistory(ME, P)) || [];
  check('чтение отбрасывает `{}` из уже записанного архива',
    list.length === 1 && list[0].id === 'ok', list);
}

// 11. Записям без id выдаётся СТАБИЛЬНЫЙ id: без него не работают реакции и
// правки (chat.patch ищет по id, пикер сравнивает reactionPickerId === msg.id)
{
  const P = 'noid@x.ru';
  const rows = globalThis.__historyRows;
  rows.set('fp:test:' + ME.toLowerCase() + '||' + P,
    JSON.stringify([{ content: 'старое без id', from: 'them', ts: 9500 }]));
  const first = (await H.loadHistory(ME, P)) || [];
  const second = (await H.loadHistory(ME, P)) || [];
  check('запись без id получила id', !!first[0] && !!first[0].id, first);
  check('id стабилен между чтениями (реакция не «соскакивает»)',
    first[0] && second[0] && first[0].id === second[0].id, [first[0] && first[0].id, second[0] && second[0].id]);
  rows.set('fp:test:' + ME.toLowerCase() + '||' + P,
    JSON.stringify([{ content: 'старое без id', from: 'them', ts: 9500 },
                    { content: 'другое', from: 'them', ts: 9600 }]));
  const two = (await H.loadHistory(ME, P)) || [];
  check('разные записи без id получают разные id',
    two.length === 2 && two[0].id !== two[1].id, two.map(m => m.id));
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
