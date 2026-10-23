// Node-смоук features/group-access.js — права в открытой группе.
//
// Модуль ничего не РЕШАЕТ: ответ на «кто я и что мне можно» приходит из моста
// (`groups_access`), а здесь живёт только пара (groupId, access), защита от
// устаревшего ответа и очистка. Поэтому смоук проверяет не правила, а обмен:
// что именно уходит в мост, что применяется из ответа и что происходит, когда
// ответ приходит не той группе или после её закрытия.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-access-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const st = {
  calls: [],
  mode: 'ok',
  answer: null,
  defer: false,
  pending: {},
};
globalThis.__st = st;
globalThis.__invoke = (cmd, args) => {
  st.calls.push({ cmd, args });
  if (st.mode === 'reject') return Promise.reject(new Error('мост недоступен'));
  if (st.defer) {
    return new Promise((resolve) => { st.pending[args.groupId] = resolve; });
  }
  return Promise.resolve(st.answer);
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');
let s = readFileSync(path.join(ROOT, 'src', 'features', 'group-access.js'), 'utf8');
s = s.split("from '@tauri-apps/api/core'").join(`from "${MOCKS}/core.js"`);
writeFileSync(MOCKS + '/group-access.mjs', s, 'utf8');
const { createGroupAccessStore } = await import(MOCKS + '/group-access.mjs');

const store = createGroupAccessStore();
const identity = () => ({ email: 'me@bk.ru', fingerprint: 'AABB', aliases: ['old@bk.ru'] });
const answerFor = (marker) => ({
  is_mine: true, is_creator: false, is_admin: true, can_manage: true,
  members: [{ removable: true, settable_role: true, is_self: false, is_creator: false }],
  marker,
});
const reset = () => {
  store.clear();
  st.calls = [];
  st.mode = 'ok';
  st.defer = false;
  st.pending = {};
  st.answer = answerFor('ok');
};

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ ПРОВАЛ:', name); }
};

console.log('\nADR-005 W4, партия 4d · права в группе (group-access)');

// ── Что уходит в мост ─────────────────────────────────────────────────
reset();
let got = await store.select({ id: 'g1' }, identity);
ok('ответ моста применён', got && got.is_admin === true && store.state.access === got);
ok('открытая группа записана', store.state.groupId === 'g1');
ok('вызов один и это groups_access', st.calls.length === 1 && st.calls[0].cmd === 'groups_access');
ok('в мост ушли группа, адрес, отпечаток и алиасы',
  st.calls[0].args.groupId === 'g1'
  && st.calls[0].args.email === 'me@bk.ru'
  && st.calls[0].args.fingerprint === 'AABB'
  && st.calls[0].args.aliases.join(',') === 'old@bk.ru');

// ── Пустой ответ идентичности — не исключение ─────────────────────────
reset();
await store.select({ id: 'g2' }, () => undefined);
const a2 = st.calls[0].args;
ok('без данных идентичности уходят пустые значения, а не undefined',
  a2.email === '' && a2.fingerprint === '' && Array.isArray(a2.aliases) && a2.aliases.length === 0);

// ── Ни группы, ни идентичности — в мост не ходим ──────────────────────
reset();
ok('select(null) возвращает null', (await store.select(null, identity)) === null);
ok('и в мост не ходит', st.calls.length === 0);
ok('и прав не оставляет', store.state.access === null && store.state.groupId === null);

reset();
ok('группа без id — как «ничего не открыто»', (await store.select({}, identity)) === null && st.calls.length === 0);

reset();
let thrown = null;
let noIdentity = 'не вызвано';
try { noIdentity = await store.select({ id: 'g3' }, null); } catch (e) { thrown = e; }
ok('identity не функция — ответа не просим', thrown === null && noIdentity === null
  && st.calls.length === 0 && store.state.access === null);

// ── Смена группы сразу сбрасывает прежние права ───────────────────────
reset();
await store.select({ id: 'g1' }, identity);
const stale = store.state.access;
st.defer = true;
const pB = store.select({ id: 'g2' }, identity);
ok('до ответа новой группы права прежней сняты',
  store.state.access === null && stale !== null && store.state.groupId === 'g2');
st.pending.g2(answerFor('B'));
await pB;
ok('ответ новой группы применён', store.state.access.marker === 'B');

// ── Устаревший ответ не перебивает свежий ─────────────────────────────
reset();
st.defer = true;
const pA = store.select({ id: 'A' }, identity);
const pB2 = store.select({ id: 'B' }, identity);
st.pending.B(answerFor('B'));
await pB2;
st.pending.A(answerFor('A'));
const late = await pA;
ok('поздний ответ по покинутой группе отброшен', late === null);
ok('и права остались от текущей группы',
  store.state.access && store.state.access.marker === 'B' && store.state.groupId === 'B');

// ── Закрытие: права снимаются, ответ после clear не применяется ───────
reset();
await store.select({ id: 'D' }, identity);
ok('перед закрытием права есть', store.state.access !== null);
store.clear();
ok('clear снимает права открытой группы', store.state.access === null && store.state.groupId === null);

reset();
st.defer = true;
const pC = store.select({ id: 'C' }, identity);
store.clear();
st.pending.C(answerFor('C'));
await pC;
ok('ответ после закрытия не применён', store.state.access === null && store.state.groupId === null);

// ── Сбой моста — это «прав нет», а не исключение ──────────────────────
reset();
await store.select({ id: 'g1' }, identity);
st.mode = 'reject';
const failed = await store.select({ id: 'g1' }, identity);
ok('сбой моста возвращает null, а не бросает', failed === null);
ok('и прав не оставляет', store.state.access === null);

// ── refresh: только для открытой группы, по её id ─────────────────────
reset();
ok('refresh без открытой группы не ходит в мост',
  (await store.refresh(identity)) === null && st.calls.length === 0);

reset();
st.defer = true;
const pSel = store.select({ id: 'g1' }, identity);
st.pending.g1(answerFor('first'));
await pSel;
st.defer = false;
st.answer = answerFor('second');
const refreshed = await store.refresh(identity);
ok('refresh спрашивает ту же группу', st.calls.length === 2 && st.calls[1].args.groupId === 'g1');
ok('и применяет свежий ответ', refreshed.marker === 'second' && store.state.access.marker === 'second');

reset();
await store.select({ id: 'g1' }, identity);
let refreshThrown = null;
let refreshRes = 'не вызвано';
try { refreshRes = await store.refresh(null); } catch (e) { refreshThrown = e; }
ok('refresh с открытой группой, но без идентичности — без вызова моста',
  refreshThrown === null && refreshRes === null && st.calls.length === 1);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
