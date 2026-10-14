// Node-смоук features/group-meta.js — сканирование meta-писем групп.
// Мокаем api/crypto/db/invoke + ctx. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-meta-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

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

let gm = readFileSync(ROOT + '/src/features/group-meta.js', 'utf8');
gm = gm
  .replace("from '@tauri-apps/api/core'", 'from "' + MOCKS + '/core.js"')
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"');
writeFileSync(MOCKS + '/group-meta.mjs', gm);
const { syncGroupAvatarsFromMeta } = await import(MOCKS + '/group-meta.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    isLoggedIn: true,
    groups: [],
    emails: [],
    groupKeys: {},
    groupAvatars: {},
    cryptoReady: true,
    healGroupAvatarFromMessage: async () => {},
    replyGroupAvatarHeal: async () => true,
  }, over);
}

// 1. Не залогинен / нет групп → no-op
apiMock.fetchCalls.length = 0;
_kv.clear(); invokeMock.calls.length = 0;
await syncGroupAvatarsFromMeta(makeCtx({ isLoggedIn: false }));
await syncGroupAvatarsFromMeta(makeCtx({ groups: [] }));
check('не залогинен / нет групп — no-op', apiMock.fetchCalls.length === 0);

// 2. Meta-письмо с аватаром → kv обновлётся
_kv.clear();
apiMock.groupKey = 'GK';
apiMock.emailBody = 'ENC:meta';
cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ meta: 1, avatar: 'AVATAR123', name: 'NewName' });
const ctx = makeCtx({
  groups: [{ id: 'G1', name: 'OldName', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 10, folder: 'INBOX', date: '2026-01-01' }],
});
await syncGroupAvatarsFromMeta(ctx);
check('meta → аватар записан в kv', _kv.get('group-avatar:G1') === 'AVATAR123');
check('meta → имя применено (groups_rename)', invokeMock.calls.length === 1 && invokeMock.calls[0][1].newName === 'NewName');
check('meta → applied-ключ записан', _kv.get('group-meta-applied:G1') === '10@INBOX');

// 3. Уже applied → не обрабатываем повторно
apiMock.fetchCalls.length = 0;
await syncGroupAvatarsFromMeta(makeCtx({
  groups: [{ id: 'G1', name: 'NewName', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 10, folder: 'INBOX', date: '2026-01-01' }],
  groupKeys: { G1: 'GK' },
}));
check('уже applied → fetchEmailBody не звался', apiMock.fetchCalls.length === 0);

// 4. hav-запрос → replyGroupAvatarHeal вызывается
_kv.clear();
apiMock.emailBody = 'ENC:hav';
cryptoMock.decryptWithGroupKey = async () => JSON.stringify({ hav: 1 });
let healCalled = false;
const ctx4 = makeCtx({
  groups: [{ id: 'G1', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 20, folder: 'INBOX' }],
  groupKeys: { G1: 'GK' },
  replyGroupAvatarHeal: async () => { healCalled = true; return true; },
});
await syncGroupAvatarsFromMeta(ctx4);
check('hav → replyGroupAvatarHeal вызван', healCalled === true);

// 5. Нет ключа → группа пропускается
apiMock.groupKey = null;
apiMock.fetchCalls.length = 0;
await syncGroupAvatarsFromMeta(makeCtx({
  groups: [{ id: 'G1', members: [{ email: 'a@x.ru' }] }],
  emails: [{ from: 'a@x.ru', uid: 30, folder: 'INBOX' }],
}));
check('нет ключа → fetchEmailBody не звался', apiMock.fetchCalls.length === 0);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
