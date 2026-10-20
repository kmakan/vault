// Автоочистка: отсечение и чистка зеркал (ADR-003 Этап 3, партия 13).
//
// Очистка УДАЛЯЕТ. Поэтому здесь проверяется не «правильно ли считает», а
// «кого она точно не должна трогать». Три таких класса, и все три были
// защищены одним фильтром или его отсутствием.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/autoclean-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { purged: [], failPurge: false };
globalThis.__st = state;
writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
const db = {
  autocleanPurge: async (account, keysJson) => {
    if (st.failPurge) throw new Error('purge недоступен');
    const keys = JSON.parse(keysJson);
    st.purged.push({ account, keys });
    return keys.length * 3;
  },
};
export { db };
export default {};
`);

let src = readFileSync(path.join(ROOT, 'src', 'features', 'autoclean.js'), 'utf8');
src = src.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
writeFileSync(MOCKS + '/ac.mjs', src, 'utf8');
const A = await import(MOCKS + '/ac.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { state.purged = []; state.failPurge = false; };
const NOW = Date.UTC(2026, 9, 15);
const daysAgo = (n) => new Date(NOW - n * 86400000).toUTCString();

console.log('\nADR-003 Этап 3, партия 13 · автоочистка старых писем');

// ── Периоды ────────────────────────────────────────────────────────────
ok('1d → один день', A.periodDaysOf('1d') === 1);
ok('365d → год', A.periodDaysOf('365d') === 365);
ok('off → 0 (не чистим)', A.periodDaysOf('off') === 0);
ok('выдуманный период → 0, а не NaN', A.periodDaysOf('7') === 0);
ok('не строка → 0, без исключения', A.periodDaysOf(null) === 0);
ok('cutoff считается от «сейчас» минус срок',
  A.autocleanCutoff('7d', NOW) === NOW - 7 * 86400000);

// ── Ключ письма ────────────────────────────────────────────────────────
ok('ключ из папки и uid', A.messageKeyOf({ folder: 'INBOX', uid: 42 }) === 'INBOX:42');
ok('без папки подставляется INBOX', A.messageKeyOf({ uid: 7 }) === 'INBOX:7');
ok('uid важнее id', A.messageKeyOf({ uid: 1, id: 'm-2' }) === 'INBOX:1');
ok('uid = 0 — валидный ключ, а не пустой',
  A.messageKeyOf({ folder: 'INBOX', uid: 0, id: 'x' }) === 'INBOX:0');
// ?? ловит только null/undefined: пустая строка uid НЕ уступает место id,
// и ключ получается обрезанным. Это ловится фильтром ниже, но сам факт
// задокументирован, потому что ?? здесь читается как «uid или id».
ok('пустой uid даёт обрезанный ключ — ?? не ловит пустую строку',
  A.messageKeyOf({ uid: '', id: 'm-2' }) === 'INBOX:');

// ── ГЛАВНОЕ: кого очистка НЕ должна трогать ────────────────────────────
const emails = [
  { uid: 1, folder: 'INBOX', date: daysAgo(40) },   // старый — вычистить
  { uid: 2, folder: 'INBOX', date: daysAgo(2) },    // свежий — оставить
  { uid: 3, folder: 'INBOX' },                      // БЕЗ ДАТЫ — не трогать
  { uid: null, id: null, date: daysAgo(40) },      // БЕЗ ID — не трогать
  { uid: '', id: 'm-5', date: daysAgo(40) },        // пустой uid → обрезан — не трогать
  { id: 'm-6', date: daysAgo(40), folder: 'Archive' }, // id вместо uid
];
let keys = A.staleMessageKeys(emails, A.autocleanCutoff('30d', NOW));
// Первый вариант этой строки ждал только 'INBOX:1' и упал: письмо в папке Archive
// тоже старое, и вычистить его ПРАВИЛЬНО. Код был прав, ожидание — нет.
ok('вычищены оба старых письма, в любой папке',
  keys.join(',') === 'INBOX:1,Archive:m-6');
ok('свежее письмо не тронуто', !keys.includes('INBOX:2'));
ok('письмо БЕЗ ДАТЫ не тронуто — возраст неопределим', !keys.includes('INBOX:3'));
ok('письмо БЕЗ ИДЕНТИФИКАТОРА не тронуто — purge с INBOX: удалил бы по префиксу',
  !keys.some((k) => k.endsWith(':')));
ok('пустой uid не добавил обрезанного ключа', keys.length === 2);
ok('письмо по id (без uid) вычищается ключом папка:id',
  A.staleMessageKeys([emails[5]], A.autocleanCutoff('30d', NOW)).join(',') === 'Archive:m-6');

// Граница: ровно на cutoff — НЕ старым (строгое <).
// Граница строгая: «старше cutoff», поэтому РОВНО на границе — ещё не старый.
// Сравнение идёт по Date.parse, а строки UTC теряют миллисекунды, поэтому
// запас берётся сутками и проверка звучит однозначно.
keys = A.staleMessageKeys([{ uid: 9, date: daysAgo(29) }], A.autocleanCutoff('30d', NOW));
ok('29 дней при периоде 30d — ещё не старый', keys.length === 0);
keys = A.staleMessageKeys([{ uid: 9, date: daysAgo(31) }], A.autocleanCutoff('30d', NOW));
ok('31 день — уже старый', keys.join(',') === 'INBOX:9');

// Нечитаемая дата не должна считаться «очень старой».
keys = A.staleMessageKeys([{ uid: 10, date: 'не дата' }], A.autocleanCutoff('30d', NOW));
ok('нечитаемая дата не превращается в 1970 год и не вычищает письмо',
  keys.length === 0);

// Дубликаты ключей не должны дважды уйти в purge.
keys = A.staleMessageKeys(
  [{ uid: 5, date: daysAgo(40) }, { uid: 5, date: daysAgo(41) }], A.autocleanCutoff('30d', NOW));
ok('один и тот же ключ не дублируется', keys.join(',') === 'INBOX:5');

// ── Зеркала памяти ─────────────────────────────────────────────────────
const mirrors = {
  emails: [{ uid: 1 }, { uid: 2 }, { uid: 3 }],
  emailBodyCache: { 'INBOX:1': 'тело', 'INBOX:2': 'тело', 'INBOX:3': 'тело' },
  bodyCacheOrder: ['INBOX:1', 'INBOX:2', 'INBOX:3'],
};
let ap = A.applyPurge(mirrors, ['INBOX:1']);
ok('из emails удалён только адресат', ap.emails.length === 2);
ok('тело удалено из кэша', !('INBOX:1' in ap.emailBodyCache));
ok('чужие тела на месте', ap.emailBodyCache['INBOX:2'] === 'тело' && ap.emailBodyCache['INBOX:3'] === 'тело');
ok('порядок кэша почищен', ap.bodyCacheOrder.join(',') === 'INBOX:2,INBOX:3');

// БАГ, КОТОРЫЙ Я ВНЁС И КОТОРЫЙ ЕСТЬ В ТЕСТЕ.
// Первая версия runPurge звала applyPurge({ emails }) — без остальных зеркал.
// applyPurge пересобирает все три и для недостающих вернула бы ПУСТЫЕ: то есть
// вызывающий подставил бы пустой кэш тел и пустой порядок вместо своих.
ok('ВХОДНЫЕ ЗЕРКАЛА НЕ МУТИРУЮТСЯ', (() => {
  const before = JSON.stringify(mirrors);
  A.applyPurge(mirrors, ['INBOX:1']);
  return JSON.stringify(mirrors) === before;
})());
ok('и возвращается НОВЫЙ объект, а не тот же', ap.emailBodyCache !== mirrors.emailBodyCache);
ok('пустой результат applyPurge при отсутствии зеркал — это потеря данных',
  A.applyPurge({ emails: [] }, []).bodyCacheOrder.length === 0);

// ── Сквозной путь: purge в БД + зеркала ────────────────────────────────
reset();
let r = await A.runPurge('fp:me', {
  emails: [{ uid: 1, folder: 'INBOX', date: daysAgo(40) }, { uid: 2, folder: 'INBOX', date: daysAgo(1) }],
  emailBodyCache: { 'INBOX:1': 'a', 'INBOX:2': 'b' },
  bodyCacheOrder: ['INBOX:1', 'INBOX:2'],
}, A.autocleanCutoff('30d', NOW));
ok('в purge ушёл ровно один ключ', state.purged[0].keys.join(',') === 'INBOX:1');
ok('аккаунт передан', state.purged[0].account === 'fp:me');
ok('после очистки в emails осталось одно письмо', r.applied.emails.length === 1);
ok('и порядок кэша не пуст — баг выше не повторился',
  r.applied.bodyCacheOrder.join(',') === 'INBOX:2');

// Ничего старого — purge не вызывается вовсе.
reset();
r = await A.runPurge('fp:me', {
  emails: [{ uid: 7, folder: 'INBOX', date: daysAgo(1) }],
  emailBodyCache: { 'INBOX:7': 'x' },
  bodyCacheOrder: ['INBOX:7'],
}, A.autocleanCutoff('30d', NOW));
ok('нет старых → purge НЕ вызывается', state.purged.length === 0);
ok('и applied = null: зеркала не трогаем', r.applied === null);
ok('письмо на месте', (await A.runPurge('fp:me', {
  emails: [{ uid: 7, folder: 'INBOX', date: daysAgo(1) }], emailBodyCache: {}, bodyCacheOrder: [],
}, A.autocleanCutoff('30d', NOW))).applied === null);

reset();
state.failPurge = true;
let threw = false;
try {
  await A.runPurge('fp:me', { emails: [{ uid: 1, date: daysAgo(40) }], emailBodyCache: {}, bodyCacheOrder: [] },
    A.autocleanCutoff('30d', NOW));
} catch (e) { threw = true; }
ok('отказ purge пробрасывается — вызывающий ловит и предупреждает', threw === true);

// ── Поток из UI (ADR-005 W3, партия 12): runAutocleanFlow ─────────────
// Период из настроек, зеркала памяти обновляются ЦЕЛИКОМ, отказ purge —
// предупреждение, а не падение.
console.log('\nПоток автоочистки (runAutocleanFlow)');
{
  const calls = [];
  const deps = {
    isLoggedIn: () => true,
    account: () => 'fp:me',
    emails: () => [{ uid: 1, date: daysAgo(40) }],
    emailBodyCache: () => ({ 'INBOX:1': 'тело' }),
    bodyCacheOrder: () => ['INBOX:1'],
    loadPeriod: async () => '30d',
    applyMirrors: (a) => calls.push(['applyMirrors', a.emails.length, Object.keys(a.emailBodyCache).length]),
    persistBodyCache: () => calls.push(['persist']),
    logPurged: (b, m, p) => calls.push(['purged', b, m, p]),
    onError: (e) => calls.push(['error', e.message]),
  };
  reset();
  await A.runAutocleanFlow(deps);
  ok('поток: зеркала применены', calls.some((c) => c[0] === 'applyMirrors'), calls);
  ok('поток: кэш сохранён', calls.some((c) => c[0] === 'persist'), calls);
  ok('поток: отчёт записан', calls.some((c) => c[0] === 'purged' && c[3] === '30d'), calls);
  ok('поток: purge ушёл в namespace аккаунта', state.purged.length === 1 && state.purged[0].account === 'fp:me', state.purged);

  // Период из настроек отключён → чистки нет.
  reset();
  calls.length = 0;
  await A.runAutocleanFlow({ ...deps, loadPeriod: async () => 'off' });
  ok('поток: период off → ничего не чистим', calls.length === 0 && state.purged.length === 0, calls);

  // Не залогинены → чистки нет (даже если период задан).
  reset();
  calls.length = 0;
  await A.runAutocleanFlow({ ...deps, isLoggedIn: () => false }, '30d');
  ok('поток: не залогинен → ничего не чистим', calls.length === 0 && state.purged.length === 0, calls);

  // Явный период важнее настроек.
  reset();
  calls.length = 0;
  await A.runAutocleanFlow({ ...deps, loadPeriod: async () => '7d' }, '30d');
  ok('поток: явный период важнее периода из настроек',
    calls.some((c) => c[0] === 'purged' && c[3] === '30d'), calls);

  // Отказ purge — предупреждение, зеркала НЕ применяются.
  reset();
  state.failPurge = true;
  calls.length = 0;
  await A.runAutocleanFlow(deps);
  state.failPurge = false;
  ok('поток: отказ purge → onError, а не исключение', calls.some((c) => c[0] === 'error'), calls);
  ok('поток: при отказе зеркала НЕ применяются', !calls.some((c) => c[0] === 'applyMirrors'), calls);
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);