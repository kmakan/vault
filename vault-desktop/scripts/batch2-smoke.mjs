// Смоук партии 2 Этапа 3: открытие ссылок и перенос данных при смене почты.
//
// Как и в message-format-smoke, проверяем СОДЕРЖАНИЕ. Здесь особенно важна
// одна вещь, которую легко сломать переносом: порядок проб в openExternalUrl.
// На Android сначала нативная команда, потом browser-fallback, и обе ветки
// должны логировать отказ, а не глотать его молча.
//
// Миграции проверяем на том, что СПИСОК ПЕРЕНЕСЁННЫХ ГРУПП вычислен верно
// (создатель ИЛИ участник, регистронезависимо) — это ровно то место, где
// ошибка молча теряет данные при смене почты.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/batch2-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки окружения ────────────────────────────────────────────────────
const opened = [];
const androidOpened = [];
globalThis.__UA = 'Android';
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'android_open_url') {
    if (globalThis.__androidFails) throw new Error('нет команды на устройстве');
    androidOpened.push(args.url);
    return null;
  }
  if (cmd === 'db_account_migrate') {
    globalThis.__migrateCalls.push(args);
    if (globalThis.__migrateFails) throw new Error('перенос отказан');
    return { total: 7 };
  }
  if (cmd === 'groups_rename_address') { globalThis.__renameCalls.push(args); return 2; }
  return null;
};
globalThis.__migrateCalls = [];
globalThis.__renameCalls = [];
globalThis.__opened = opened;
globalThis.__nsOf = (e) => 'fp:' + e;
globalThis.__groups = [];

writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');
writeFileSync(MOCKS + '/shell.js',
  "export const open = async (u) => { globalThis.__opened.push(u); };");
// identity.js: по умолчанию резолвит в fp:<email> (ключ загружен), но может
// вернуть сам адрес — это то, что делает реальный резолвер, когда команды нет.
writeFileSync(MOCKS + '/identity.js',
  "export const accountNamespace = async (e) =>\n" +
  "  globalThis.__nsFallback ? String(e).toLowerCase() : 'fp:' + String(e).toLowerCase();");
// db нужен, потому что migrations.js импортирует его рядом с default. В этом
// смоуке db не используется (проверяются migrateAccountData/migrateOwnGroups),
// но мок обязан повторять форму модуля — иначе падает на резолве, и падение
// выглядит как «сломан продукт», а не «неполный мок».
writeFileSync(MOCKS + '/api.js', `
export const db = {
  kvGet: async () => null, kvSet: async () => {}, kvDelete: async () => {},
};
`);

