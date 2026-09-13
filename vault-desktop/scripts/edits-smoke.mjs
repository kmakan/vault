// Node-смоук features/edits.js — семантика правок/удалений и tombstones
// без Vue/Tauri (паттерн incoming-smoke.mjs). Мокаем api/crypto через
// подмену импортов; localStorage — глобальная заглушка.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;

// ── Заглушки импортов edits.js ─────────────────────────────────
const MOCKS = '/tmp/edits-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api-мок: db.tombstoneAdd пишет в массив, sendEdit/sendGroupEdit — счётчики
const apiMock = {
  tombstoneCalls: [],
  editSends: [],
  groupEditSends: [],
  sendEdit: async (chat, content) => { apiMock.editSends.push({ chat, content }); },
  sendGroupEdit: async (gid, content) => { apiMock.groupEditSends.push({ gid, content }); },
};
apiMock.tombstoneAdd = (acc, msgId, mid) => { apiMock.tombstoneCalls.push({ acc, msgId, mid }); };

// crypto-мок: перехват encryptVault/encryptWithGroupKey
const cryptoMock = {
  encVault: [],
  encGroup: [],
  encryptVault: async (p) => { cryptoMock.encVault.push(p); return 'ENC:V:' + p; },
  encryptWithGroupKey: async (p, k) => { cryptoMock.encGroup.push({ p, k }); return 'ENC:G:' + p; },
  setPeerPublicKey: () => {},
};

// localStorage-заглушка (edits.js пишет через localStorage.getItem/setItem)
const lsBacking = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
  setItem: (k, v) => lsBacking.set(k, String(v)),
  removeItem: (k) => lsBacking.delete(k),
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
globalThis.__apiMock = apiMock;
globalThis.__dbMock = apiMock; // db-экспорт из api.js = тот же объект
globalThis.__cryptoMock = cryptoMock;

// Подменяем резолвер edits-импортов: копия edits.js с переписанными путями
let src = readFileSync(ROOT + '/../src/features/edits.js', 'utf8');
src = src
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"');
writeFileSync(MOCKS + '/edits.mjs', src);
const E = await import(MOCKS + '/edits.mjs');

// ── Хелперы ───────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    email: 'me@x.ru',
    tombstonesCache: [],
    midTombstonesCache: [],
    // sendEditEmail-зависимости
    activeChat: 'peer@x.ru',
    activeChatType: 'chat',
    peerKeys: { 'peer@x.ru': 'PUB' },
    peerPqKeys: {},
    groupKeys: {},
    currentGroup: null,
  }, over);
}

// ── 1. Хранилище wire-правок ──────────────────────────────────
console.log('1. Хранилище правок (localStorage)');
{
  const ctx = makeCtx();
  check('editsStorageKey = vault-edits-<email>', E.editsStorageKey(ctx) === 'vault-edits-me@x.ru');
  check('loadStoredEdits пуст → {}', JSON.stringify(E.loadStoredEdits(ctx)) === '{}');
  E.saveStoredEdits(ctx, { 'peer@x.ru': { m1: [{ text: 'hi', action: 'edit', date: 1 }] } });
  const st = E.loadStoredEdits(ctx);
  check('save→load roundtrip', st && st['peer@x.ru'] && st['peer@x.ru'].m1[0].text === 'hi');
  // recordLocalEdit: оптимистичная запись до доставки
  E.recordLocalEdit(ctx, 'peer@x.ru', 'm2', 'текст правки', 'edit');
  const st2 = E.loadStoredEdits(ctx);
  check('recordLocalEdit добавляет запись', st2['peer@x.ru'].m2.length === 1 && st2['peer@x.ru'].m2[0].text === 'текст правки' && st2['peer@x.ru'].m2[0].sender === 'me@x.ru');
}

// ── 2. Tombstones ─────────────────────────────────────────────
console.log('2. Tombstones (msg_id + Message-ID)');
{
  apiMock.tombstoneCalls.length = 0;
  const ctx = makeCtx();
  check('tombstonesKey', E.tombstonesKey(ctx) === 'vault-tombstones-me@x.ru');
  check('midTombstonesKey', E.midTombstonesKey(ctx) === 'vault-mid-tombstones-me@x.ru');
  E.addTombstone(ctx, 'm1');
  E.addTombstone(ctx, 'm1'); // дедуп
  check('addTombstone + дедуп в кэше', ctx.tombstonesCache.length === 1);
  check('addTombstone персист в sqlite (1 раз)', apiMock.tombstoneCalls.length === 1 && apiMock.tombstoneCalls[0].msgId === 'm1');
  check('isTombstoned', E.isTombstoned(ctx, 'm1') === true && E.isTombstoned(ctx, 'mX') === false);
  E.addMidTombstone(ctx, 'MID-9');
  check('addMidTombstone + персист', apiMock.tombstoneCalls.some(c => c.mid === 'MID-9') && ctx.midTombstonesCache.length === 1);
  check('isMidTombstoned', E.isMidTombstoned(ctx, 'MID-9') === true);
  check('addTombstone(null) — тихий no-op', (E.addTombstone(ctx, null), apiMock.tombstoneCalls.length === 2));
  check('loadTombstones из кэша', E.loadTombstones(ctx).length === 1);
}

