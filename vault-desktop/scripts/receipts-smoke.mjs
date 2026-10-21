// Node-смоук features/receipts.js — квитанции о доставке.
// Мокаем api/crypto/db + ctx. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { installEnvelopeMock } from './lib/wire-envelope-mock.mjs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/receipts-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
// Мок формата wire-конверта (ADR-005 W4): правила — в Rust, здесь их
// тестовый двойник (scripts/lib/wire-envelope-mock.mjs + envelope-mock.mjs).
await installEnvelopeMock(MOCKS);

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
    return JSON.stringify({ id: 'msg-' + uid, vault: 1, text: 't' });
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
  '../message-format.js': 'message-format.js',
    '../message-format.js': 'message-format.js',
    '../crypto.js': 'crypto.js',
  },
  MOCKS,
);
const R = await import(MOCKS + '/receipts.mjs');
const { sendDeliveredReceipts } = R;

// ADR-005 W2 (партия 11): состояние — у владельцев. Смоук берёт ТЕ ЖЕ
// синглтоны, что импортирует копия модуля, — иначе проверял бы не тот объект.
const { sessionStore } = await import(ROOT + '/src/features/session-store.js');
const { identityStore } = await import(ROOT + '/src/features/identity-store.js');
const { mailboxState } = await import(ROOT + '/src/features/mailbox-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeWorld(over = {}) {
  const w = Object.assign({
    isLoggedIn: true,
    cryptoReady: true,
    email: 'me@x.ru',
    peerKeys: { 'a@x.ru': 'PUB' },
    peerPqKeys: {},
    emailBodyCache: {},
  }, over);
  sessionStore.state.isLoggedIn = w.isLoggedIn;
  sessionStore.setCurrentEmail(w.email);
  identityStore.state.peerKeys = w.peerKeys;
  identityStore.state.peerPqKeys = w.peerPqKeys;
  mailboxState.state.emailBodyCache = w.emailBodyCache;
  const deps = { cryptoReady: () => w.cryptoReady };
  return { w, deps };
}
let ctx;

// 1. Не залогинен / не cryptoReady / пусто → no-op
apiMock.receiptCalls.length = 0;
await sendDeliveredReceipts(makeWorld({ isLoggedIn: false }).deps, [{ from: 'a@x.ru' }]);
await sendDeliveredReceipts(makeWorld({ cryptoReady: false }).deps, [{ from: 'a@x.ru' }]);
await sendDeliveredReceipts(makeWorld().deps, []);
check('не залогинен / не cryptoReady / пусто → no-op', apiMock.receiptCalls.length === 0);

// 2. Нет ключа у отправителя → пропускаем
await sendDeliveredReceipts(makeWorld().deps, [{ from: 'unknown@x.ru', uid: 1, folder: 'INBOX' }]);
check('нет ключа отправителя → пропускаем', apiMock.receiptCalls.length === 0);

// 2b. Своё письмо → пропускаем
// Ключ СЕБЕ есть — иначе письмо отсеклось бы фильтром «нет ключа», и гвард
// «своё письмо» ничего не проверял бы.
await sendDeliveredReceipts(makeWorld({ peerKeys: { 'a@x.ru': 'PUB', 'me@x.ru': 'MYPUB' } }).deps,
  [{ from: 'me@x.ru', uid: 2, folder: 'INBOX' }]);
check('своё письмо → пропускаем', apiMock.receiptCalls.length === 0);

// 3. Настоящее vault-письмо → квитанция отправляется
_kv.clear(); apiMock.receiptCalls.length = 0;
ctx = makeWorld();
await sendDeliveredReceipts(ctx.deps, [{ from: 'a@x.ru', uid: 10, folder: 'INBOX' }]);
check('vault-письмо → sendReadReceipt вызван', apiMock.receiptCalls.length === 1);
check('квитанция содержит msg_ids', JSON.parse(apiMock.receiptCalls[0][1].replace('ENC:', '')).msg_ids.length === 1);
check('delivered-sent записан в kv', _kv.has('delivered-sent'));

