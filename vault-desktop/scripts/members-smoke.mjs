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
  // Запоминаем, чем шифровали: иначе проверка «зашифрован ключом группы»
  // остаётся декоративной (`|| true` проходил всегда).
  encryptCalls: [],
  encryptGroupKeyForUser: async (groupKey, peerPub) => {
    cryptoMock.encryptCalls.push([groupKey, peerPub]);
    return 'ENC:' + groupKey + ':' + peerPub;
  },
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

// ADR-005 W2 (партия 12): состояние — у владельцев (chatStore — группа,
// uiStore — форма «добавить участника», identity-store — ключи пиров). Смоук
// берёт ТЕ ЖЕ синглтоны, что импортирует копия модуля.
const { uiStore, chatStore } = await import(ROOT + '/src/features/session-store.js');
const { identityStore } = await import(ROOT + '/src/features/identity-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeWorld(over = {}) {
  // peerKeys: без ключа контакта приглашение невозможно (реальный контракт).
  const w = Object.assign({
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
  uiStore.setFormField('addMemberSelected', w.addMemberSelected);
  uiStore.setFormField('addMemberQuery', w.addMemberQuery);
  uiStore.setModal('showAddMemberPopup', w.showAddMemberPopup);
  chatStore.state.currentGroup = w.currentGroup;
  identityStore.state.peerKeys = w.peerKeys;
  const deps = {
    publicKey: () => w.publicKey,
    emailSharesFingerprint: (a, b) => w.emailSharesFingerprint(a, b),
    loadGroups: () => w.loadGroups(),
    loadChannels: () => w.loadChannels(),
  };
  return { w, deps };
}
function reset() { apiMock.addCalls.length = 0; invokeMock.calls.length = 0; alerts.length = 0; apiMock.groupKeys = ['GK1']; cryptoMock.encryptCalls.length = 0; }

// 1. Нет группы / пустой список → no-op
reset();
await inviteSelectedMembers(makeWorld({ currentGroup: null, addMemberSelected: ['a@x'] }).deps);
await inviteSelectedMembers(makeWorld({ currentGroup: { id: 'G1', members: [] }, addMemberSelected: [] }).deps);
check('нет группы / пустой список → no-op', apiMock.addCalls.length === 0);

// 2. Попап закрывается сразу, выбор очищается
reset();
const { w: ctx2, deps: deps2 } = makeWorld({
  currentGroup: { id: 'G1', members: [] },
  addMemberSelected: ['a@x.ru'],
  addMemberQuery: 'a',
  showAddMemberPopup: true,
});
await inviteSelectedMembers(deps2);
check('попап закрыт + выбор очищен + запрос сброшен',
  uiStore.getModal('showAddMemberPopup') === false
  && (uiStore.getFormField('addMemberSelected') || []).length === 0 && uiStore.getFormField('addMemberQuery') === '');

// 3. Уже участник → skip, api не вызван
reset();
await inviteSelectedMembers(makeWorld({
  currentGroup: { id: 'G1', members: [{ email: 'a@x.ru' }] },
  addMemberSelected: ['a@x.ru'],
}).deps);
check('уже участник под тем же адресом → skip (api не вызван)', apiMock.addCalls.length === 0);
check('уже участник → alert сообщает', alerts.length === 1);

// 4. Новый участник → addGroupMember вызван
reset();
const { w: ctx4, deps: deps4 } = makeWorld({
  currentGroup: { id: 'G1', members: [], group_key: 'GK1' },
  addMemberSelected: ['new@x.ru'],
});
await inviteSelectedMembers(deps4);
check('новый участник → addGroupMember вызван', apiMock.addCalls.length === 1 && apiMock.addCalls[0][0] === 'G1');
check('invite зашифрован ключом ГРУППЫ на публичном ключе участника',
  cryptoMock.encryptCalls.length === 1 && cryptoMock.encryptCalls[0][0] === 'GK1'
  && cryptoMock.encryptCalls[0][1] === 'PUB_NEW', cryptoMock.encryptCalls);

// 5. Миграция адреса: тот же fingerprint под другим адресом → groups_rename_member
reset();
invokeMock.calls.length = 0;
const stale = { email: 'old@x.ru' };
const { w: ctx5, deps: deps5 } = makeWorld({
  currentGroup: { id: 'G1', members: [stale], group_key: 'GK1' },
  addMemberSelected: ['new@x.ru'],
  emailSharesFingerprint: (a, b) => a === 'old@x.ru' && b === 'new@x.ru',
});
await inviteSelectedMembers(deps5);
check('тот же fingerprint → groups_rename_member вызван',
  invokeMock.calls.length === 1 && invokeMock.calls[0][1].oldEmail === 'old@x.ru');
check('после миграции адрес в составе обновлён', stale.email === 'new@x.ru');

// 6. Несколько участников: смешанные sent/skipped
reset();
const { w: ctx6, deps: deps6 } = makeWorld({
  currentGroup: { id: 'G1', members: [{ email: 'a@x.ru' }], group_key: 'GK1' },
  addMemberSelected: ['a@x.ru', 'b@x.ru', 'c@x.ru'],
});
await inviteSelectedMembers(deps6);
check('смешанный список → 2 приглашения, 1 skip',
  apiMock.addCalls.length === 2 && alerts.length === 1, { adds: apiMock.addCalls.length, alerts: alerts.length });

// 7. Нет группового ключа (api.getGroupKeys пуст) → не отправляем
reset();
apiMock.groupKeys = [];
await inviteSelectedMembers(makeWorld({
  currentGroup: { id: 'G1', members: [] },
  addMemberSelected: ['a@x.ru'],
}).deps);
check('нет группового ключа → api не вызван, alert есть',
  apiMock.addCalls.length === 0 && alerts.length === 1);

// 8. Нет ключа контакта (peerKeys) → не отправляем
reset();
await inviteSelectedMembers(makeWorld({
  currentGroup: { id: 'G1', members: [] },
  peerKeys: {},
  addMemberSelected: ['a@x.ru'],
}).deps);
check('нет ключа контакта → не отправляем (сначала добавьте контакт)',
  apiMock.addCalls.length === 0 && alerts.length === 1);

// 9. Состав группы перечитывается с диска (Rust правил groups.json)
{
  reset();
  let groups = 0, channels = 0;
  const { deps } = makeWorld({
    currentGroup: { id: 'G1', members: [] },
    addMemberSelected: ['new@x.ru'],
    loadGroups: async () => { groups++; },
    loadChannels: async () => { channels++; },
  });
  await inviteSelectedMembers(deps);
  check('состав перечитывается с диска (loadGroups + loadChannels)', groups === 1 && channels === 1, { groups, channels });
}

// 10. Приглашённый помечается в составе участников (появится после accept)
{
  reset();
  const group = { id: 'G1', members: [] };
  const { deps } = makeWorld({ currentGroup: group, addMemberSelected: ['new@x.ru'] });
  await inviteSelectedMembers(deps);
  check('участник помечен «invited» в составе группы',
    group.members.length === 1 && group.members[0].invited === true, group.members);
}

// 11. Ошибка отправки попадает в отчёт
{
  reset();
  const orig = apiMock.inviteGroupMember;
  apiMock.inviteGroupMember = async () => { throw new Error('SMTP down'); };
  const { deps } = makeWorld({ currentGroup: { id: 'G1', members: [] }, addMemberSelected: ['new@x.ru'] });
  await inviteSelectedMembers(deps);
  apiMock.inviteGroupMember = orig;
  check('ошибка отправки видна в отчёте (alert)', alerts.length === 1 && /SMTP down/.test(alerts[0] || ''), alerts);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);