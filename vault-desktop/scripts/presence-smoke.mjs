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
writeFileSync(`${MOCKS}/api.js`, `let getImpl = async (ns,key) => (globalThis.__pvGet ? globalThis.__pvGet(ns,key) : (globalThis.__pv ?? null));\nexport const db = { kvGet: getImpl, kvSet: async (ns,key,v) => { if (globalThis.__pvKvFail) throw new Error('kv недоступен'); } };\nexport default { db, sendReaction: async (peer, content) => { (globalThis.__hb = globalThis.__hb || []).push([peer, content]); } };\n`);
writeFileSync(`${MOCKS}/identity.js`, 'export async function accountNamespace(email){ return "ns"; }\n');
writeFileSync(`${MOCKS}/crypto.js`, 'export default { encryptVault: async (p) => { if (globalThis.__encFailFirst) { globalThis.__encFailFirst = false; throw new Error("encrypt failed"); } (globalThis.__enc = globalThis.__enc || []).push(p); return "ENC:" + p; }, setPeerPublicKey: (k) => { (globalThis.__pk = globalThis.__pk || []).push(k); } };\n');
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
  // ТРИ пира: список берётся ИЗ КАРТЫ пиров. Список, зашитый в код, дал бы
  // два письма — и проверка на количество это поймала бы.
  identityStore.state.peerKeys = { 'a@x.org': 'KA', 'b@x.org': 'KB', 'c@x.org': 'KC' };
  identityStore.state.peerPqKeys = {};
  sessionStore.state.isLoggedIn = true;
  await sendHeartbeat({ cryptoReady: () => true });
  check('heartbeat: письмо каждому пиру из карты (3)', globalThis.__hb.length === 3, globalThis.__hb);
  const payload = globalThis.__enc.length ? JSON.parse(globalThis.__enc[0]) : {};
  check('heartbeat: конверт presence:1', payload.presence === 1 && typeof payload.ts === 'number', payload);
  check('heartbeat: ключ пира установлен перед шифрованием', globalThis.__pk.length === 3, globalThis.__pk);
  // Ошибка ОДНОГО адресата не должна останавливать остальных (как
  // sendGroupReact): шифрование первого падает — второй всё равно получает
  // heartbeat.
  globalThis.__hb = []; globalThis.__enc = []; globalThis.__pk = [];
  identityStore.state.peerKeys = { 'a@x.org': 'KA', 'b@x.org': 'KB' };
  // Первый вызов encryptVault падает — второй адресат должен получить heartbeat
  // всё равно (ошибка одного не должна останавливать остальных).
  let encCalls = 0;
  globalThis.__encFailFirst = true;
  await sendHeartbeat({ cryptoReady: () => true });
  globalThis.__encFailFirst = false;
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

// ── 9. setPresenceEnabled: переключение с гарантией «без тишины» ───────
console.log('9. setPresenceEnabled: запись в kv + запуск/остановка heartbeat');
{
  let started = 0, stopped = 0;
  const deps = {
    email: 'u@x.org',
    startHeartbeats: () => { started++; },
    stopHeartbeats: () => { stopped++; },
  };
  await mod.setPresenceEnabled(deps, true);
  check('включение: heartbeat запущен', started === 1 && stopped === 0, { started, stopped });
  await mod.setPresenceEnabled(deps, false);
  check('выключение: heartbeat остановлен', started === 1 && stopped === 1, { started, stopped });
}
{
  // Выключение должно ОСТАНОВИТЬ heartbeat: иначе мы продолжаем писать
  // «я онлайн» в пустоту (и тратим письма).
  let stoppedAfterOff = 0;
  const deps = {
    email: 'u@x.org',
    startHeartbeats: () => {},
    stopHeartbeats: () => { stoppedAfterOff++; },
  };
  await mod.setPresenceEnabled(deps, false);
  check('выключение: heartbeat остановлен (а не продолжает писать)', stoppedAfterOff === 1, stoppedAfterOff);
}
{
  // Ошибка записи в kv гасится внутри setEnabled (kv-недоступен — значит
  // остаётся in-memory), и включение при этом НЕ роняется: пользователь не
  // должен получать ошибку за настройку, которую он просто включил.
  let threw = false;
  const deps = {
    email: 'u@x.org',
    startHeartbeats: () => {},
    stopHeartbeats: () => {},
  };
  globalThis.__pvKvFail = true;
  try { await mod.setPresenceEnabled(deps, true); } catch (e) { threw = true; }
  globalThis.__pvKvFail = false;
  check('сбой записи не пробрасывается наружу', threw === false, threw);
{
}
  let started = 0;
  const deps2 = { email: 'u@x.org', startHeartbeats: () => { started++; }, stopHeartbeats: () => {} };
  await mod.onPresenceEnabled(deps2, true);
  check('обработчик переключателя ведёт себя как setEnabled', started === 1, started);
}

console.log('\nИТОГО: ' + p + ' pass, ' + f + ' fail');
if (f) process.exit(1);
