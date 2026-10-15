// Локальные кэши при старте (ADR-003 Этап 3, партия 11).
//
// Два свойства, оба о дефектах, а не о покрытии строк.
//
// 1. АСИММЕТРИЯ РАЗБИЕНИЯ. Запись ['msg-id', ''] означает «письмо удалено,
//    вложение — нет». Оно обязано попасть в первый кэш и НЕ попасть во второй.
//    Проверка по наличию ключа вместо проверки на истину засунула бы пустую
//    строку во второй кэш, и удалённые вложения начали бы считаться удалёнными
//    повсюду, где этот кэш читают.
//
// 2. ОТКАЗ НЕ РАВЕН ПУСТОТЕ. При отказе БД поле остаётся null, и вызывающий
//    обязан оставить прежнее значение. Если бы отказ возвращал [], один сбой
//    Rust стирал бы всё, что накопилось: удалённые письма перестали бы
//    помечаться, и в переписке появились бы «удалённые, но видимые» сообщения.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/local-db-init-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = {
  tombs: [],
  tombsThrow: false,
  cursors: null,
  cursorsThrow: false,
  nsCalls: [],
};
globalThis.__st = state;

writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
const db = {
  tombstonesLoad: async (account) => {
    st.nsCalls.push(account);
    if (st.tombsThrow) throw new Error('tombstonesLoad недоступен');
    return st.tombs;
  },
  cursorsLoad: async (account) => {
    if (st.cursorsThrow) throw new Error('cursorsLoad недоступен');
    return st.cursors;
  },
};
export { db };
export default {};
`);

// identity.js тянет за собой crypto.js; здесь нужен только резолвер namespace.
writeFileSync(MOCKS + '/identity.js', `
const st = globalThis.__st;
export const accountNamespace = async (email) => 'fp:' + String(email || '').toLowerCase();
export default {};
`);

let src = readFileSync(path.join(ROOT, 'src', 'features', 'local-db-init.js'), 'utf8');
src = src.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
src = src.replace("from '../identity.js'", `from "${MOCKS}/identity.js"`);
writeFileSync(MOCKS + '/ldi.mjs', src, 'utf8');
const M = await import(MOCKS + '/ldi.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { state.tombs = []; state.tombsThrow = false; state.cursors = null; state.cursorsThrow = false; state.nsCalls = []; };

console.log('\nADR-003 Этап 3, партия 11 · локальные кэши при старте');

// ── splitTombstones: асимметрия ────────────────────────────────────────
let sp = M.splitTombstones([['m1', 'a1'], ['m2', 'a2']]);
ok('полная пара попадает в оба кэша',
  sp.tombstones.join(',') === 'm1,m2' && sp.midTombstones.join(',') === 'a1,a2');

sp = M.splitTombstones([['m1', '']]);
ok('пустой mid → только в первый кэш',
  sp.tombstones.join(',') === 'm1' && sp.midTombstones.length === 0);

sp = M.splitTombstones([['', 'a1']]);
ok('пустой msg-id → только во второй кэш',
  sp.tombstones.length === 0 && sp.midTombstones.join(',') === 'a1');

sp = M.splitTombstones([['', '']]);
ok('пустая пара не попадает никуда',
  sp.tombstones.length === 0 && sp.midTombstones.length === 0);

sp = M.splitTombstones([]);
ok('пустой вход → два пустых массива (НЕ null)',
  sp.tombstones.length === 0 && sp.midTombstones.length === 0);

// ── loadLocalCaches: разные пространства имён для одних строк ──────────
reset();
state.tombs = [['m1', 'a1']];
state.cursors = { INBOX: '42' };
let r = await M.loadLocalCaches('Me@Bk.RU');
ok('тумбстоуны грузятся из namespace аккаунта (fp:<отпечаток>)',
  state.nsCalls[0] === 'fp:me@bk.ru');
ok('разбиение применено', r.tombstones.join(',') === 'm1' && r.midTombstones.join(',') === 'a1');
ok('курсоры загружены', r.cursors.INBOX === '42');

reset();
r = await M.loadLocalCaches(null);
ok('без почты — namespace anon, не fp:undefined', state.nsCalls[0] === 'anon');

// ── ОТКАЗ НЕ РАВЕН ПУСТОТЕ ──────────────────────────────────────────────
reset();
state.tombsThrow = true;
state.cursors = { INBOX: '7' };
r = await M.loadLocalCaches('me@bk.ru');
ok('отказ тумбстоунов → null, не []', r.tombstones === null && r.midTombstones === null);
ok('при этом курсоры всё равно загружены — сбой одного не роняет остальное',
  r.cursors.INBOX === '7');

reset();
state.tombs = [['m1', 'a1']];
state.cursorsThrow = true;
r = await M.loadLocalCaches('me@bk.ru');
ok('отказ курсоров → null, не []', r.cursors === null);
ok('тумбстоуны при этом загружены', r.tombstones.join(',') === 'm1');

reset();
state.tombsThrow = true;
state.cursorsThrow = true;
r = await M.loadLocalCaches('me@bk.ru');
ok('оба отказа → все три поля null, без исключения',
  r.tombstones === null && r.midTombstones === null && r.cursors === null);

// ГЛАВНОЕ: присваивание в App.vue — `if (r.tombstones)`, и пустой массив
// проходит эту проверку (он истинен), а null — нет. Проверяем, что вызывающий
// при отказе действительно ничего не затрёт.
reset();
state.tombs = [];
state.cursors = null;
r = await M.loadLocalCaches('me@bk.ru');
const cache = ['прежний-id'];
if (r.tombstones) cache.splice(0, cache.length, ...r.tombstones);
ok('загрузилось и правда пусто → кэш заменяется пустым (это не отказ)',
  cache.length === 0);
reset();
state.tombsThrow = true;
r = await M.loadLocalCaches('me@bk.ru');
const cache2 = ['прежний-id'];
if (r.tombstones) cache2.splice(0, cache2.length, ...r.tombstones);
ok('отказ → прежнее значение НА МЕСТЕ, ничего не стёрто',
  cache2.length === 1 && cache2[0] === 'прежний-id');

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);