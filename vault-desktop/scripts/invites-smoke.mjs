// Node-смоук features/invites.js — обработка входящих приглашений в группы.
// Мокаем api + ctx-методы. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/invites-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  _handshakeCache: {},
  pendingAccepts: [],
  pendingContactAccepts: [],
  pendingInvites: [],
  pendingContactInvites: [],
  sweepStaleHandshake: async () => {},
  fetchPendingAccepts: async () => apiMock.pendingAccepts,
  fetchPendingContactAccepts: async () => apiMock.pendingContactAccepts,
  fetchPendingInvites: async () => apiMock.pendingInvites,
  fetchPendingContactInvites: async () => apiMock.pendingContactInvites,
  acceptGroupInvite: async () => {},
  declineGroupInvite: async () => {},
};
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
globalThis.__apiMock = apiMock;

prepareModuleCopy(
  ROOT + '/src/features/invites.js',
  MOCKS + '/invites.mjs',
  {
    '../api.js': 'api.js',
  },
  MOCKS,
);
const { processInvites } = await import(MOCKS + '/invites.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    handledInviteKeys: [],
    handledContactKeys: [],
    pendingInvites: [],
    pendingContacts: [],
    invitePopupIndex: 0,
    contactPopupIndex: 0,
    showInvitePopup: false,
    showContactPopup: false,
    currentGroup: null,
    groups: [],
    cryptoReady: true,
    peerKeys: {},
    groupAvatars: {},
    showToast: () => {},
    loadGroups: async () => {},
    loadGroupMessages: async () => {},
    loadChannels: async () => {},
    loadContacts: async () => {},
    loadProfiles: async () => {},
    refreshGroupMembers: async () => {},
    loadStoredPeerKeys: async () => {},
    t: (k) => k,
  }, over);
}

// 1. Пусто → ничего не делает
apiMock.pendingAccepts = []; apiMock.pendingContactAccepts = [];
apiMock.pendingInvites = []; apiMock.pendingContactInvites = [];
let ctx = makeCtx();
await processInvites(ctx);
check('пусто — pendingInvites пуст, попап скрыт',
  ctx.pendingInvites.length === 0 && ctx.showInvitePopup === false);

// 2. Есть инвайты → попап показывается, очередь заполняется
apiMock.pendingInvites = [{ group_id: 'G1', uid: 1, sender: 'a@x' }];
ctx = makeCtx();
await processInvites(ctx);
check('инвайты → pendingInvites заполнен', ctx.pendingInvites.length === 1);
check('инвайты → showInvitePopup = true', ctx.showInvitePopup === true);

// 3. Попап уже показан → очередь НЕ перезаписывается
apiMock.pendingInvites = [{ group_id: 'G2', uid: 2, sender: 'b@x' }];
ctx = makeCtx({ showInvitePopup: true, pendingInvites: [{ group_id: 'G1', uid: 1 }] });
await processInvites(ctx);
check('попап показан → очередь не перезаписана', ctx.pendingInvites[0].group_id === 'G1');

// 4. Accept-письма → loadGroups + loadGroupMessages
apiMock.pendingAccepts = [{ group_id: 'G1' }];
ctx = makeCtx({ currentGroup: { id: 'G1' } });
let calls = [];
ctx.loadGroups = async () => { calls.push('loadGroups'); };
ctx.loadGroupMessages = async () => { calls.push('loadGroupMessages'); };
ctx.refreshGroupMembers = async () => { calls.push('refreshGroupMembers'); };
await processInvites(ctx);
check('accepts → loadGroups/loadGroupMessages/refreshGroupMembers вызваны',
  calls.includes('loadGroups') && calls.includes('loadGroupMessages') && calls.includes('refreshGroupMembers'));

// 5. Contact-инвайты → контактный попап
apiMock.pendingAccepts = []; apiMock.pendingContactAccepts = []; apiMock.pendingInvites = [];
apiMock.pendingContactInvites = [{ sender: 'c@x', uid: 5 }];
ctx = makeCtx();
await processInvites(ctx);
check('contact-инвайты → showContactPopup = true', ctx.showContactPopup === true);
check('contact-инвайты → pendingContacts заполнен', ctx.pendingContacts.length === 1);

// 6. Уже обработанные инвайты фильтруются (handledInviteKeys)
apiMock.pendingContactInvites = [];
apiMock.pendingInvites = [{ group_id: 'G1', uid: 1, sender: 'a@x' }];
ctx = makeCtx({ handledInviteKeys: ['G1|1'] });
await processInvites(ctx);
check('handledInviteKeys → уже обработанные фильтруются', ctx.pendingInvites.length === 0);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
