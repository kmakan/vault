// Node-смоук features/keys.js — ключи пиров, своя крипто-пара, канонический
// адрес.
//
// ADR-005 W3 (`t_b1bdbb99`), партия 9: логика уехала из App.vue. Своя пара
// и отпечаток — у владельца идентичности (identity-store), ключи пиров — там
// же; сама пара — в Rust (crypto.js).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/keys-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки ────────────────────────────────────────────────────────────────
globalThis.__cryptoMock = {
  initFromStorage: async () => ({ loaded: false }),
  generateKeypair: async () => ({ public_key: 'pk-new' }),
  saveToStorage: async () => {},
  fingerprint: async () => 'fp-1',
  setPeerPublicKey: (...a) => { globalThis.__cryptoMock.setPeerCalls.push(a); },
  setPeerCalls: [],
  savePeerKey: async (...a) => { globalThis.__cryptoMock.savedPeerKeys.push(a); },
  savedPeerKeys: [],
  loadPeerKeys: async () => globalThis.__cryptoMock.storedPeerKeys,
  storedPeerKeys: [],
  removePeerKey: async (...a) => { globalThis.__cryptoMock.removedPeerKeys.push(a); },
  removedPeerKeys: [],
};
writeFileSync(MOCKS + '/crypto-mock.mjs', `
const M = (name, ...a) => globalThis.__cryptoMock[name](...a);
export default {
  initFromStorage: (...a) => M('initFromStorage', ...a),
  generateKeypair: (...a) => M('generateKeypair', ...a),
  saveToStorage: (...a) => M('saveToStorage', ...a),
  fingerprint: (...a) => M('fingerprint', ...a),
  setPeerPublicKey: (...a) => M('setPeerPublicKey', ...a),
  savePeerKey: (...a) => M('savePeerKey', ...a),
  loadPeerKeys: (...a) => M('loadPeerKeys', ...a),
  removePeerKey: (...a) => M('removePeerKey', ...a),
};
`);
globalThis.__apiMock = {
  calls: [],
  removeContact: (email) => { globalThis.__apiMock.calls.push(['removeContact', email]); },
  sendContactInvite: async (email, key) => { globalThis.__apiMock.calls.push(['sendContactInvite', email, key]); return true; },
};
writeFileSync(MOCKS + '/api-mock.mjs', `
const A = globalThis.__apiMock;
export const db = { kvGet: async () => null, kvSet: async () => {} };
export default {
  removeContact: (...a) => A.removeContact(...a),
  sendContactInvite: (...a) => A.sendContactInvite(...a),
};
`);
globalThis.__nsMock = { resets: 0, ensured: [] };
writeFileSync(MOCKS + '/identity-mock.mjs', `
const N = globalThis.__nsMock;
export const resetAccountNamespaceCache = () => { N.resets++; };
export const ensureAccountNamespace = async (email) => { N.ensured.push(email); return 'ns:' + email; };
export const accountNamespace = async (email) => 'ns:' + email;
`);
writeFileSync(MOCKS + '/core-mock.mjs', 'export const invoke = async () => undefined;\n');

prepareModuleCopy(
  ROOT + '/src/features/keys.js',
  MOCKS + '/keys.mjs',
  {
    '@tauri-apps/api/core': 'core-mock.mjs',
    '../api.js': 'api-mock.mjs',
    '../crypto.js': 'crypto-mock.mjs',
    '../identity.js': 'identity-mock.mjs',
  },
  MOCKS,
);
const K = await import(MOCKS + '/keys.mjs');
const { identityStore } = await import(ROOT + '/src/features/identity-store.js');

// Окружение браузера для loadStoredPeerKeys (глобальные хуки очереди чатов
// и localStorage). В Node их нет — без стабов ветка «холодный старт» не
// проверялась бы вовсе.
globalThis.window = { __VAULT_CHAT_QUEUE: [] };
globalThis.localStorage = { getItem: () => null, removeItem: () => {}, setItem: () => {}, };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const state = { email: 'me@x.ru', publicKey: null, cryptoReady: false, fingerprint: null, alerts: [], prompted: '', opened: [], mobile: false, contacts: [] };
const deps = {
  email: () => state.email,
  activeChat: () => state.activeChat || null,
  publicKey: () => state.publicKey,
  cryptoReady: () => state.cryptoReady,
  fingerprint: () => state.fingerprint,
  setPublicKey: (v) => { state.publicKey = v; },
  setCryptoReady: (v) => { state.cryptoReady = v; },
  setFingerprint: (v) => { state.fingerprint = v; },
  loadStoredPeerKeys: async () => { state.loaded = (state.loaded || 0) + 1; },
  openChatByKey: (k) => { state.opened.push(k); },
  isMobile: false,
  setMobileChatOpen: (v) => { state.mobile = v; },
  contacts: () => state.contacts,
  loadContacts: async () => { state.contactsLoaded = (state.contactsLoaded || 0) + 1; },
  setShowQRCode: (v) => { state.qr = v; },
  alert: (m) => { state.alerts.push(m); },
  prompt: async (m) => { state.prompted = m; return state.promptAnswer || ''; },
};
function reset() {
  globalThis.__cryptoMock.initFromStorage = async () => ({ loaded: false });
  globalThis.__cryptoMock.generateKeypair = async () => ({ public_key: 'pk-new' });
  globalThis.__cryptoMock.storedPeerKeys = [];
  globalThis.__cryptoMock.savedPeerKeys = [];
  globalThis.__cryptoMock.removedPeerKeys = [];
  globalThis.__cryptoMock.setPeerCalls = [];
  globalThis.__apiMock.calls = [];
  globalThis.__nsMock.resets = 0;
  globalThis.__nsMock.ensured = [];
  state.publicKey = null; state.cryptoReady = false; state.fingerprint = null;
  state.alerts = []; state.opened = []; state.contacts = []; state.promptAnswer = '';
  state.loaded = 0; state.contactsLoaded = 0; state.qr = null; state.activeChat = null; state.mobile = false;
  identityStore.state.peerKeys = {};
  identityStore.state.peerPqKeys = {};
  identityStore.state.peerKeyInput = '';
  identityStore.state.peerKeysLoaded = {};
  identityStore.state.publicKey = null;
  identityStore.state.cryptoReady = false;
  identityStore.state.fingerprint = null;
}

