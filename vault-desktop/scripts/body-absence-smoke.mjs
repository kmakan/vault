// smoke: body-absence-smoke.mjs
// Контракт границы «Rust ↔ фронт»: ПУСТОЕ ТЕЛО = «этого тела не будет никогда».
//
// Живой симптом (жалоба 22.10, «приглашения от старых email»): письмо, тела
// которого на IMAP-сервере нет в принципе (RELAY-конверт, не-IMAP uid, письмо
// ушло из папки), запрашивалось ЗАНОВО каждым поллингом — негатив не кэшировался,
// потому что ответ Rust «пусто» был неотличим от ответа «не знаю». Замер на
// стенде realprof: 368 одинаковых строк `[email] body fetch: virtual folder
// RELAY — skipped` за 2,5 минуты.
//
// Что здесь закреплено (ADR-005: решение — в Rust, адаптер — тонкий):
//   A. fetchBodiesDbFirst различает терминальное отсутствие (запись с '' —
//      остаётся в карте, но НЕ попадает в body_cache) и транзиторное (записи
//      нет — повторим следующим тиком).
//   B. fetchAllHandshake по терминальному ответу кэширует разбор и перестаёт
//      переспрашивать тело, а транзиторное переспрашивает; приглашение при этом
//      НЕ исчезает из выдачи.
//   C. мета-скан группы (group-meta.js) по пустому телу заносит письмо в
//      applied-sig и больше его не фетчит; при ИСКЛЮЧЕНИИ моста — не метит
//      (временный сбой обязан повториться).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/body-absence-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function mute() {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return () => { console.log = l; console.warn = w; console.error = e; };
}

// ── мир: только то, что реально дёргает мост ──────────────────────
const world = {
  cache: new Map(),      // 'folder:uid' → тело (sqlite body_cache)
  cacheSets: [],         // ключи, записанные в body_cache
  batchCalls: [],        // аргументы email_fetch_bodies по тикам
  batch: [],             // что Rust отвечает на батч: [[uid, body], …]
  body: '',              // что Rust отвечает на одиночный фетч
  bodyThrows: false,
};
globalThis.__W = world;
// ApiClient читает localStorage в конструкторе (токен/емейл входа).
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  clear: () => lsStore.clear(),
};
globalThis.__INVOKE__ = async (cmd, args) => {
  const W = globalThis.__W;
  switch (cmd) {
    case 'db_account_namespace': return 'fp:testnamespace';
    case 'db_body_cache_get': return W.cache.has(args.cacheKey) ? W.cache.get(args.cacheKey) : null;
    case 'db_body_cache_set':
      W.cacheSets.push(args.cacheKey);
      W.cache.set(args.cacheKey, args.body);
      return true;
    case 'email_fetch_bodies':
      W.batchCalls.push({ folder: args.folder, uids: args.uids.slice() });
      return W.batch;
    case 'email_fetch_body':
      if (W.bodyThrows) throw new Error('Timed out fetching message body');
      return W.body;
    default: return undefined;
  }
};

writeFileSync(MOCKS + '/crypto.js', `
export default {
  initFromStorage: async () => {}, generateKeypair: async () => ({}),
  saveToStorage: async () => {}, fingerprint: async () => 'fp:test',
  setPeerPublicKey: () => {}, savePeerKey: async () => {},
  loadPeerKeys: async () => [], removePeerKey: async () => {},
};
`);
writeFileSync(MOCKS + '/identity.js', `
export const accountNamespace = async () => 'fp:testnamespace';
export const ensureAccountNamespace = async () => 'fp:testnamespace';
export const resetAccountNamespaceCache = () => {};
export const resolveAlias = async (a) => a;
export const rememberAlias = async () => {};
export const isOwnSender = async (a, e) => String(a||'').trim().toLowerCase() === String(e||'').trim().toLowerCase();
`);
writeFileSync(MOCKS + '/recovery-session.js', `
export const isRecoveryPending = () => false;
export const clearRecoveryPending = () => true;
`);