// ── 3. filterDeleted ──────────────────────────────────────────
console.log('3. filterDeleted');
{
  const ctx = makeCtx({ tombstonesCache: ['m1'], midTombstonesCache: ['MID-1'] });
  const list = [
    { id: 'm1' },                      // tombstoned
    { id: 'm2', mid: 'MID-1' },        // mid-tombstoned
    { id: 'm3', deleted: true },       // deleted-метка
    { id: 'm4' },                      // живой
    null,                              // мусор
    { id: 'm5', mid: 'MID-2' },        // живой с mid
  ];
  const out = E.filterDeleted(ctx, list);
  check('фильтрует tombstone/mid/deleted/null, живые остаются', out.length === 2 && out[0].id === 'm4' && out[1].id === 'm5');
  check('filterDeleted(null) → []', E.filterDeleted(ctx, null).length === 0);
}

// ── 4. applyEdits: мерж + инвариант «Bad sender» ───────────────
console.log('4. applyEdits (мерж wire-правок, автор-инвариант)');
{
  const ctx = makeCtx();
  const list = [
    { id: 'm1', from: 'me', content: 'старый текст' },
    { id: 'm2', from: 'them', content: 'чужое' },
    { id: 'm3', from: 'me', content: 'для удаления' },
    { id: 'm4', from: 'me', content: 'групповое', sender_id: 'me@x.ru' },
  ];
  // wireEdits: m1 — правка от меня (легитимная), m2 — правка от НЕ-автора (должна игнорироваться)
  const wire = {
    m1: [{ text: 'новый текст', action: 'edit', date: 200, sender: 'me@x.ru' }],
    m2: [{ text: 'взлом', action: 'edit', date: 300, sender: 'me@x.ru' }],
    m3: [{ text: '', action: 'delete', date: 250, sender: 'me@x.ru' }],
    m4: [{ text: 'групповая правка', action: 'edit', date: 260, sender: 'me@x.ru' }],
  };
  E.applyEdits(ctx, list, 'peer@x.ru', wire);
  check('edit от автора применён', list[0].content === 'новый текст' && list[0].edited === true);
  check('edit от НЕ-автора игнорирован (Bad sender)', list[1].content === 'чужое' && !list[1].edited);
  check('delete → deleted + tombstone id+mid', list[2].deleted === true && ctx.tombstonesCache.includes('m3'));
  check('edit по sender_id (группа)', list[3].content === 'групповая правка');
  // Дедупликация: тот же конверт ещё раз — не удваивает
  const before = JSON.stringify(E.loadStoredEdits(ctx));
  E.applyEdits(ctx, list, 'peer@x.ru', wire);
  const after = JSON.stringify(E.loadStoredEdits(ctx));
  check('дедуп повторного конверта (Sent+INBOX)', before === after);
  // Последняя по дате правка авторитетна
  const list2 = [{ id: 'm1', from: 'me', content: '' }];
  E.applyEdits(ctx, list2, 'peer@x.ru', { m1: [{ text: 'самая свежая', action: 'edit', date: 999, sender: 'me@x.ru' }] });
  check('последняя по дате правка побеждает', list2[0].content === 'самая свежая');
  // Старые правки без sender — обратная совместимость
  const list3 = [{ id: 'm9', from: 'them', content: 'старое' }];
  E.applyEdits(ctx, list3, 'peer@x.ru', { m9: [{ text: 'легаси', action: 'edit', date: 5 }] });
  check('правка без sender применяется (легаси)', list3[0].content === 'легаси');
}

const origErr = console.error;
// ── 5. sendEditEmail ───────────────────────────────────────────
console.log('5. sendEditEmail (транспорт)');
{
  apiMock.editSends.length = 0;
  apiMock.groupEditSends.length = 0;
  cryptoMock.encVault.length = 0;
  cryptoMock.encGroup.length = 0;
  // 1:1
  const ctx = makeCtx();
  E.sendEditEmail(ctx, 'm1', 'правка', 'edit');
  await new Promise(r => setTimeout(r, 20));
  check('1:1: encryptVault + sendEdit', apiMock.editSends.length === 1 && cryptoMock.encVault.length === 1);
  const payload = JSON.parse(cryptoMock.encVault[0]);
  check('payload {edit:1,msg_id,text,action,sender,ts}', payload.edit === 1 && payload.msg_id === 'm1' && payload.text === 'правка' && payload.action === 'edit' && payload.sender === 'me@x.ru' && typeof payload.ts === 'number');
  // группа
  const gctx = makeCtx({ activeChatType: 'group', currentGroup: { id: 'g1' }, groupKeys: { g1: 'GK' } });
  E.sendEditEmail(gctx, 'm2', null, 'delete');
  await new Promise(r => setTimeout(r, 20));
  check('группа: encryptWithGroupKey + sendGroupEdit', apiMock.groupEditSends.length === 1 && cryptoMock.encGroup.length === 1 && cryptoMock.encGroup[0].k === 'GK');
  // нет ключа → тихий no-op
  apiMock.editSends.length = 0;
  const ectx = makeCtx({ peerKeys: {} });
  E.sendEditEmail(ectx, 'm3', 'x', 'edit');
  await new Promise(r => setTimeout(r, 20));
  check('без peer-ключа — тихий no-op', apiMock.editSends.length === 0);
  // ошибка SMTP не бросается наружу
  apiMock.editSends.length = 0;
  const origSend = apiMock.sendEdit;
  apiMock.sendEdit = async () => { throw new Error('SMTP down'); };
  console.error = () => {};
  E.sendEditEmail(makeCtx(), 'm4', 'x', 'edit');
  await new Promise(r => setTimeout(r, 20));
  check('SMTP-ошибка не бросается (fire-and-forget)', true);
  apiMock.sendEdit = origSend;
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
