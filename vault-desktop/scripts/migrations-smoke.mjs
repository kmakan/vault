// Миграции при смене почты (ADR-003 Этап 3, партия 9).
//
// Здесь правило одно и оно легко ломается молча: перенос не имеет права
// ЗАТИРАТЬ то, что уже есть у нового адреса. Три места, где это проверяется:
//   · профиль — заполняются только ПУСТЫЕ поля цели, непустой avatar нового
//     профиля должен уцелеть;
//   · история чата — если ключ нового адреса уже занят, чужая история не
//     перезаписывается (и старый ключ тоже не удаляется);
//   · группы — переименовываются только те, где мы создатель или участник;
//     сам перебор и «мой ли этот адрес» — в мосте (`groups_rename_address`),
//     его поведение измеряет набор моста. Здесь проверяется то, что осталось
//     фронту: передать пару адресов, вернуть число и перечитать список,
//     только когда число больше нуля.
//
// Плюс перечитывание списка: без него на экране остались бы старые адреса.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/migrations-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const st = { kv: {}, renameArgs: [], renameCount: 2, nsOf: (e) => 'fp:' + e };
globalThis.__st = st;
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'groups_rename_address') { st.renameArgs.push(args); return st.renameCount; }
  return null;
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');
writeFileSync(MOCKS + '/identity.js',
  "export const accountNamespace = async (e) => globalThis.__st.nsOf(e);");
writeFileSync(MOCKS + '/api.js', `
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
const reset = () => {
  st.kv = {}; st.renameArgs = []; st.renameCount = 2;
  st.nsOf = (e) => 'fp:' + e;
};
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
// Сам перебор и «мой ли этот адрес» — в мосте; здесь только контракт фронта:
// одна пара адресов, число из ответа и перечитывание списка ровно тогда, когда
// число больше нуля.
reset();
let reloaded = 0;
let n = await M.migratePeerGroups('old@bk.ru', 'new@bk.ru', async () => { reloaded++; });
ok('число переименованных — из ответа моста', n === 2);
ok('в мост ушла ОДНА пара адресов, без перебора групп на фронте',
  st.renameArgs.length === 1
  && st.renameArgs[0].oldEmail === 'old@bk.ru' && st.renameArgs[0].newEmail === 'new@bk.ru');
ok('список перечитан один раз', reloaded === 1);

reset();
st.renameCount = 0;
reloaded = 0;
n = await M.migratePeerGroups('old@bk.ru', 'new@bk.ru', async () => { reloaded++; });
ok('если ничего не поменялось — список не перечитывается', n === 0 && reloaded === 0);

reset();
let calls = st.renameArgs.length;
ok('пустые адреса отсекаются', (await M.migratePeerGroups('', 'new@bk.ru', null)) === 0);
ok('и в мост при этом не ходим', st.renameArgs.length === calls);

reset();
st.renameCount = 1;
ok('упавший onRenamed не ломает перенос', await (async () => {
  return await M.migratePeerGroups('old@bk.ru', 'new@bk.ru', async () => { throw new Error('список не прочитался'); }) === 1;
})());

// ── migrateChatHistoryChain: потребитель contactAliases ───────────────
// Сценарий, ради которого всё затевалось: пир менял почту ДВАЖДЫ (a → b → c),
// приложение не работало в первый раз. Одиночный перенос взял бы
// chat-cache:c (пусто) и вернул false, а chat-cache:a осиротел бы — и вся
// переписка исчезла бы молча.
reset();
st.kv['fp:me@bk.ru'] = { 'chat-cache:a@x': 'CACHE-A' };
let ch = await M.migrateChatHistoryChain('c@x', 'me@bk.ru', { 'c@x': ['b@x'], 'b@x': ['a@x'] });
ok('цепочка a → b → c развёрнута обходом в ширину', ch.order.join(',') === 'b@x,a@x');
ok('история ПЕРВОГО адреса перенесена в текущий', st.kv['fp:me@bk.ru']['chat-cache:c@x'] === 'CACHE-A');
ok('осиротевший ключ удалён', st.kv['fp:me@bk.ru']['chat-cache:a@x'] === undefined);
ok('в отчёте — что перенесено', ch.moved.join(',') === 'a@x');

// Ближайший адрес приоритетнее: если переписка есть и под b, и под a, побеждает
// более свежая, а старая НЕ удаляется — данные не уничтожаются молча.
reset();
st.kv['fp:me@bk.ru'] = { 'chat-cache:b@x': 'CACHE-B', 'chat-cache:a@x': 'CACHE-A' };
ch = await M.migrateChatHistoryChain('c@x', 'me@bk.ru', { 'c@x': ['b@x'], 'b@x': ['a@x'] });
ok('приоритет у ближайшего адреса', st.kv['fp:me@bk.ru']['chat-cache:c@x'] === 'CACHE-B');
ok('старый ключ сохранён, а не затёрт и не удалён',
  st.kv['fp:me@bk.ru']['chat-cache:a@x'] === 'CACHE-A' && ch.orphans.join(',') === 'a@x');

// Цикл в алиасах не должен вешать обход.
reset();
ch = await M.migrateChatHistoryChain('c@x', 'me@bk.ru', { 'c@x': ['b@x'], 'b@x': ['c@x'] });
ok('цикл в алиасах не вешает обход', ch.order.join(',') === 'b@x');

// КЛЮЧИ НЕ НОРМАЛИЗОВАНЫ: contacts-load пишет c.email как есть. Без
// приведения к нижнему регистру перенос молча не нашёл бы алиас.
reset();
st.kv['fp:me@bk.ru'] = { 'chat-cache:OLD@x': 'CACHE-OLD' };
ch = await M.migrateChatHistoryChain('New@x', 'me@bk.ru', { 'New@x': ['OLD@x'] });
ok('алиасы находятся при разном регистре', st.kv['fp:me@bk.ru']['chat-cache:New@x'] === 'CACHE-OLD');

// Без алиасов поведение прежнее: молча ничего, без исключения.
reset();
st.kv['fp:me@bk.ru'] = { 'chat-cache:a@x': 'CACHE-A' };
ch = await M.migrateChatHistoryChain('c@x', 'me@bk.ru', null);
ok('без карты алиасов — пустой обход, не исключение', ch.order.length === 0 && ch.moved.length === 0);
ok('и ничего не перенесено', st.kv['fp:me@bk.ru']['chat-cache:a@x'] === 'CACHE-A');

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);