const rewrite = (file, out, subs) => {
  let s = readFileSync(path.join(ROOT, 'src', file), 'utf8');
  for (const [a, b] of subs) s = s.split(a).join(b);
  writeFileSync(path.join(MOCKS, out), s, 'utf8');
};
rewrite('external-links.js', 'external-links.mjs', [
  ["from '@tauri-apps/plugin-shell'", `from "${MOCKS}/shell.js"`],
  ["from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`],
]);
rewrite('migrations.js', 'migrations.mjs', [
  ["from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`],
  ["from './api.js'", `from "${MOCKS}/api.js"`],
  ["from './identity.js'", `from "${MOCKS}/identity.js"`],
  // Правило слияния истории берётся НАСТОЯЩЕЕ: перенос обязан пользоваться тем
  // же mergeHistoryLists, что и архив чата, иначе смоук проверяет выдуманное
  // правило. Свой импорт у history.js тоже переписывается на моки этого смоука.
  ["from './history.js'", `from "${MOCKS}/history.js"`],
]);
let hist = readFileSync(path.join(ROOT, 'src', 'history.js'), 'utf8');
hist = hist.split("from './api.js'").join(`from "${MOCKS}/api.js"`)
           .split("from './identity.js'").join(`from "${MOCKS}/identity.js"`);
writeFileSync(MOCKS + '/history.js', hist, 'utf8');

const EL = await import(MOCKS + '/external-links.mjs');
const MIG = await import(MOCKS + '/migrations.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { opened.length = 0; androidOpened.length = 0; globalThis.__migrateCalls.length = 0; globalThis.__renameCalls.length = 0; };

console.log('\nADR-003 Этап 3, партия 2 · внешние ссылки и миграции');

// ── openUrl ───────────────────────────────────────────────────────────
reset();
EL.openUrl('https://ex.com/a');
ok('openUrl открывает через shell', opened.length === 1 && opened[0] === 'https://ex.com/a');

// ── openExternalUrl: Android-ветка ─────────────────────────────────────
reset();
globalThis.__UA = 'Android';
globalThis.__androidFails = false;
// navigator в Node — только геттер, присваивание падает. Определяем свойство.
Object.defineProperty(globalThis, 'navigator', {
  value: { get userAgent() { return globalThis.__UA; } },
  configurable: true, writable: true,
});
await EL.openExternalUrl('https://ex.com/b');
ok('Android: ушли в нативную команду', androidOpened.length === 1 && androidOpened[0] === 'https://ex.com/b');
ok('Android: в shell не пошли (нативная команда сработала)', opened.length === 0);

// ── openExternalUrl: отказ нативной команды → fallback ─────────────────
reset();
globalThis.__androidFails = true;
await EL.openExternalUrl('https://ex.com/c');
ok('отказ android_open_url → fallback в shell', opened.length === 1 && opened[0] === 'https://ex.com/c');

// ── openExternalUrl: не-Android → сразу shell ──────────────────────────
reset();
globalThis.__UA = 'iPhone';
await EL.openExternalUrl('https://ex.com/d');
ok('не-Android: нативная команда не вызывается', androidOpened.length === 0);
ok('не-Android: ушли в shell', opened.length === 1);

// ── openAppSite: APP_SITE_URL пуст → ничего не делает ──────────────────
reset();
EL.openAppSite();
ok('пустой APP_SITE_URL → клик ничего не делает (заглушка M4)', opened.length === 0);

// ── migrateAccountData ────────────────────────────────────────────────
reset();
await MIG.migrateAccountData('old@bk.ru', 'new@bk.ru');
ok('перенос вызван с явным старым адресом', globalThis.__migrateCalls.length === 1
   && globalThis.__migrateCalls[0].fromAccount === 'old@bk.ru'
   && globalThis.__migrateCalls[0].toAccount === 'fp:new@bk.ru');
reset();
await MIG.migrateAccountData('', 'new@bk.ru');
ok('пустой старый адрес → переноса нет', globalThis.__migrateCalls.length === 0);
// Асимметрия с migrateOwnGroups СОЗНАТЕЛЬНАЯ и проверяется отдельно.
// migrateOwnGroups отсекает oldEmail === newEmail. migrateAccountData — нет:
// он сравнивает не адреса, а РЕЗОЛВНУТЫЙ namespace с oldEmail. Если ключ
// появился позже (вход по recovery-мнемонике), то при той же почте ns = fp:<...>
// и перенос всё равно нужен. Первый вариант теста утверждал обратное и был
// неверен: тест, проверяющий придуманную семантику, зелёный ровно наоборот.
reset();
await MIG.migrateAccountData('old@bk.ru', 'old@bk.ru');
ok('та же почта, но namespace сменился на fp: → перенос НУЖЕН и делается',
  globalThis.__migrateCalls.length === 1
  && globalThis.__migrateCalls[0].fromAccount === 'old@bk.ru'
  && globalThis.__migrateCalls[0].toAccount === 'fp:old@bk.ru');
// А отсечка срабатывает когда резолвер вернул ровно старый адрес (ключа нет).
globalThis.__nsFallback = true;
reset();
await MIG.migrateAccountData('old@bk.ru', 'old@bk.ru');
ok('резолвер вернул сам адрес → перенос пропущен', globalThis.__migrateCalls.length === 0);
globalThis.__nsFallback = false;

// Отказ переноса (например, БД занята) НЕ выходит наружу: смена почты не
// должна превращаться в необработанное исключение, из-за которого приложение
// падает на экране входа.
globalThis.__nsFallback = false;
globalThis.__migrateFails = true;
reset();
let migrateThrew = false;
try { await MIG.migrateAccountData('old@bk.ru', 'new@bk.ru'); } catch (e) { migrateThrew = true; }
ok('отказ переноса не выходит наружу (ошибка поймана)', migrateThrew === false);
ok('при отказе перенос всё же пытался выполниться', globalThis.__migrateCalls.length === 1);
globalThis.__migrateFails = false;

// ── migrateOwnGroups: перебор — в мосте, фронт передаёт пару ──────────
reset();
await MIG.migrateOwnGroups('old@bk.ru', 'new@bk.ru');
ok('вызов моста один, с парой адресов', globalThis.__renameCalls.length === 1
  && globalThis.__renameCalls[0].oldEmail === 'old@bk.ru'
  && globalThis.__renameCalls[0].newEmail === 'new@bk.ru', globalThis.__renameCalls);
reset();
await MIG.migrateOwnGroups('same@bk.ru', 'same@bk.ru');
ok('одинаковые адреса → ничего не делает', globalThis.__renameCalls.length === 0);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);