// 1. initCrypto: ключ на диске → пара восстановлена, без генерации
console.log('1. initCrypto: восстановленный ключ');
{
  reset();
  let gen = 0;
  globalThis.__cryptoMock.initFromStorage = async () => ({ loaded: true, keypair: { public_key: 'pk-restored' } });
  globalThis.__cryptoMock.generateKeypair = async () => { gen++; return { public_key: 'pk-new' }; };
  const r = await K.initCrypto(deps, { allowCreate: false });
  check('восстановленный ключ → true', r === true);
  check('генерации нет', gen === 0);
  check('publicKey восстановлен', state.publicKey === 'pk-restored', state.publicKey);
  check('отпечаток посчитан', state.fingerprint === 'fp-1', state.fingerprint);
  check('готовность включена', state.cryptoReady === true);
  check('namespace пересчитан', globalThis.__nsMock.resets === 1 && globalThis.__nsMock.ensured.length === 1, globalThis.__nsMock);
  check('ключи пиров загружены', state.loaded === 1, state.loaded);
}

// 2. initCrypto: ключа нет и allowCreate=false → false, БЕЗ генерации
console.log('2. initCrypto: ключа нет, генерация запрещена');
{
  reset();
  let gen = 0;
  globalThis.__cryptoMock.generateKeypair = async () => { gen++; return { public_key: 'pk-new' }; };
  const r = await K.initCrypto(deps, { allowCreate: false });
  check('без ключа и без allowCreate → false', r === false);
  check('генерации нет', gen === 0);
  check('готовность снята', state.cryptoReady === false);
}

// 3. initCrypto: явный вход (allowCreate=true) → пара создаётся ровно один раз
console.log('3. initCrypto: явный вход — пара создаётся');
{
  reset();
  let gen = 0;
  globalThis.__cryptoMock.generateKeypair = async () => { gen++; return { public_key: 'pk-new' }; };
  const r = await K.initCrypto(deps, { allowCreate: true });
  check('allowCreate:true → true', r === true);
  check('генерация ровно одна', gen === 1, gen);
  check('publicKey выставлен', state.publicKey === 'pk-new', state.publicKey);
}

// 4. initCrypto: сбой крипто → false, без падения
console.log('4. initCrypto: сбой');
{
  reset();
  globalThis.__cryptoMock.initFromStorage = async () => { throw new Error('disk error'); };
  state.cryptoReady = true;   // до сбоя было готово — иначе «снята» нечего проверять
  const r = await K.initCrypto(deps, { allowCreate: false });
  check('сбой → false, без исключения', r === false);
  check('готовность снята', state.cryptoReady === false, state.cryptoReady);
}

// 5. loadStoredPeerKeys: ключи пиров в владельца + очередь чатов
console.log('5. loadStoredPeerKeys');
{
  reset();
  globalThis.__cryptoMock.storedPeerKeys = [{ email: 'a@x.ru', public_key: 'KA' }];
  globalThis.window.__VAULT_CHAT_QUEUE.push('queued@x.ru');   // отложенный чат (холодный старт)
  identityStore.state.peerKeys['stale@x.ru'] = 'KSTALE';   // удалённый в Rust ключ
  await K.loadStoredPeerKeys(deps);
  check('ключ пира в owner', identityStore.state.peerKeys['a@x.ru'] === 'KA', identityStore.state.peerKeys);
  check('устаревший ключ вычищен', !identityStore.state.peerKeys['stale@x.ru'], identityStore.state.peerKeys);
  check('хук очереди установлен', typeof globalThis.window.__VAULT_DRAIN === 'function');
  check('очередь разобрана при загрузке ключей (чат открыт)', state.opened.includes('queued@x.ru'), state.opened);
  check('очередь пуста', (globalThis.window.__VAULT_CHAT_QUEUE || []).length === 0, globalThis.window.__VAULT_CHAT_QUEUE);
}

