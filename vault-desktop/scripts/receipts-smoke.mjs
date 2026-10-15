// Node-смоук features/receipts.js — квитанции о доставке.
// Мокаем api/crypto/db + ctx. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/receipts-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  fetchBodiesDbFirst: async (folder, uids) => {
    const out = {};
    for (const uid of uids) out[uid] = 'ENC:' + uid;
    return out;
  },
  sendReadReceipt: async (...a) => { apiMock.receiptCalls.push(a); },
  receiptCalls: [],
};
const cryptoMock = {
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  setPeerPublicKey: () => {},
  decryptVault: async (body) => {
    const uid = body.replace('ENC:', '');
    if (uid === 'bad') throw new Error('decrypt fail');
    return JSON.stringify({ id: 'msg-' + uid, vault: 1 });
  },
  encryptVault: async (content) => 'ENC:' + content,
};
const _kv = new Map();
const dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
globalThis.__apiMock = apiMock; globalThis.__cryptoMock = cryptoMock; globalThis.__dbMock = dbMock;

prepareModuleCopy(
  ROOT + '/src/features/receipts.js',
  MOCKS + '/receipts.mjs',
  {
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
  },
  MOCKS,
);
const { sendDeliveredReceipts } = await import(MOCKS + '/receipts.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  const c = {
    isLoggedIn: true,
    cryptoReady: true,
    email: 'me@x.ru',
    peerKeys: { 'a@x.ru': 'PUB' },
    peerPqKeys: {},
    emailBodyCache: {},
    senderEmail: (from) => from,
    parseEnvelope: (txt) => { try { return JSON.parse(txt); } catch { return null; } },
  };
  c.cacheBody = (k, v) => { c.emailBodyCache[k] = v; };
  return Object.assign(c, over);
}
let ctx;

// 1. Не залогинен / не cryptoReady / пусто → no-op
apiMock.receiptCalls.length = 0;
await sendDeliveredReceipts(makeCtx({ isLoggedIn: false }), [{ from: 'a@x.ru' }]);
await sendDeliveredReceipts(makeCtx({ cryptoReady: false }), [{ from: 'a@x.ru' }]);
await sendDeliveredReceipts(makeCtx(), []);
check('не залогинен / не cryptoReady / пусто → no-op', apiMock.receiptCalls.length === 0);

// 2. Нет ключа у отправителя → пропускаем
await sendDeliveredReceipts(makeCtx(), [{ from: 'unknown@x.ru', uid: 1, folder: 'INBOX' }]);
check('нет ключа отправителя → пропускаем', apiMock.receiptCalls.length === 0);

// 2b. Своё письмо → пропускаем
await sendDeliveredReceipts(makeCtx(), [{ from: 'me@x.ru', uid: 2, folder: 'INBOX' }]);
check('своё письмо → пропускаем', apiMock.receiptCalls.length === 0);

// 3. Настоящее vault-письмо → квитанция отправляется
_kv.clear(); apiMock.receiptCalls.length = 0;
ctx = makeCtx();
await sendDeliveredReceipts(ctx, [{ from: 'a@x.ru', uid: 10, folder: 'INBOX' }]);
check('vault-письмо → sendReadReceipt вызван', apiMock.receiptCalls.length === 1);
check('квитанция содержит msg_ids', JSON.parse(apiMock.receiptCalls[0][1].replace('ENC:', '')).msg_ids.length === 1);
check('delivered-sent записан в kv', _kv.has('delivered-sent'));

// 4. Дедуп: уже отправленная квитанция не повторяется
apiMock.receiptCalls.length = 0;
await sendDeliveredReceipts(makeCtx(), [{ from: 'a@x.ru', uid: 10, folder: 'INBOX' }]);
check('дедуп: повторная квитанция НЕ отправлена', apiMock.receiptCalls.length === 0);

// 5. Не vault-письмо (нет env.id) → пропускаем
apiMock.receiptCalls.length = 0;
const ctx5 = makeCtx({ peerKeys: { 'b@x.ru': 'PUB' } });
cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1 }); // нет id
await sendDeliveredReceipts(ctx5, [{ from: 'b@x.ru', uid: 20, folder: 'INBOX' }]);
check('не vault-письмо (нет env.id) → пропускаем', apiMock.receiptCalls.length === 0);

// 6. Ошибка расшифровки → пропускаем
cryptoMock.decryptVault = async (body) => { const u = body.replace('ENC:', ''); if (u === 'bad') throw new Error('fail'); return JSON.stringify({ id: 'm' }); };
await sendDeliveredReceipts(makeCtx(), [{ from: 'a@x.ru', uid: 'bad', folder: 'INBOX' }]);
check('ошибка расшифровки → пропускаем', apiMock.receiptCalls.length === 0);

// 7. Cap 500: создаём 501 запись, после вызова остаётся 500
_kv.clear(); apiMock.receiptCalls.length = 0;
const bigMap = {};
for (let i = 0; i < 501; i++) bigMap['old-' + i] = i;
_kv.set('delivered-sent', JSON.stringify(bigMap));
cryptoMock.decryptVault = async (body) => JSON.stringify({ id: 'msg-' + body.replace('ENC:', ''), vault: 1 });
await sendDeliveredReceipts(makeCtx(), [{ from: 'a@x.ru', uid: 99, folder: 'INBOX' }]);
// kvSet в модуле fire-and-forget (.catch) — ждём, пока промисс выполнится.
await new Promise(r => setTimeout(r, 200));
const after = JSON.parse(_kv.get('delivered-sent'));
check('cap 500: после вызова записей = 500', Object.keys(after).length === 500, Object.keys(after).length);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
