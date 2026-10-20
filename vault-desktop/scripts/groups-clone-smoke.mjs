// Клонирование группы (ADR-003 Этап 3, партия 6).
//
// Три вещи, которые здесь ломаются тихо:
//   1. ПОРЯДОК. В оригинале клон появлялся в groups/currentGroup ДО рассылки
//      приглашений. Перенос не должен менять момент появления — поэтому
//      onCreated вызывается до цикла, и тест это проверяет порядком событий.
//   2. ЧАСТИЧНЫЙ КЛОН. Участник без peerKey не получает инвайт, но клон
//      создаётся целиком. Если сделать наоборот (упасть), пользователь потеряет
//      группу из-за одного участника без ключа.
//   3. САМОГО СЕБЯ не зовём в инвайты, и уже приглашённых не дублируем.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/groups-clone-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { order: [], kv: {}, failInviteFor: null, failCreate: false };
globalThis.__state = state;

const api = {
  createGroup: async (name, about) => {
    if (state.failCreate) throw new Error('groups_create недоступна');
    state.order.push('createGroup');
    return { id: 'clone1', name, group_key: 'GK1' };
  },
  inviteGroupMember: async (groupId, email, enc, publicKey) => {
    if (state.failInviteFor === email) throw new Error('инвайт не отправлен');
    state.order.push('invite:' + email);
    state.lastEnc = enc;
  },
};
writeFileSync(MOCKS + '/api.js', `
export default globalThis.__api;
export const db = {
  kvGet: async (a, k) => (globalThis.__state.kv[k] !== undefined ? globalThis.__state.kv[k] : null),
  kvSet: async (a, k, v) => { globalThis.__state.kv[k] = v; globalThis.__state.order.push('kvSet:' + k); },
};
`);
globalThis.__api = api;
writeFileSync(MOCKS + '/crypto.js', `
export default {
  encryptGroupKeyForUser: async (gk, peerPub) => 'ENC(' + gk + '|' + peerPub + ')',
};
`);

let s = readFileSync(path.join(ROOT, 'src', 'features', 'groups-clone.js'), 'utf8');
// split/join, а не replace: replace меняет ПЕРВОЕ вхождение, а импорт из
// api.js в модуле встречается дважды (default и именованный) — второй уезжал
// неподменённым и резолвился в /tmp/api.js.
s = s.split("from '../api.js'").join(`from "${MOCKS}/api.js"`)
     .split("from '../crypto.js'").join(`from "${MOCKS}/crypto.js"`);
writeFileSync(MOCKS + '/groups-clone.mjs', s, 'utf8');
const GC = await import(MOCKS + '/groups-clone.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { state.order = []; state.kv = {}; state.failInviteFor = null; state.failCreate = false; state.lastEnc = null; };

const SRC = { id: 'g1', name: 'Оригинал', created_by: 'me@bk.ru', members: [
  { email: 'me@bk.ru', role: 'Admin' },
  { email: 'a@x', role: 'Member' },
  { email: 'b@x', role: 'Moderator' },
] };
const base = (o = {}) => Object.assign({
  src: SRC, name: 'Оригинал 2', email: 'me@bk.ru',
  peerKeys: { 'a@x': 'PA', 'b@x': 'PB' }, publicKey: 'MYPUB',
}, o);

console.log('\nADR-003 Этап 3, партия 6 · клонирование группы');

// 1. Порядок: onCreated ДО инвайтов.
reset();
let r = await GC.cloneGroup(base({ onCreated: () => state.order.push('onCreated') }));
ok('onCreated вызван до первого инвайта',
  state.order.indexOf('onCreated') < state.order.indexOf('invite:a@x'));
ok('сначала создание, потом применение, потом инвайты',
  state.order[0] === 'createGroup' && state.order[1] === 'onCreated');

// 2. Состав клона: мы Admin, участники с invited, роли перенесены.
r = await GC.cloneGroup(base());
ok('клонирующий стал Admin', r.group.members[0].email === 'me@bk.ru' && r.group.members[0].role === 'Admin');
ok('blocked инициализирован', Array.isArray(r.group.blocked) && r.group.blocked.length === 0);
ok('себя не зовём в инвайты', !state.order.some(x => x === 'invite:me@bk.ru'));
ok('обоих участников пригласили', r.invited.sort().join(',') === 'a@x,b@x');
ok('роль участника перенесена', r.group.members.find(m => m.email === 'b@x').role === 'Moderator');
ok('у приглашённых стоит invited', r.group.members.find(m => m.email === 'a@x').invited === true);

// 3. Ключ группы шифруется индивидуально под ключ каждого.
ok('инвайт зашифрован под ключ адресата', state.lastEnc === 'ENC(GK1|PB)');

// 4. Участник без ключа — пропущен, клон создан.
reset();
r = await GC.cloneGroup(base({ peerKeys: { 'a@x': 'PA' } }));
ok('участник без ключа пропущен, а не уронил клон', r.skipped.join(',') === 'b@x');
ok('остальные приглашены', r.invited.join(',') === 'a@x');
ok('в группе только мы и приглашённый', r.group.members.length === 2);

// 5. Сбой инвайта одному не мешает остальным.
reset();
state.failInviteFor = 'a@x';
r = await GC.cloneGroup(base());
ok('упавший инвайт ушёл в skipped', r.skipped.join(',') === 'a@x');
ok('второй участник всё равно приглашён', r.invited.join(',') === 'b@x');

// 6. Аватар копируется из оригинала.
reset();
state.kv = { 'group-avatar:g1': 'AV1' };
r = await GC.cloneGroup(base({ onCreated: ({ avatar }) => { state.appliedAvatar = avatar; } }));
ok('аватар прочитан и записан в клон', state.kv['group-avatar:clone1'] === 'AV1');
ok('аватар передан в onCreated', state.appliedAvatar === 'AV1');

// 7. Без аватара оригинала onCreated всё равно вызывается (с пустым).
reset();
let called = false;
await GC.cloneGroup(base({ onCreated: () => { called = true; } }));
ok('без аватара клон всё равно создан и применён', called === true && state.kv['group-avatar:clone1'] === undefined);

// 8. Сбой создания — наружу, чтобы App.vue показал сообщение.
reset();
state.failCreate = true;
let threw = false;
try { await GC.cloneGroup(base()); } catch (e) { threw = true; }
ok('сбой groups_create пробрасывается (его ловит UI, не модуль)', threw === true);

// 9. РЕГИСТР адреса: участник написан заглавными, ключ в карте — в нижнем
// регистре. Поиск обязан идти по нормализованному адресу, иначе участник
// молча выпадает из клона (и остаётся в старой группе без приглашения).
reset();
r = await GC.cloneGroup(base({
  src: { id: 'g1', name: 'Оригинал', members: [
    { email: 'me@bk.ru', role: 'Admin' },
    { email: 'A@X', role: 'Member' },
  ] },
  peerKeys: { 'a@x': 'PA' },
}));
ok('ключ найден по адресу в нижнем регистре (A@X → a@x)', r.invited.join(',') === 'A@X', r.invited);
ok('участник с другим регистром реально приглашён', state.order.includes('invite:A@X'), state.order);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);