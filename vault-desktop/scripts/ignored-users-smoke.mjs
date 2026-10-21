// Node-смоук features/ignored-users.js — ignore-лист (E2E-блокировка).
//
// Что здесь ловится: ignore-лист — это ЕДИНСТВЕННОЕ место, где «скрытое
// сообщение» становится скрытым. Ошибка в нём тиха: письма просто перестают
// приходить, и пользователь думает, что у собеседника сломался почтовый
// клиент. Проверяем: чтение из kv, запись в kv (в пространстве аккаунта!),
// запрет блокировать самого себя, отсутствие дублей при повторной блокировке
// и снятие блокировки (вместе с алиасами того же peer-ключа).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/ignored-users-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const _kv = new Map();
globalThis.__dbMock = {
  kvGet: async (ns, k) => (_kv.has(ns + '|' + k) ? _kv.get(ns + '|' + k) : null),
  kvSet: async (ns, k, v) => { _kv.set(ns + '|' + k, v); },
  kvCalls: [],
};
globalThis.__dbMock.kvGet = async (ns, k) => { globalThis.__dbMock.kvCalls.push(['get', ns, k]); return _kv.has(ns + '|' + k) ? _kv.get(ns + '|' + k) : null; };
globalThis.__dbMock.kvSet = async (ns, k, v) => { globalThis.__dbMock.kvCalls.push(['set', ns, k]); _kv.set(ns + '|' + k, v); };

writeFileSync(MOCKS + '/api-mock.mjs', 'export const db = globalThis.__dbMock;\nexport default { db };\n');

prepareModuleCopy(
  ROOT + '/src/features/ignored-users.js',
  MOCKS + '/ignored-users.mjs',
  { './contacts.js': path.join(ROOT, 'src/features/contacts.js') },
  MOCKS,
);
const I = await import(MOCKS + '/ignored-users.mjs');
// Чистые правила карты — как в приложении: из features/contacts.js через
// контракт (фича не импортирует фичу).
const Contacts = await import(ROOT + '/src/features/contacts.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Владелец ignore-листа (contactsStore) — подделка с тем же контрактом.
function makeStore() {
  return {
    state: { ignoredUsers: {} },
    setIgnored(v) { this.state.ignoredUsers = v || {}; },
    clearIgnored() { this.state.ignoredUsers = {}; },
  };
}

function makeDeps(over = {}) {
  return {
    email: 'me@x.ru',
    peerKeys: { 'PEERK1': 'peer1@x.ru' },
    contactsStore: makeStore(),
    db: globalThis.__dbMock,
    accountNamespace: async (e) => 'ns:' + String(e || '').toLowerCase(),
    isIgnored: Contacts.isIgnored,
    addIgnored: Contacts.addIgnored,
    removeIgnored: Contacts.removeIgnored,
    ...over,
  };
}

function reset() {
  _kv.clear();
  globalThis.__dbMock.kvCalls = [];
}

// ── Чтение из kv ────────────────────────────────────────────────────────
{
  reset();
  const deps = makeDeps();
  await I.loadIgnoredUsers(deps);
  check('пустой kv → пустой ignore-лист', Object.keys(deps.contactsStore.state.ignoredUsers).length === 0);
  check('чтение идёт в пространстве аккаунта',
    globalThis.__dbMock.kvCalls.some((c) => c[0] === 'get' && c[1] === 'ns:me@x.ru' && c[2] === 'ignored-users'),
    globalThis.__dbMock.kvCalls);
}
{
  reset();
  const deps = makeDeps();
  await globalThis.__dbMock.kvSet('ns:me@x.ru', 'ignored-users', JSON.stringify({ 'a@x.ru': 123 }));
  await I.loadIgnoredUsers(deps);
  check('ignore-лист прочитан из kv', deps.contactsStore.state.ignoredUsers['a@x.ru'] === 123,
    deps.contactsStore.state.ignoredUsers);
}
{
  reset();
  const deps = makeDeps();
  await globalThis.__dbMock.kvSet('ns:me@x.ru', 'ignored-users', '{битый json');
  await I.loadIgnoredUsers(deps);
  check('битый json → пустой список, без исключения',
    Object.keys(deps.contactsStore.state.ignoredUsers).length === 0, deps.contactsStore.state.ignoredUsers);
}

// ── Блокировка ─────────────────────────────────────────────────────────
{
  reset();
  const deps = makeDeps();
  check('пустой адрес → false (нечего блокировать)', (await I.ignoreUser(deps, '')) === false);
  check('свой адрес → false (себя не блокируем)',
    (await I.ignoreUser(deps, 'me@x.ru')) === false);
  check('свой адрес в другом регистре → false',
    (await I.ignoreUser(deps, 'ME@X.RU')) === false);
  check('пустой адрес не попал в список',
    Object.keys(deps.contactsStore.state.ignoredUsers).length === 0, deps.contactsStore.state.ignoredUsers);
}
{
  reset();
  const deps = makeDeps();
  const r = await I.ignoreUser(deps, 'Peer@X.RU');
  check('обычный адрес → true', r === true);
  check('адрес нормализован (в нижний регистр, без пробелов)',
    deps.contactsStore.state.ignoredUsers['peer@x.ru'] !== undefined,
    deps.contactsStore.state.ignoredUsers);
  check('блокировка записана в kv',
    globalThis.__dbMock.kvCalls.some((c) => c[0] === 'set' && c[2] === 'ignored-users'),
    globalThis.__dbMock.kvCalls);
  check('запись идёт В ПРОСТРАНСТВО АККАУНТА (иначе список уезжает другому адресу)',
    globalThis.__dbMock.kvCalls.some((c) => c[0] === 'set' && c[1] === 'ns:me@x.ru'),
    globalThis.__dbMock.kvCalls);
}
{
  reset();
  const deps = makeDeps();
  await I.ignoreUser(deps, 'peer@x.ru');
  const first = { ...deps.contactsStore.state.ignoredUsers };
  await I.ignoreUser(deps, 'peer@x.ru');
  check('повторная блокировка не дублирует запись',
    Object.keys(deps.contactsStore.state.ignoredUsers).length === Object.keys(first).length,
    deps.contactsStore.state.ignoredUsers);
}

// ── Снятие блокировки ──────────────────────────────────────────────────
{
  reset();
  const deps = makeDeps();
  await I.ignoreUser(deps, 'peer@x.ru');
  await I.unignoreUser(deps, 'peer@x.ru');
  check('снятие блокировки убирает адрес из списка',
    deps.contactsStore.state.ignoredUsers['peer@x.ru'] === undefined,
    deps.contactsStore.state.ignoredUsers);
  check('снятие блокировки записано в kv',
    globalThis.__dbMock.kvCalls.filter((c) => c[0] === 'set' && c[2] === 'ignored-users').length === 2,
    globalThis.__dbMock.kvCalls);
}
{
  reset();
  const deps = makeDeps();
  await I.unignoreUser(deps, '');
  check('снятие пустого адреса — ничего не делает',
    globalThis.__dbMock.kvCalls.filter((c) => c[0] === 'set').length === 0,
    globalThis.__dbMock.kvCalls);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
