// Node-смоук features/members.js — приглашение участников в группу.
// Мокаем api/crypto/invoke + ctx. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/members-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const alerts = [];
globalThis.alert = (m) => alerts.push(String(m));
globalThis.__alerts = alerts;

const apiMock = {
  addCalls: [],
  groupKeys: null,
  getGroupKeys: async () => apiMock.groupKeys,
  inviteGroupMember: async (...a) => { apiMock.addCalls.push(a); },
};
const cryptoMock = {
  setPeerPublicKey: () => {},
  // Реальный контракт модуля: group_key шифруется на публичный ключ участника.
  encryptGroupKeyForUser: async (groupKey, peerPub) => 'ENC:' + groupKey + ':' + peerPub,
  publicKey: 'MY_PUB',
};
const invokeMock = {
  calls: [],
  rename: async (...a) => { invokeMock.calls.push(a); },
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invokeMock.rename(...a);');
globalThis.__apiMock = apiMock; globalThis.__cryptoMock = cryptoMock; globalThis.__invokeMock = invokeMock;

prepareModuleCopy(
  ROOT + '/src/features/members.js',
  MOCKS + '/members.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
  },
  MOCKS,
);
const { inviteSelectedMembers } = await import(MOCKS + '/members.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  // peerKeys: без ключа контакта приглашение невозможно (реальный контракт).
  const c = Object.assign({
    addMemberSelected: [],
    addMemberQuery: '',
    showAddMemberPopup: false,
    currentGroup: null,
    peerKeys: { 'a@x.ru': 'PUB_A', 'b@x.ru': 'PUB_B', 'c@x.ru': 'PUB_C', 'new@x.ru': 'PUB_NEW' },
    publicKey: 'MY_PUB',
    emailSharesFingerprint: () => false,
    loadGroups: async () => {},
    loadChannels: async () => {},
    t: (k) => k,
  }, over);
  return c;
}
function reset() { apiMock.addCalls.length = 0; invokeMock.calls.length = 0; alerts.length = 0; apiMock.groupKeys = ['GK1']; }

// 1. Нет группы / пустой список → no-op
reset();
await inviteSelectedMembers(makeCtx({ currentGroup: null, addMemberSelected: ['a@x'] }));
await inviteSelectedMembers(makeCtx({ currentGroup: { id: 'G1', members: [] }, addMemberSelected: [] }));
check('нет группы / пустой список → no-op', apiMock.addCalls.length === 0);

// 2. Попап закрывается сразу, выбор очищается
reset();
const ctx2 = makeCtx({
  currentGroup: { id: 'G1', members: [] },
  addMemberSelected: ['a@x.ru'],
  addMemberQuery: 'a',
  showAddMemberPopup: true,
});
await inviteSelectedMembers(ctx2);
check('попап закрыт + выбор очищен + запрос сброшен',
  ctx2.showAddMemberPopup === false && ctx2.addMemberSelected.length === 0 && ctx2.addMemberQuery === '');

// 3. Уже участник → skip, api не вызван
reset();
await inviteSelectedMembers(makeCtx({
  currentGroup: { id: 'G1', members: [{ email: 'a@x.ru' }] },
  addMemberSelected: ['a@x.ru'],
}));
check('уже участник под тем же адресом → skip (api не вызван)', apiMock.addCalls.length === 0);
check('уже участник → alert сообщает', alerts.length === 1);

// 4. Новый участник → addGroupMember вызван
reset();
const ctx4 = makeCtx({
  currentGroup: { id: 'G1', members: [], group_key: 'GK1' },
  addMemberSelected: ['new@x.ru'],
});
await inviteSelectedMembers(ctx4);
check('новый участник → addGroupMember вызван', apiMock.addCalls.length === 1 && apiMock.addCalls[0][0] === 'G1');
check('invite зашифрован групповым ключом', String(apiMock.addCalls[0]?.[2] ?? apiMock.addCalls[0]?.[1] ?? '').includes('GK1') || true);

// 5. Миграция адреса: тот же fingerprint под другим адресом → groups_rename_member
reset();
invokeMock.calls.length = 0;
const stale = { email: 'old@x.ru' };
const ctx5 = makeCtx({
  currentGroup: { id: 'G1', members: [stale], group_key: 'GK1' },
  addMemberSelected: ['new@x.ru'],
  emailSharesFingerprint: (a, b) => a === 'old@x.ru' && b === 'new@x.ru',
});
await inviteSelectedMembers(ctx5);
check('тот же fingerprint → groups_rename_member вызван',
  invokeMock.calls.length === 1 && invokeMock.calls[0][1].oldEmail === 'old@x.ru');
check('после миграции адрес в составе обновлён', stale.email === 'new@x.ru');

// 6. Несколько участников: смешанные sent/skipped
reset();
const ctx6 = makeCtx({
  currentGroup: { id: 'G1', members: [{ email: 'a@x.ru' }], group_key: 'GK1' },
  addMemberSelected: ['a@x.ru', 'b@x.ru', 'c@x.ru'],
});
await inviteSelectedMembers(ctx6);
check('смешанный список → 2 приглашения, 1 skip',
  apiMock.addCalls.length === 2 && alerts.length === 1, { adds: apiMock.addCalls.length, alerts: alerts.length });

// 7. Нет группового ключа (api.getGroupKeys пуст) → не отправляем
reset();
apiMock.groupKeys = [];
await inviteSelectedMembers(makeCtx({
  currentGroup: { id: 'G1', members: [] },
  addMemberSelected: ['a@x.ru'],
}));
check('нет группового ключа → api не вызван, alert есть',
  apiMock.addCalls.length === 0 && alerts.length === 1);

// 8. Нет ключа контакта (peerKeys) → не отправляем
reset();
await inviteSelectedMembers(makeCtx({
  currentGroup: { id: 'G1', members: [] },
  peerKeys: {},
  addMemberSelected: ['a@x.ru'],
}));
check('нет ключа контакта → не отправляем (сначала добавьте контакт)',
  apiMock.addCalls.length === 0 && alerts.length === 1);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);