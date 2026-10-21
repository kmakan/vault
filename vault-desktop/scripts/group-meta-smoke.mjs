// Node-смоук features/group-meta.js — сканирование meta-писем групп.
// Мокаем api/crypto/db/invoke + ctx. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-meta-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
// Мок форматов wire-конверта и сервисных сигналов (ADR-005 W4): правила —
// в Rust, здесь их тестовый двойник.
const { installEnvelopeMock } = await import('./lib/wire-envelope-mock.mjs');
await installEnvelopeMock(MOCKS);

const apiMock = {
  groupKey: null,
  emailBody: null,
  getMyGroupKey: async () => apiMock.groupKey ? { group_key: apiMock.groupKey } : null,
  fetchEmailBody: async (...a) => { apiMock.fetchCalls.push(a); return apiMock.emailBody; },
  fetchCalls: [],
};
const cryptoMock = {
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  decryptWithGroupKey: null,
};
const _kv = new Map();
const dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};
const invokeMock = { calls: [], rename: async (...a) => { invokeMock.calls.push(a); } };

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invokeMock.rename(...a);');
globalThis.__apiMock = apiMock; globalThis.__cryptoMock = cryptoMock;
globalThis.__dbMock = dbMock; globalThis.__invokeMock = invokeMock;

prepareModuleCopy(
  ROOT + '/src/features/group-meta.js',
  MOCKS + '/group-meta.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    '../wire-signal-rule.js': 'wire-signal-rule.js',
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
  },
  MOCKS,
);
const { syncGroupAvatarsFromMeta } = await import(MOCKS + '/group-meta.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
// ADR-005 W2 (партия 14): состояние — у владельцев. Смоук берёт ТЕ ЖЕ
// синглтоны, что импортирует копия модуля: «залогинен» — session-store,
// письма — mailbox-store, ключи/аватары групп — владелец groups-store.
const { sessionStore } = await import(ROOT + '/src/features/session-store.js');
const { mailboxState } = await import(ROOT + '/src/features/mailbox-store.js');

function makeDeps(over = {}) {
  const w = Object.assign({
    isLoggedIn: true,
    groups: [],
    emails: [],
    groupKeys: {},
    groupAvatars: {},
    cryptoReady: true,
    replyGroupAvatarHeal: async () => true,
    healGroupAvatarFromMessage: async () => {},
  }, over);
  sessionStore.state.isLoggedIn = w.isLoggedIn;
  mailboxState.state.emails = w.emails;
  // Владелец групп: state + методы (ADR-004 Этап A9).
  const groupStore = {
    state: { groupKeys: w.groupKeys, groupAvatars: w.groupAvatars },
    setGroupKey(id, key) { this.state.groupKeys[id] = key; return key; },
    setGroupAvatar(id, avatar) { this.state.groupAvatars[id] = avatar; return avatar; },
  };
  const deps = {
    groups: w.groups,
    groupStore,
    cryptoReady: () => w.cryptoReady,
    replyGroupAvatarHeal: (id) => w.replyGroupAvatarHeal(id),
    healGroupAvatarFromMessage: (id, av) => w.healGroupAvatarFromMessage(id, av),
  };
  return { w, deps };
}

// 1. Не залогинен / нет групп → no-op
apiMock.fetchCalls.length = 0;
_kv.clear(); invokeMock.calls.length = 0;
await syncGroupAvatarsFromMeta(makeDeps({ isLoggedIn: false }).deps);
await syncGroupAvatarsFromMeta(makeDeps({ groups: [] }).deps);
check('не залогинен / нет групп — no-op', apiMock.fetchCalls.length === 0);

// 2. Meta-письмо с аватаром → kv обновлётся
_kv.clear();
apiMock.groupKey = 'GK';
apiMock.emailBody = 'ENC:meta';
cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ meta: 1, avatar: 'AVATAR123', name: 'NewName' });
const { deps } = makeDeps({
  groups: [{ id: 'G1', name: 'OldName', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 10, folder: 'INBOX', date: '2026-01-01' }],
});
await syncGroupAvatarsFromMeta(deps);
check('meta → аватар записан в kv', _kv.get('group-avatar:G1') === 'AVATAR123');
check('meta → аватар в owner (groups-store)', deps.groupStore.state.groupAvatars.G1 === 'AVATAR123', deps.groupStore.state.groupAvatars);
check('meta → имя применено (groups_rename)', invokeMock.calls.length === 1 && invokeMock.calls[0][1].newName === 'NewName');
check('meta → applied-ключ записан', _kv.get('group-meta-applied:G1') === '10@INBOX');

// 3. Уже applied → не обрабатываем повторно
apiMock.fetchCalls.length = 0;
await syncGroupAvatarsFromMeta(makeDeps({
  groups: [{ id: 'G1', name: 'NewName', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 10, folder: 'INBOX', date: '2026-01-01' }],
  groupKeys: { G1: 'GK' },
}).deps);
check('уже applied → fetchEmailBody не звался', apiMock.fetchCalls.length === 0);

// 4. hav-запрос → replyGroupAvatarHeal вызывается
_kv.clear();
apiMock.emailBody = 'ENC:hav';
cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ hav: 1 });
let healCalled = false;
const { deps: deps4 } = makeDeps({
  groups: [{ id: 'G1', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 20, folder: 'INBOX' }],
  groupKeys: { G1: 'GK' },
  replyGroupAvatarHeal: async () => { healCalled = true; return true; },
});
await syncGroupAvatarsFromMeta(deps4);
check('hav → replyGroupAvatarHeal вызван', healCalled === true);

// 5. Нет ключа → группа пропускается
apiMock.groupKey = null;
apiMock.fetchCalls.length = 0;
await syncGroupAvatarsFromMeta(makeDeps({
  groups: [{ id: 'G1', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 30, folder: 'INBOX' }],
}).deps);
check('нет ключа → fetchEmailBody не звался', apiMock.fetchCalls.length === 0);

// 6. Не залогинен, но группы ЕСТЬ → всё равно no-op
{
  _kv.clear(); apiMock.fetchCalls.length = 0; invokeMock.calls.length = 0;
  await syncGroupAvatarsFromMeta(makeDeps({
    isLoggedIn: false,
    groups: [{ id: 'G1', members: [{ email: 'a@x.ru' }] }],
    emails: [{ from: 'a@x.ru', uid: 40, folder: 'INBOX' }],
    groupKeys: { G1: 'GK' },   // ключ есть — иначе скан не дойдёт до тела и ничего не проверит
  }).deps);
  check('не залогинен (группы есть) → no-op', apiMock.fetchCalls.length === 0, apiMock.fetchCalls);
}

// 7. Ключ группы отсутствует в сторе, но есть в api → догружается и применяется
{
  _kv.clear(); apiMock.fetchCalls.length = 0; invokeMock.calls.length = 0;
  apiMock.groupKey = 'GK_FROM_API';
  cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ meta: 1, avatar: 'AVA', name: 'N' });
  const { deps: deps7 } = makeDeps({
    groups: [{ id: 'G1', name: 'Old', members: [{ email: 'a@x.ru' }] }],
    emails: [{ from: 'a@x.ru', uid: 50, folder: 'INBOX', date: '2026-01-01' }],
    groupKeys: {},   // в сторе ключа нет
  });
  await syncGroupAvatarsFromMeta(deps7);
  check('ключ догружен из api и применён (meta обработана)',
    deps7.groupStore.state.groupKeys.G1 === 'GK_FROM_API'
    && _kv.get('group-avatar:G1') === 'AVA', { keys: deps7.groupStore.state.groupKeys, avatar: _kv.get('group-avatar:G1') });
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
