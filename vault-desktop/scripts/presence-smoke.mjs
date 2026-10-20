/**
 * Smoke: features/presence.js
 * ADR-001: чистая логика isEnabled/isOnline/setEnabled.
 * Моки подаются через MOCKS-дир, prepareModuleCopy абсолютизирует остальные импорты.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';

const SRC = '/home/maksim/whisper/vault-desktop/src/features/presence.js';
const MOCKS = '/tmp/presence-smoke-mocks';
mkdirSync(`${MOCKS}/features`, { recursive: true });

// mutable db для isEnabled
const db = {
  kvGet: async (ns, key) => globalThis.__pv ?? '0',
  kvSet: async () => {},
};
writeFileSync(`${MOCKS}/api.js`, `let getImpl = async (ns,key) => (globalThis.__pvGet ? globalThis.__pvGet(ns,key) : (globalThis.__pv ?? null));\nexport const db = { kvGet: getImpl, kvSet: async () => {} };\nexport default { db, sendReaction: async (peer, content) => { (globalThis.__hb = globalThis.__hb || []).push([peer, content]); } };\n`);
writeFileSync(`${MOCKS}/identity.js`, 'export async function accountNamespace(email){ return "ns"; }\n');
writeFileSync(`${MOCKS}/crypto.js`, 'export default { encryptVault: async (p) => { (globalThis.__enc = globalThis.__enc || []).push(p); return "ENC:" + p; }, setPeerPublicKey: (k) => { (globalThis.__pk = globalThis.__pk || []).push(k); } };\n');
writeFileSync(`${MOCKS}/tauri.js`, 'export async function invoke(){}\n');

writeFileSync(`${MOCKS}/features/presence.js`,
  prepareModuleCopy(SRC, `${MOCKS}/features/presence.js`,
    { '../api.js':'api.js', '../identity.js':'identity.js', '../crypto.js':'crypto.js', '@tauri-apps/api/core':'tauri.js' },
    MOCKS));

const mod = await import(`${MOCKS}/features/presence.js`);
const { isEnabled, isOnline, setEnabled, PRESENCE_ONLINE_MS } = mod;

let p = 0, f = 0;
function check(l, c) { if (c) { p++; console.log('  ✓ ' + l); } else { f++; console.log('  ✗ ' + l); } }

// 1. isEnabled true (kv=1)
globalThis.__pv = '1'; globalThis.__pvGet = null;
check('isEnabled true (kv=1)', (await isEnabled('user@x.org')) === true);

// 2. isEnabled false (kv=0)
globalThis.__pv = '0';
check('isEnabled false (kv=0)', (await isEnabled('user@x.org')) === false);

// 3. isEnabled false on throw
globalThis.__pvGet = async () => { throw new Error('db down'); };
check('isEnabled false on throw', (await isEnabled('user@x.org')) === false);
globalThis.__pvGet = null;

// 4. isOnline true within window
const now = Date.now();
check('isOnline true (recent)', isOnline({ 'a@x.org': now - 1000 }, 'a@x.org') === true);

// 5. isOnline false beyond window
check('isOnline false (stale)', isOnline({ 'a@x.org': now - (PRESENCE_ONLINE_MS + 1000) }, 'a@x.org') === false);

// 6. isOnline false no entry
check('isOnline false (noop)', isOnline({}, 'a@x.org') === false);

// 7/8. setEnabled calls start/stop
let started = 0, stopped = 0;
await setEnabled('u@x.org', true, { startHeartbeats: () => { started++; }, stopHeartbeats: () => { stopped++; } });
check('setEnabled(true) starts heartbeat', started === 1 && stopped === 0);

started = 0; stopped = 0;
await setEnabled('u@x.org', false, { startHeartbeats: () => { started++; }, stopHeartbeats: () => { stopped++; } });
check('setEnabled(false) stops heartbeat', started === 0 && stopped === 1);

// 9. heartbeat: письмо каждому пиру с ключом (M2)
// ADR-005 W2 (партия 13): модуль берёт «залогинен» у session-store, ключи —
// у identity-store, cryptoReady — в deps. Здесь проверяется САМ путь отправки
// (раньше он не был покрыт вовсе: смоук трогал только setEnabled).
{
  const { sessionStore } = await import('/home/maksim/whisper/vault-desktop/src/features/session-store.js');
  const { identityStore } = await import('/home/maksim/whisper/vault-desktop/src/features/identity-store.js');
  const { sendHeartbeat } = mod;
  globalThis.__hb = []; globalThis.__enc = []; globalThis.__pk = [];
  identityStore.state.peerKeys = { 'a@x.org': 'KA', 'b@x.org': 'KB' };
  identityStore.state.peerPqKeys = {};
  sessionStore.state.isLoggedIn = true;
  await sendHeartbeat({ cryptoReady: () => true });
  check('heartbeat: письмо каждому пиру с ключом (2)', globalThis.__hb.length === 2, globalThis.__hb);
  const payload = globalThis.__enc.length ? JSON.parse(globalThis.__enc[0]) : {};
  check('heartbeat: конверт presence:1', payload.presence === 1 && typeof payload.ts === 'number', payload);
  check('heartbeat: ключ пира установлен перед шифрованием', globalThis.__pk.length === 2, globalThis.__pk);
  // Ошибка ОДНОГО адресата не должна останавливать остальных (как
  // sendGroupReact): шифрование первого падает — второй всё равно получает
  // heartbeat.
  globalThis.__hb = []; globalThis.__enc = []; globalThis.__pk = [];
  identityStore.state.peerKeys = { 'a@x.org': 'KA', 'b@x.org': 'KB' };
  const realEncrypt = cryptoMock.encryptVault;
  let encCalls = 0;
  cryptoMock.encryptVault = async (p) => {
    encCalls++;
    if (encCalls === 1) throw new Error('encrypt failed for first peer');
    return realEncrypt(p);
  };
  await sendHeartbeat({ cryptoReady: () => true });
  cryptoMock.encryptVault = realEncrypt;
  check('heartbeat: ошибка одного адресата не мешает остальным',
    globalThis.__hb.length === 1 && globalThis.__hb[0][0] === 'b@x.org', globalThis.__hb);
  globalThis.__hb = [];
  sessionStore.state.isLoggedIn = false;
  await sendHeartbeat({ cryptoReady: () => true });
  check('heartbeat: не залогинен → не отправляется', globalThis.__hb.length === 0, globalThis.__hb);
  sessionStore.state.isLoggedIn = true;
  globalThis.__hb = [];
  await sendHeartbeat({ cryptoReady: () => false });
  check('heartbeat: crypto не готов → не отправляется', globalThis.__hb.length === 0, globalThis.__hb);
}

console.log('\nИТОГО: ' + p + ' pass, ' + f + ' fail');
if (f) process.exit(1);