// ══════════════════════════════════════════════════════════════════
// A + B: живой src/api.js с подменённым мостом
// ══════════════════════════════════════════════════════════════════
console.log('\nfetchBodiesDbFirst — терминальное отсутствие не путается с «не знаю»:');
const API_FILE = MOCKS + '/api-live.mjs';
prepareModuleCopy(
  ROOT + '/src/api.js',
  API_FILE,
  {
    './crypto.js': 'crypto.js',
    './identity.js': 'identity.js',
    './features/recovery-session.js': 'recovery-session.js',
  },
  MOCKS,
  [["import { invoke } from '@tauri-apps/api/core';", 'const invoke = (...a) => globalThis.__INVOKE__(...a);']],
);
const mod = await import('file://' + API_FILE);
const api = new mod.ApiClient();
api.email = 'me@example.invalid';

{
  world.cache.clear(); world.cacheSets = [];
  // Rust: uid 1 — живое тело; uid 2 — «не будет никогда» (запись с пустым
  // телом); uid 3 — в ответе нет вовсе (транзиторно, повторить).
  world.batch = [['1', 'REALBODY'], ['2', '']];
  const unmute = mute();
  const out = await api.fetchBodiesDbFirst('INBOX', ['1', '2', '3']);
  unmute();
  check('живое тело вернуть как тело', out['1'] === 'REALBODY');
  check('терминальное отсутствие осталось В КАРТЕ (ключ есть, тело пустое)',
    Object.prototype.hasOwnProperty.call(out, '2') && out['2'] === '', out);
  check('терминальное отсутствие НЕ записано в body_cache',
    !world.cacheSets.includes('INBOX:2'), world.cacheSets);
  check('живое тело записано в body_cache', world.cacheSets.includes('INBOX:1'), world.cacheSets);
  check('«не знаю» (uid без записи) в карте НЕ появляется',
    !Object.prototype.hasOwnProperty.call(out, '3'), out);
}

console.log('\nfetchAllHandshake — негатив кэшируется, письмо не теряется:');
{
  world.cache.clear(); world.cacheSets = []; world.batchCalls = [];
  api._emailsSource = [
    { uid: '40', folder: 'RELAY', subject: 'VaultContactInvite: old@example.invalid', date: '2026-10-01' },
    { uid: '41', folder: 'INBOX', subject: 'VaultContactInvite: peer@example.invalid', date: '2026-10-02' },
  ];
  // Тик 1: RELAY-конверт получил пометку «никогда», uid 41 ответа не получил.
  world.batch = [['40', '']];
  let unmute = mute();
  await api.fetchAllHandshake();
  unmute();
  const askedFirst = world.batchCalls.flatMap(c => c.uids);
  check('первый тик спросил оба конверта (батчи группируются по папке)',
    askedFirst.includes('40') && askedFirst.includes('41'), world.batchCalls);

  world.batchCalls = [];
  unmute = mute();
  api._handshakeCache = null;            // как processInvites на следующем тике
  const t2 = await api.fetchAllHandshake();
  unmute();
  check('второй тик НЕ переспрашивает RELAY-конверт с пометкой «никогда»',
    !world.batchCalls.some(c => c.folder === 'RELAY'), world.batchCalls);
  check('второй тик переспрашивает транзиторный uid',
    world.batchCalls.some(c => c.folder === 'INBOX' && c.uids.includes('41')), world.batchCalls);
  check('инвайт с пустым телом НЕ исчез из выдачи',
    t2.invites.some(i => String(i.uid) === '40'), t2.invites.map(i => i.uid));

  // Тик 3: Rust и по 41 сказал «никогда» → steady state: ни одного запроса.
  world.batch = [['41', '']];
  unmute = mute();
  api._handshakeCache = null;
  await api.fetchAllHandshake();
  api._handshakeCache = null;
  world.batchCalls = [];
  await api.fetchAllHandshake();
  unmute();
  check('после двух терминальных ответов поллинг НЕ делает ни одного фетча тел',
    world.batchCalls.length === 0, world.batchCalls);
}

