// Переезд участника группы по совпадению ключа (ADR-003 Этап 3, партия 4).
//
// Здесь тест — это страховка от ПОРЧИ ДАННЫХ, а не покрытие строк. Случай
// 06.10.2026: ренейм по отпечатку удаляет старый адрес из кэша peerKeys, поиск
// по одному кэшу ничего не находит, groups_rename_member не вызывается, и в
// группе остаются ДВА участника с одним отпечатком. Поэтому поиск идёт по трём
// источникам, и на КАЖДЫЙ источник здесь отдельная проверка: убрать любой —
// значит вернуть тот баг.
//
// Три источника по порядку: (1) кэш peerKeys в памяти, (2) файл
// peer_keys.json через load_peer_keys, (3) поле fingerprint у самого участника
// группы (сверка с get_fingerprint нового ключа).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/groups-migrate-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { diskKeys: [], fps: {}, renamed: [], failRename: false, failDisk: false, diskKeysNotArray: false };
globalThis.__state = state;
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'load_peer_keys') {
    if (state.failDisk) throw new Error('load_peer_keys недоступен');
    if (state.diskKeysNotArray) return 'НЕ-МАССИВ';
    return state.diskKeys;
  }
  if (cmd === 'get_fingerprint') {
    if (state.fps[args.publicKey] === undefined) throw new Error('ключ неизвестен');
    return state.fps[args.publicKey];
  }
  if (cmd === 'groups_rename_member') {
    if (state.failRename) throw new Error('groups_rename_member отказал');
    state.renamed.push(args); return null;
  }
  return null;
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');

