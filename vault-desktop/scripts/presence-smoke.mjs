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
writeFileSync(`${MOCKS}/api.js`, `let getImpl = async (ns,key) => (globalThis.__pvGet ? globalThis.__pvGet(ns,key) : (globalThis.__pv ?? null));\nexport const db = { kvGet: getImpl, kvSet: async () => {} };\nexport default { db };\n`);
writeFileSync(`${MOCKS}/identity.js`, 'export async function accountNamespace(email){ return "ns"; }\n');
writeFileSync(`${MOCKS}/crypto.js`, 'export default { encryptVault: async()=>"", setPeerPublicKey: ()=>{} };\n');
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

console.log('\nИТОГО: ' + p + ' pass, ' + f + ' fail');
if (f) process.exit(1);