// 6. setPeerKey: владелец + Rust-хранилище
console.log('6. setPeerKey');
{
  reset();
  K.setPeerKey(deps, 'b@x.ru', 'KB', 'PQB');
  check('ключ в owner', identityStore.state.peerKeys['b@x.ru'] === 'KB', identityStore.state.peerKeys);
  check('сохранён в Rust-хранилище', globalThis.__cryptoMock.savedPeerKeys.length === 1, globalThis.__cryptoMock.savedPeerKeys);
}

// 7. setPeerKeyFromInput: пустое поле / нет чата → no-op
console.log('7. setPeerKeyFromInput');
{
  reset();
  K.setPeerKeyFromInput(deps);
  check('пустое поле → no-op', Object.keys(identityStore.state.peerKeys).length === 0);
  identityStore.setPeerKeyInput('KMANUAL');
  // Без активного чата ввод не должен ничего записывать.
  K.setPeerKeyFromInput(deps);
  check('введённый ключ без чата — не записывается', Object.keys(identityStore.state.peerKeys).length === 0, identityStore.state.peerKeys);
  state.activeChat = 'c@x.ru';
  K.setPeerKeyFromInput(deps);
  check('ключ из поля записан', identityStore.state.peerKeys['c@x.ru'] === 'KMANUAL', identityStore.state.peerKeys);
  check('поле очищено', identityStore.state.peerKeyInput === '');
}

// 8. addPeerKey: формат ключа
console.log('8. addPeerKey: валидация');
{
  reset();
  await K.addPeerKey(deps, { publicKey: 'не-hex' });
  // Проверяем СООБЩЕНИЕ: без allowCreate-пути «плохой формат» продолжил бы
  // диалог и упал бы на «email контакта?» — другое сообщение.
  check('плохой формат → отказ (сообщение о формате)',
    state.alerts.length === 1 && /Invalid public key format/i.test(state.alerts[0]) && globalThis.__apiMock.calls.length === 0,
    state.alerts);
}

// 9. addPeerKey: ключ из QR с email → сохранён, взаимный инвайт ушёл
console.log('9. addPeerKey: QR с email');
{
  reset();
  const hex = 'a'.repeat(64);
  await K.addPeerKey(deps, { publicKey: hex, email: 'Friend@X.RU' });
  check('ключ сохранён под нормализованным email', identityStore.state.peerKeys['friend@x.ru'] === hex, identityStore.state.peerKeys);
  check('взаимный инвайт отправлен', globalThis.__apiMock.calls.some((c) => c[0] === 'sendContactInvite' && c[1] === 'friend@x.ru'), globalThis.__apiMock.calls);
  check('окно QR закрыто', state.qr === false);
}

// 10. addPeerKey: голый hex → спрашиваем email
console.log('10. addPeerKey: голый ключ — спрашиваем email');
{
  reset();
  state.promptAnswer = 'typed@x.ru';
  await K.addPeerKey(deps, 'b'.repeat(64));
  check('email спрошен', state.prompted.length > 0);
  check('ключ сохранён', identityStore.state.peerKeys['typed@x.ru'] === 'b'.repeat(64), identityStore.state.peerKeys);
}

// 11. addPeerKey: дедуп по ключу (собеседник сменил почту)
console.log('11. addPeerKey: дедуп по ключу');
{
  reset();
  const hex = 'c'.repeat(64);
  identityStore.state.peerKeys['old@x.ru'] = hex;
  await K.addPeerKey(deps, { publicKey: hex, email: 'new@x.ru' });
  check('старая запись удалена', !identityStore.state.peerKeys['old@x.ru'], identityStore.state.peerKeys);
  check('контакт удалён у получателя', globalThis.__apiMock.calls.some((c) => c[0] === 'removeContact' && c[1] === 'old@x.ru'), globalThis.__apiMock.calls);
}

// 12. onKeysChanged: отпечаток пересчитывается, ключи перезагружаются
console.log('12. onKeysChanged');
{
  reset();
  state.cryptoReady = true;
  await K.onKeysChanged(deps);
  check('отпечаток пересчитан', state.fingerprint === 'fp-1', state.fingerprint);
  check('ключи перезагружены', state.loaded === 1, state.loaded);
}

// 13. canonicalOf: по ключу находится канонический адрес
console.log('13. canonicalOf');
{
  reset();
  identityStore.state.peerKeys['key@x.ru'] = 'K1';
  state.contacts = [{ public_key: 'K1', email: 'real@x.ru' }];
  check('канонический адрес по ключу', K.canonicalOf(deps, 'key@x.ru') === 'real@x.ru', K.canonicalOf(deps, 'key@x.ru'));
  check('без ключа — как есть', K.canonicalOf(deps, 'plain@x.ru') === 'plain@x.ru');
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