let s = readFileSync(path.join(ROOT, 'src', 'features', 'groups-migrate.js'), 'utf8');
s = s.replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`);
writeFileSync(MOCKS + '/groups-migrate.mjs', s, 'utf8');
const GM = await import(MOCKS + '/groups-migrate.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { state.diskKeys = []; state.fps = {}; state.renamed = []; state.failRename = false; state.failDisk = false; state.diskKeysNotArray = false; };

console.log('\nADR-003 Этап 3, партия 4 · переезд участника группы по ключу');

const NEWKEY = 'KNEW';
const NEWFP = 'FP-NEW';
const grp = (members) => ({ id: 'g1', members });

// ── 0. Нет нового ключа → делать нечего ───────────────────────────────
reset();
ok('без нового ключа возвращает false и ничего не переименовывает',
  (await GM.tryMigrateGroupMember({}, grp([{ email: 'a@x' }]), 'b@x')) === false
  && state.renamed.length === 0);

// ── 1. Источник 1: кэш в памяти ───────────────────────────────────────
reset();
state.fps[NEWKEY] = NEWFP;
let r = await GM.tryMigrateGroupMember(
  { 'old@x': NEWKEY, 'new@x': NEWKEY }, grp([{ email: 'old@x' }]), 'new@x');
ok('источник 1 (кэш): участник найден и переименован', r === true && state.renamed.length === 1);
ok('источник 1: верные аргументы переименования',
  state.renamed[0].oldEmail === 'old@x' && state.renamed[0].newEmail === 'new@x'
  && state.renamed[0].groupId === 'g1');

// ── 2. Источник 2: файл на диске, кэш уже почищен ─────────────────────
// Именно этот сценарий и портил данные: в кэше старого адреса нет.
reset();
state.fps[NEWKEY] = NEWFP;
state.diskKeys = [{ email: 'old@x', public_key: NEWKEY }];
r = await GM.tryMigrateGroupMember({ 'new@x': NEWKEY }, grp([{ email: 'old@x' }]), 'new@x');
ok('источник 2 (файл): кэш пуст, участник найден на диске', r === true && state.renamed.length === 1);
ok('источник 2: это тот же случай 06.10 — без него был бы дубль участника',
  state.renamed[0] && state.renamed[0].oldEmail === 'old@x');

// ── 3. Источник 3: fingerprint участника группы ────────────────────────
// Рейенм по отпечатку стёр и кэш, и groups.json не помогает — остаётся поле
// fingerprint у самого участника.
reset();
state.fps[NEWKEY] = NEWFP;
r = await GM.tryMigrateGroupMember(
  { 'new@x': NEWKEY }, grp([{ email: 'old@x', fingerprint: NEWFP }]), 'new@x');
ok('источник 3 (fingerprint): участник найден', r === true && state.renamed.length === 1);

// ── 4. Чужой участник не трогаем ───────────────────────────────────────
reset();
state.fps[NEWKEY] = NEWFP;
state.diskKeys = [{ email: 'other@x', public_key: 'KOTHER' }];
r = await GM.tryMigrateGroupMember(
  { 'new@x': NEWKEY }, grp([{ email: 'other@x', fingerprint: 'FP-OTHER' }]), 'new@x');
ok('чужой участник не переименовывается', r === false && state.renamed.length === 0);

// ── 5. Уже под новым адресом — нечего делать ───────────────────────────
reset();
state.fps[NEWKEY] = NEWFP;
r = await GM.tryMigrateGroupMember({ 'new@x': NEWKEY }, grp([{ email: 'new@x' }]), 'new@x');
ok('участник уже под новым адресом → false', r === false && state.renamed.length === 0);

// ── 6. Поле fingerprint у группы проставляется устаревшему ─────────────
reset();
state.fps[NEWKEY] = NEWFP;
const members = [{ email: 'old@x' }];
// Ключ нужен под ОБОИМИ адресами: newKey ищется по новому (`from`), а
// устаревший участник опознаётся по старому. Первый вариант теста дал только
// 'old@x' и упал — функция вернула false, и это правильно: искать нечего.
r = await GM.tryMigrateGroupMember({ 'old@x': NEWKEY, 'new@x': NEWKEY }, grp(members), 'new@x');
ok('после переезда у участника проставлены email, key_shared и fingerprint',
  r === true && members[0].email === 'new@x' && members[0].key_shared === true
  && members[0].fingerprint === NEWFP);

// ── 7. Операционные отказы остаются «мягкими» ──────────────────────────
reset();
state.fps[NEWKEY] = undefined; // get_fingerprint бросит
r = await GM.tryMigrateGroupMember(
  { 'new@x': NEWKEY }, grp([{ email: 'old@x', fingerprint: 'FP-ANY' }]), 'new@x');
ok('недоступный get_fingerprint → false, не исключение', r === false);

reset();
state.fps[NEWKEY] = NEWFP;
state.failRename = true;
const members7 = [{ email: 'old@x' }];
r = await GM.tryMigrateGroupMember(
  { 'old@x': NEWKEY, 'new@x': NEWKEY }, grp(members7), 'new@x');
ok('отказ groups_rename_member → false, не исключение', r === false);
ok('при отказе записи локальный объект НЕ тронут (key_shared не выдуман)',
  members7[0].email === 'old@x' && members7[0].key_shared === undefined);

// ── 8. Ошибка ПРОГРАММИРОВАНИЯ ПРОБРАСЫВАЕТСЯ (ADR-003 §5.2) ───────────
// Это и есть смысл правки. Раньше blanket-catch глотал всё и возвращал false:
// опечатка в рефакторинге выглядела как «переезжать нечего», группа оставалась
// с двумя участниками на один отпечаток, и это было не видно нигде, кроме
// строчки console.warn, которую никто не читает.
reset();
state.fps[NEWKEY] = NEWFP;
// Ломаем ВХОД: peerKeys = null. Раньше это давало TypeError, проглоченный catch.
let threw = false, msg = '';
try {
  await GM.tryMigrateGroupMember(null, grp([{ email: 'old@x' }]), 'new@x');
} catch (e) { threw = true; msg = String((e && e.message) || e); }
ok('битый вход ПРОБРАСЫВАЕТ исключение, а не возвращает false', threw === true);
ok('и это именно TypeError, а не «группа не найдена»', /null|undefined|is not/i.test(msg));

// Ловится РОВНО отказ записи. Всё, что не поймано локально, обязано дойти до
// вызывающего: load_peer_keys ниже защищён своим catch, поэтому чтобы доказать
// «остальное пробрасывается», ломаем не бросок invoke, а его результат —
// не-массив. Тогда .find упадёт TypeError'ом ВНЕ локального catch.
reset();
state.fps[NEWKEY] = NEWFP;
state.diskKeysNotArray = true;
threw = false;
try {
  // В кэше ТОЛЬКО новый адрес. Иначе поиск совпадёт на источнике 1 и выйдет
  // раньше, не дойдя до .find — и проверка ничего не сказала бы (так и вышло
  // в первой версии теста: кейс проходил, потому что кода не касался).
  await GM.tryMigrateGroupMember(
    { 'new@x': NEWKEY }, grp([{ email: 'old@x' }]), 'new@x');
} catch (e) { threw = true; }
ok('TypeError в середине поиска пробрасывается, а не глотается', threw === true);

// Для контраста: БРОСОК из load_peer_keys ловится локально и поиск идёт дальше.
reset();
state.fps[NEWKEY] = NEWFP;
state.failDisk = true;
state.diskKeys = [{ email: 'old@x', public_key: NEWKEY }];
threw = false;
let r8 = false;
try {
  r8 = await GM.tryMigrateGroupMember(
    { 'new@x': NEWKEY }, grp([{ email: 'old@x' }]), 'new@x');
} catch (e) { threw = true; }
ok('а бросок load_peer_keys ловится локально: поиск идёт по третьему источнику',
  threw === false);
// источник 3 не сработал бы (нет fingerprint), поэтому переезда нет — важно, что
ok('и при этом БЕЗ исключения', r8 === false);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);