// 4. Дедуп: уже отправленная квитанция не повторяется
apiMock.receiptCalls.length = 0;
await sendDeliveredReceipts(makeWorld().deps, [{ from: 'a@x.ru', uid: 10, folder: 'INBOX' }]);
check('дедуп: повторная квитанция НЕ отправлена', apiMock.receiptCalls.length === 0);

// 5. Не vault-письмо (нет env.id) → пропускаем
apiMock.receiptCalls.length = 0;
const ctx5 = makeWorld({ peerKeys: { 'b@x.ru': 'PUB' } });
cryptoMock.decryptVault = async () => JSON.stringify({ vault: 1, text: 't' }); // нет id
await sendDeliveredReceipts(ctx5.deps, [{ from: 'b@x.ru', uid: 20, folder: 'INBOX' }]);
check('не vault-письмо (нет env.id) → пропускаем', apiMock.receiptCalls.length === 0);

// 6. Ошибка расшифровки → пропускаем
cryptoMock.decryptVault = async (body) => { const u = body.replace('ENC:', ''); if (u === 'bad') throw new Error('fail'); return JSON.stringify({ id: 'm', vault: 1, text: 't' }); };
await sendDeliveredReceipts(makeWorld().deps, [{ from: 'a@x.ru', uid: 'bad', folder: 'INBOX' }]);
check('ошибка расшифровки → пропускаем', apiMock.receiptCalls.length === 0);

// 7. Cap 500: создаём 501 запись, после вызова остаётся 500
_kv.clear(); apiMock.receiptCalls.length = 0;
const bigMap = {};
for (let i = 0; i < 501; i++) bigMap['old-' + i] = i;
_kv.set('delivered-sent', JSON.stringify(bigMap));
cryptoMock.decryptVault = async (body) => JSON.stringify({ id: 'msg-' + body.replace('ENC:', ''), vault: 1, text: 't' });
await sendDeliveredReceipts(makeWorld().deps, [{ from: 'a@x.ru', uid: 99, folder: 'INBOX' }]);
// kvSet в модуле fire-and-forget (.catch) — ждём, пока промисс выполнится.
await new Promise(r => setTimeout(r, 200));
const after = JSON.parse(_kv.get('delivered-sent'));
check('cap 500: после вызова записей = 500', Object.keys(after).length === 500, Object.keys(after).length);

// 8. Тип квитанки — delivered (не read/прочее)
_kv.clear(); apiMock.receiptCalls.length = 0;
await sendDeliveredReceipts(makeWorld().deps, [{ from: 'a@x.ru', uid: 30, folder: 'INBOX' }]);
const ackBody = apiMock.receiptCalls.length
  ? JSON.parse(apiMock.receiptCalls[0][1].replace('ENC:', '')) : {};
check('квитанка типа delivered с msg_ids',
  ackBody.delivered === 1 && Array.isArray(ackBody.msg_ids) && ackBody.msg_ids.length === 1, ackBody);

// 9. Падение SMTP → метка снимается, чтобы квитанция ПОВТОРИЛАСЬ позже
_kv.clear(); apiMock.receiptCalls.length = 0;
const origSend = apiMock.sendReadReceipt;
apiMock.sendReadReceipt = async () => { throw new Error('SMTP down'); };
await sendDeliveredReceipts(makeWorld().deps, [{ from: 'a@x.ru', uid: 40, folder: 'INBOX' }]);
apiMock.sendReadReceipt = origSend;
await new Promise((r) => setTimeout(r, 50));
const sentMap = JSON.parse(_kv.get('delivered-sent') || '{}');
check('при падении SMTP метка снята (квитанция повторится позже)',
  !Object.values(sentMap).some((v) => v === undefined) && !('msg-40' in sentMap), sentMap);

