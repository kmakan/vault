// Миграции при смене почты (ADR-003 Этап 3, партия 9).
//
// Здесь правило одно и оно легко ломается молча: перенос не имеет права
// ЗАТИРАТЬ то, что уже есть у нового адреса. Три места, где это проверяется:
//   · профиль — заполняются только ПУСТЫЕ поля цели, непустой avatar нового
//     профиля должен уцелеть;
//   · история чата — если ключ нового адреса уже занят, чужая история не
//     перезаписывается (и старый ключ тоже не удаляется);
//   · группы — переименовываются только те, где мы создатель или участник.
//
// Плюс перечитывание списка: без него на экране остались бы старые адреса.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/migrations-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const st = { kv: {}, groups: [], renamed: [], nsOf: (e) => 'fp:' + e };
globalThis.__st = st;
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'groups_rename_member') { st.renamed.push(args); return null; }
  return null;
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');
writeFileSync(MOCKS + '/identity.js',
  "export const accountNamespace = async (e) => globalThis.__st.nsOf(e);");
writeFileSync(MOCKS + '/api.js', `
export default { getGroups: async () => globalThis.__st.groups };
export const db = {
  kvGet: async (acct, key) => {
    const scope = (globalThis.__st.kv[acct] || {})[key];
    return scope !== undefined ? scope : null;
  },
  kvSet: async (acct, key, val) => {
    (globalThis.__st.kv[acct] = globalThis.__st.kv[acct] || {})[key] = val;
  },
  kvDelete: async (acct, key) => {
    const s = globalThis.__st.kv[acct]; if (s) delete s[key];
  },
};
`);
let s = readFileSync(path.join(ROOT, 'src', 'migrations.js'), 'utf8');
s = s.split("from './api.js'").join(`from "${MOCKS}/api.js"`)
     .split("from './identity.js'").join(`from "${MOCKS}/identity.js"`)
     .split("from '@tauri-apps/api/core'").join(`from "${MOCKS}/core.js"`);
writeFileSync(MOCKS + '/migrations.mjs', s, 'utf8');
const M = await import(MOCKS + '/migrations.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { st.kv = {}; st.groups = []; st.renamed = []; st.nsOf = (e) => 'fp:' + e; };
const prof = () => JSON.parse(st.kv['anon'] ? st.kv['anon']['profiles'] : '{}');

console.log('\nADR-003 Этап 3, партия 9 · миграции при смене почты');

// ── migrateChatHistory ────────────────────────────────────────────────
reset();
st.kv['fp:me@bk.ru'] = { 'chat-cache:old@x': 'CACHE-OLD' };
let r = await M.migrateChatHistory('old@x', 'new@x', 'me@bk.ru');
ok('история перенесена в namespace по резолверу', r === true);
ok('старый ключ удалён, новый лежит с тем же содержимым',
  st.kv['fp:me@bk.ru']['chat-cache:new@x'] === 'CACHE-OLD'
  && st.kv['fp:me@bk.ru']['chat-cache:old@x'] === undefined);

reset();
st.kv['fp:me@bk.ru'] = { 'chat-cache:old@x': 'CACHE-OLD', 'chat-cache:new@x': 'CACHE-NEW' };
r = await M.migrateChatHistory('old@x', 'new@x', 'me@bk.ru');
ok('занятый ключ нового адреса НЕ перезаписывается',
  st.kv['fp:me@bk.ru']['chat-cache:new@x'] === 'CACHE-NEW');
ok('и старый ключ остаётся на месте при отказе', st.kv['fp:me@bk.ru']['chat-cache:old@x'] === 'CACHE-OLD');
ok('функция сообщила, что нечего переносить', r === false);

reset();
r = await M.migrateChatHistory('old@x', 'new@x', null);
ok('без своего email берётся namespace anon', r === false && st.kv['anon'] === undefined);

// ── migrateOwnProfile: не затирать ────────────────────────────────────
reset();
st.kv['anon'] = { profiles: JSON.stringify({ 'old@bk.ru': { nickname: 'Аня', avatar: 'OLD', bio: 'Б' } }) };
r = await M.migrateOwnProfile('old@bk.ru', 'new@bk.ru');
ok('копия профиля целиком, если цели нет',
  r.key === 'new@bk.ru' && r.profile.nickname === 'Аня' && r.profile.avatar === 'OLD');
ok('запись сохранена', prof()['new@bk.ru'].nickname === 'Аня');

reset();
st.kv['anon'] = { profiles: JSON.stringify({
  'old@bk.ru': { nickname: 'Старое', avatar: 'OLD-AVATAR', bio: 'Био' },
  'new@bk.ru': { nickname: 'Новое', avatar: 'NEW-AVATAR' },
}) };
r = await M.migrateOwnProfile('old@bk.ru', 'new@bk.ru');
ok('НЕпустой avatar нового профиля уцелел', r.profile.avatar === 'NEW-AVATAR');
ok('непустой nickname нового профиля уцелел', r.profile.nickname === 'Новое');
ok('пустое bio дополнено из старого', r.profile.bio === 'Био');

reset();
st.kv['anon'] = { profiles: JSON.stringify({ 'old@bk.ru': { nickname: 'Аня' } }) };
r = await M.migrateOwnProfile('old@bk.ru', 'old@bk.ru');
ok('адрес не изменился → null, шапка не трогается', r === null);

reset();
st.kv['anon'] = { profiles: JSON.stringify({ 'other@x': { nickname: 'Чужой' } }) };
r = await M.migrateOwnProfile('old@bk.ru', 'new@bk.ru');
ok('нет профиля старого адреса → null', r === null);

// ── migratePeerGroups ─────────────────────────────────────────────────
reset();
st.groups = [
  { id: 'g1', created_by: 'Old@BK.RU', members: [] },
  { id: 'g2', created_by: 'zzz@x', members: [{ email: 'OLD@bk.ru' }] },
  { id: 'g3', created_by: 'zzz@x', members: [{ email: 'qqq@x' }] },
];
let reloaded = 0;
let n = await M.migratePeerGroups('old@bk.ru', 'new@bk.ru', async () => { reloaded++; });
ok('переименованы группы, где мы создатель или участник', n === 2);
ok('это именно g1 и g2', st.renamed.map(x => x.groupId).sort().join(',') === 'g1,g2');
ok('список перечитан один раз', reloaded === 1);

reset();
st.groups = [{ id: 'g4', created_by: 'zzz@x', members: [] }];
reloaded = 0;
n = await M.migratePeerGroups('old@bk.ru', 'new@bk.ru', async () => { reloaded++; });
ok('если ничего не поменялось — список не перечитывается', n === 0 && reloaded === 0);
ok('пустые адреса отсекаются', (await M.migratePeerGroups('', 'new@bk.ru', null)) === 0);
ok('упавший onRenamed не ломает перенос', await (async () => {
  st.groups = [{ id: 'g5', created_by: 'old@bk.ru', members: [] }];
  return await M.migratePeerGroups('old@bk.ru', 'new@bk.ru', async () => { throw new Error('список не прочитался'); }) === 1;
})());

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);