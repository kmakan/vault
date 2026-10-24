// Node-смоук features/group-invite-queue.js — очередь отложенных приглашений.
// Ключ участника пришёл ПОЗЖЕ приглашения в группу; исполнитель обязан
// доотправить ключ ровно один раз и снять ожидание У МОСТА, а не у себя.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-invite-queue-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

const state = {
  pending: [],          // ответ groups_pending_invites
  peers: [],            // ответ load_peer_keys
  groupKeys: ['GK1'],   // ответ api.getGroupKeys
  inviteThrows: false,
  sent: [],             // вызовы api.inviteGroupMember
  enc: [],              // вызовы crypto.encryptGroupKeyForUser
  cleared: [],          // вызовы groups_invite_sent
  reads: 0,             // сколько раз прочитали очередь (слияние проходов)
};
globalThis.__state = state;
globalThis.__invoke = async (cmd, args) => {
  const st = globalThis.__state;
  if (cmd === 'groups_pending_invites') { st.reads++; return st.pending; }
  if (cmd === 'load_peer_keys') return st.peers;
  if (cmd === 'groups_invite_sent') { st.cleared.push(args); return true; }
  return null;
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');
writeFileSync(MOCKS + '/api.js', `
const api = {
  getGroupKeys: async () => globalThis.__state.groupKeys,
  inviteGroupMember: async (...a) => {
    if (globalThis.__state.inviteThrows) throw new Error('SMTP down');
    globalThis.__state.sent.push(a);
  },
};
export default api;
`);
writeFileSync(MOCKS + '/crypto.js', `
export default {
  encryptGroupKeyForUser: async (groupKey, peerPub) => {
    globalThis.__state.enc.push([groupKey, peerPub]);
    return 'ENC:' + groupKey + ':' + peerPub;
  },
};
`);
prepareModuleCopy(
  ROOT + '/src/features/group-invite-queue.js',
  MOCKS + '/queue.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
  },
  MOCKS,
);
const { flushPendingGroupInvites } = await import(MOCKS + '/queue.mjs');
const deps = { publicKey: () => 'MY_PUB' };
const reset = () => {
  state.pending = []; state.peers = []; state.groupKeys = ['GK1'];
  state.inviteThrows = false; state.sent = []; state.enc = []; state.cleared = []; state.reads = 0;
};

console.log('\nОчередь отложенных приглашений в группу');

// 1. Пустая очередь — no-op, ключи даже не читаем.
reset();
let r = await flushPendingGroupInvites(deps);
check('пустая очередь → no-op', r.sent.length === 0 && state.enc.length === 0);

// 2. Ключ получен — доотправляем и снимаем ожидание у моста.
reset();
state.pending = [{ group_id: 'G1', email: 'Wait@X.ru' }];
state.peers = [{ email: 'wait@x.ru', public_key: 'PUB_W' }];
r = await flushPendingGroupInvites(deps);
check('ключ есть → invite отправлен адресом из очереди',
  state.sent.length === 1 && state.sent[0][0] === 'G1' && state.sent[0][1] === 'Wait@X.ru', state.sent);
check('ключ группы зашифрован на ключ получателя',
  state.enc.length === 1 && state.enc[0][0] === 'GK1' && state.enc[0][1] === 'PUB_W', state.enc);
check('sender public key передан', state.sent.length === 1 && state.sent[0][3] === 'MY_PUB');
check('ожидание снято вызовом groups_invite_sent',
  state.cleared.length === 1 && state.cleared[0].groupId === 'G1' && state.cleared[0].email === 'Wait@X.ru',
  state.cleared);
check('формат ответа моста (group_id/email) прочитан', r.sent.length === 1 && r.failed.length === 0);

// 3. Ключа всё ещё нет → ждём дальше: ни письма, ни снятия.
reset();
state.pending = [{ group_id: 'G1', email: 'ghost@x.ru' }];
state.peers = [{ email: 'other@x.ru', public_key: 'PUB_O' }];
r = await flushPendingGroupInvites(deps);
check('ключа нет → остаётся в очереди (ничего не отправлено)',
  state.sent.length === 0 && state.cleared.length === 0 && r.sent.length === 0);

// 4. Адрес с обрамлением/регистром — тот же человек (сверка нормализованная).
reset();
state.pending = [{ group_id: 'G1', email: ' Wait@X.RU ' }];
state.peers = [{ email: 'wait@x.ru', public_key: 'PUB_W' }];
r = await flushPendingGroupInvites(deps);
check('регистр и обрамление не мешают матчингу', state.sent.length === 1);

// 5. Нет ключа группы → ошибка в отчёт, ожидание НЕ снято (попробуем позже).
reset();
state.pending = [{ group_id: 'G1', email: 'w@x.ru' }];
state.peers = [{ email: 'w@x.ru', public_key: 'PUB_W' }];
state.groupKeys = [];
r = await flushPendingGroupInvites(deps);
check('нет ключа группы → failed, не cleared',
  r.failed.length === 1 && state.cleared.length === 0, r);

// 6. Сбой отправки → failed, ожидание не снято.
reset();
state.pending = [{ group_id: 'G1', email: 'w@x.ru' }];
state.peers = [{ email: 'w@x.ru', public_key: 'PUB_W' }];
state.inviteThrows = true;
r = await flushPendingGroupInvites(deps);
check('SMTP down → failed, не cleared', r.failed.length === 1 && state.cleared.length === 0, r);

// 7. Наложение тиков: второй вызов во время первого не читает очередь дважды
// (иначе ключ ушёл бы получателю два раза).
reset();
state.pending = [{ group_id: 'G1', email: 'w@x.ru' }];
state.peers = [{ email: 'w@x.ru', public_key: 'PUB_W' }];
const p1 = flushPendingGroupInvites(deps);
const p2 = flushPendingGroupInvites(deps);
check('одновременные проходы слиты', p1 === p2);
await p1; await p2;
check('за один проход очередь прочитана один раз', state.reads === 1 && state.sent.length === 1,
  { reads: state.reads, sent: state.sent.length });

// 8. После завершения — следующий проход работает заново.
reset();
state.pending = [{ group_id: 'G2', email: 'z@x.ru' }];
state.peers = [{ email: 'z@x.ru', public_key: 'PUB_Z' }];
r = await flushPendingGroupInvites(deps);
check('после завершения новый проход отправляет снова', r.sent.length === 1 && state.reads === 1, r);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