// ── Квитанции «прочитано» (ADR-005 W3, партия 12) ─────────────────────
// Антидубль: метка «уже отправлено» пишется ДО отправки — иначе при
// медленном SMTP поллинг успевает отправить вторую копию.
console.log('\nКвитанции «прочитано» (sendReadReceiptsFlow)');
{
  const calls = [];
  const sentReads = {};
  const deps = (over = {}) => ({
    activeChatType: () => 'chat',
    currentGroup: () => null,
    activeChat: () => 'peer@x.ru',
    peerKeys: () => ({ 'peer@x.ru': 'PK' }),
    peerPqKeys: () => ({}),
    groupKeys: () => ({}),
    loadSentReads: () => ({ ...sentReads }),
    saveSentReads: (v) => { calls.push(['save', JSON.stringify(v)]); Object.assign(sentReads, v); },
    encryptWithGroupKey: async (p, k) => 'GENC:' + k,
    setPeerPublicKey: () => {},
    encryptVault: async (p) => 'ENC:' + p,
    sendGroupRead: async (id, c) => { calls.push(['groupRead', id, c]); },
    sendReadReceipt: async (email, c) => { calls.push(['readReceipt', email, c]); },
    onError: (e) => calls.push(['error', e.message]),
    ...over,
  });
  calls.length = 0;
  await R.sendReadReceiptsFlow(deps(), ['m1', 'm2']);
  check('квитанция 1:1 отправлена', calls.some((c) => c[0] === 'readReceipt' && c[1] === 'peer@x.ru'), calls);
  check('квитанция 1:1: payload с msg_ids',
    calls.some((c) => c[0] === 'readReceipt' && String(c[2]).includes('m1')), calls);
  await new Promise((r) => setTimeout(r, 30));
  check('метка «отправлено» записана (антидубль)',
    JSON.stringify(sentReads).includes('m1'), sentReads);

  // Повтор тех же id — второй квитанции НЕ уходит.
  calls.length = 0;
  await R.sendReadReceiptsFlow(deps(), ['m1']);
  await new Promise((r) => setTimeout(r, 30));
  check('повтор тех же id не отправляет квитанцию снова',
    !calls.some((c) => c[0] === 'readReceipt'), calls);

  // Пустой список — ничего.
  calls.length = 0;
  await R.sendReadReceiptsFlow(deps(), []);
  check('пустой список → ничего не отправлено', calls.length === 0, calls);

  // Группа: квитанция шифруется ключом ГРУППЫ.
  calls.length = 0;
  await R.sendReadReceiptsFlow(deps({
    activeChatType: () => 'group',
    currentGroup: () => ({ id: 'g1' }),
    groupKeys: () => ({ g1: 'GK' }),
  }), ['gm1']);
  await new Promise((r) => setTimeout(r, 30));
  check('квитанция группы: ключ группы использован',
    calls.some((c) => c[0] === 'groupRead' && c[1] === 'g1' && c[2] === 'GENC:GK'), calls);

  // Без ключа группы — квитанция не уходит (но метка уже записана).
  calls.length = 0;
  await R.sendReadReceiptsFlow(deps({
    activeChatType: () => 'group',
    currentGroup: () => ({ id: 'g2' }),
    groupKeys: () => ({}),
  }), ['gm2']);
  await new Promise((r) => setTimeout(r, 30));
  check('без ключа группы квитанция не уходит', !calls.some((c) => c[0] === 'groupRead'), calls);

  // Отказ SMTP — метка снимается, квитанция повторится позже.
  calls.length = 0;
  await R.sendReadReceiptsFlow(deps({
    sendReadReceipt: async () => { throw new Error('SMTP down'); },
  }), ['m3']);
  await new Promise((r) => setTimeout(r, 30));
  check('при падении SMTP метка снята (квитанция повторится)',
    !JSON.stringify(sentReads).includes('m3'), sentReads);
  check('ошибка залогирована', calls.some((c) => c[0] === 'error'), calls);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