// ══════════════════════════════════════════════════════════════════
// C: мета-скан группы — applied-sig по решению Rust
// ══════════════════════════════════════════════════════════════════
console.log('\nsyncGroupAvatarsFromMeta — пустое тело заносится в applied-sig:');
const { sessionStore } = await import('file://' + ROOT + '/src/features/session-store.js');
const { mailboxState } = await import('file://' + ROOT + '/src/features/mailbox-store.js');

const gmWorld = { kv: {}, fetches: [] };
writeFileSync(MOCKS + '/gm-api.js', `
const db = {
  kvGet: async (ns, key) => (Object.prototype.hasOwnProperty.call(globalThis.__GM.kv, key) ? globalThis.__GM.kv[key] : null),
  kvSet: async (ns, key, val) => { globalThis.__GM.kv[key] = val; return true; },
};
const api = {
  getMyGroupKey: async () => ({ group_key: 'gk1' }),
  fetchEmailBody: async (acc, uid, folder) => {
    globalThis.__GM.fetches.push(String(uid) + '@' + (folder || 'INBOX'));
    if (globalThis.__GM.throwBody) throw new Error('Timed out fetching message body');
    return globalThis.__GM.body;
  },
};
export { db };
export default api;
`);
writeFileSync(MOCKS + '/gm-crypto.js', `
export default {
  isEncrypted: (b) => globalThis.__GM.encrypt && !!b,
  decryptWithGroupKey: async () => 'plain',
};
`);
writeFileSync(MOCKS + '/gm-wire.js', `
export const parseSignal = async () => ({ kind: 'other' });
export const envelopeObject = async () => ({});
`);
globalThis.__GM = gmWorld;
const GM_FILE = MOCKS + '/group-meta-live.mjs';
prepareModuleCopy(
  ROOT + '/src/features/group-meta.js',
  GM_FILE,
  {
    '../api.js': 'gm-api.js',
    '../crypto.js': 'gm-crypto.js',
    '../wire-signal-rule.js': 'gm-wire.js',
    '@tauri-apps/api/core': 'core-none.mjs',
  },
  MOCKS,
);
writeFileSync(MOCKS + '/core-none.mjs', 'export const invoke = async () => undefined;\n');
const { syncGroupAvatarsFromMeta } = await import('file://' + GM_FILE);

const deps = {
  groups: [{ id: 'grp1', name: 'G', members: [{ email: 'peer@example.invalid' }] }],
  groupStore: { state: { groupKeys: { grp1: 'gk1' } }, setGroupAvatar: () => {} },
  cryptoReady: () => true,
  replyGroupAvatarHeal: async () => true,
  healGroupAvatarFromMessage: async () => {},
};
sessionStore.state.isLoggedIn = true;
mailboxState.state.emails = [
  { uid: '77', folder: 'RELAY', from: 'peer@example.invalid', date: '2026-10-02' },
];
const appliedKey = 'group-meta-applied:grp1';

{
  gmWorld.kv = {}; gmWorld.fetches = []; gmWorld.throwBody = false; gmWorld.body = '';
  const unmute = mute();
  await syncGroupAvatarsFromMeta(deps);
  await syncGroupAvatarsFromMeta(deps);
  unmute();
  check('пустое тело помечено обработанным (applied-sig записан)',
    (gmWorld.kv[appliedKey] || '').includes('77@RELAY'), gmWorld.kv);
  check('второй проход НЕ фетчит то же письмо',
    gmWorld.fetches.length === 1, gmWorld.fetches);
}
{
  // Временный сбой моста — НЕ помечаем: следующий тик обязан повторить.
  gmWorld.kv = {}; gmWorld.fetches = []; gmWorld.throwBody = true;
  const unmute = mute();
  await syncGroupAvatarsFromMeta(deps);
  unmute();
  check('исключение моста не помечает письмо (повтор будет)',
    gmWorld.fetches.length === 1 && !String(gmWorld.kv[appliedKey] || '').includes('77@RELAY'),
    { fetches: gmWorld.fetches, kv: gmWorld.kv[appliedKey] });
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
