// Node-смоук features/profiles.js — семантика профилей/алиасов/presence
// без Vue/Tauri (паттерн incoming-smoke.mjs). Image/canvas — моки.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;

// ── Заглушки ───────────────────────────────────────────────────
const MOCKS = '/tmp/profiles-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  sends: [],
  getProfilesAll: async () => apiMock.profilesStore,
  profilesStore: {},
  sendReadReceipt: async (peer, content) => { apiMock.sends.push({ peer, content }); },
};
const dbMock = {
  kv: new Map(),
  kvGet: async (acc, k) => (dbMock.kv.has(k) ? dbMock.kv.get(k) : null),
  kvSet: async (acc, k, v) => { dbMock.kv.set(k, v); },
};
const cryptoMock = {
  publicKey: 'MY_PUB',
  encVault: [],
  setPeerKeys: [],
  setPeerPublicKey: (pk, pq) => { cryptoMock.setPeerKeys.push(pk); },
  encryptVault: async (p) => { cryptoMock.encVault.push(p); return 'ENC:' + p.length; },
};

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__cryptoMock = cryptoMock;

let src = readFileSync(ROOT + '/../src/features/profiles.js', 'utf8');
src = src
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"');
writeFileSync(MOCKS + '/features-profiles.mjs', src);
const P = await import(MOCKS + '/features-profiles.mjs');

// ── Image/canvas-моки ──────────────────────────────────────────
let imgDecodeFail = false;
const imgCallbacks = [];
globalThis.Image = class {
  constructor() { this.width = 1000; this.height = 500; }
  set src(v) {
    if (imgDecodeFail) { setTimeout(() => this.onerror && this.onerror(new Error('decode fail')), 0); return; }
    setTimeout(() => this.onload && this.onload(), 0);
  }
};
const toDataURLResult = { value: 'data:image/jpeg;SMALL', len: 20 };
globalThis.document = {
  createElement: (tag) => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => toDataURLResult.value,
  }),
};

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    email: 'me@x.ru',
    displayName: 'Максим',
    profiles: {},
    localProfiles: {},
    peerKeys: {},
    peerPqKeys: {},
    contacts: [],
    myBio: '',
    lastSeenMap: {},
    // UI-флаги
    contactCardEmail: null, showContactCard: false,
    editingContact: null, editContactName: '', editContactAvatar: '', showContactEdit: false,
    // контракты
    showToast: (m) => { toasts.push(m); },
    t: (k) => 'T:' + k,
  }, over);
}
const toasts = [];

// ── 1. Резолв: nameOf/avatarOf/aliasesOf ───────────────────────
console.log('1. Резолв имён/аватаров');
{
  // алиасы: один ключ → несколько адресов
  const ctx = makeCtx({
    peerKeys: { 'a@x.ru': 'K1', 'A2@x.ru': 'K1', 'b@x.ru': 'K2' },
    profiles: { 'a@x.ru': { name: 'Анна', avatar: 'AVA' }, 'b@x.ru': { name: 'b@x.ru' } },
  });
  check('aliasesOf: ключ → все адреса', P.aliasesOf(ctx, 'a@x.ru').sort().join(',') === 'a2@x.ru,a@x.ru');
  check('aliasesOf без ключа → [email lowercase]', P.aliasesOf(ctx, 'zzz@X.ru').join(',') === 'zzz@x.ru');
  check('nameOf: wire-профиль', P.nameOf(ctx, 'a@x.ru') === 'Анна');
  check('nameOf: name==email — НЕ имя → email', P.nameOf(ctx, 'b@x.ru') === 'b@x.ru');
  // регистронезависимость
  const ctx2 = makeCtx({ profiles: { 'anna@x.ru': { name: 'Анна' } } });
  check('nameOf: регистр ключа неважен', P.nameOf(ctx2, 'Anna@X.ru') === 'Анна');
  // смена почты: профиль под старым адресом
  const ctx3 = makeCtx({
    peerKeys: { 'new@x.ru': 'K1', 'old@x.ru': 'K1' },
    profiles: { 'old@x.ru': { name: 'Старое имя', avatar: 'OLD_AVA' } },
  });
  check('nameOf: алиас (смена почты) даёт имя', P.nameOf(ctx3, 'new@x.ru') === 'Старое имя');
  check('avatarOf: алиас даёт аватар', P.avatarOf(ctx3, 'new@x.ru') === 'OLD_AVA');
  // локальное переопределение — высший приоритет
  const ctx4 = makeCtx({
    profiles: { 'a@x.ru': { name: 'Wire', avatar: 'W' } },
    localProfiles: { 'a@x.ru': { name: 'Локально', avatar: 'L' } },
  });
  check('nameOf: локальное переопределение побеждает', P.nameOf(ctx4, 'a@x.ru') === 'Локально');
  check('avatarOf: локальное побеждает', P.avatarOf(ctx4, 'a@x.ru') === 'L');
  // fallback
  check('nameOf: нет нигде → email', P.nameOf(makeCtx(), 'nope@x.ru') === 'nope@x.ru');
  check('avatarOf: нет нигде → null', P.avatarOf(makeCtx(), 'nope@x.ru') === null);
  check('profileOf/localProfileOf', P.profileOf(ctx4, 'a@x.ru').name === 'Wire' && P.localProfileOf(ctx4, 'a@x.ru').name === 'Локально');
}

// ── 2. Хранилище: localProfiles/bio ────────────────────────────
console.log('2. Хранилище (kv)');
{
  dbMock.kv.clear();
  // loadProfiles
  apiMock.profilesStore = { 'a@x.ru': { name: 'A' } };
  const ctx = makeCtx();
  await P.loadProfiles(ctx);
  check('loadProfiles из api', ctx.profiles['a@x.ru'].name === 'A');
  // сбой api → пустой объект
  const orig = apiMock.getProfilesAll;
  apiMock.getProfilesAll = async () => { throw new Error('db'); };
  const ctx2 = makeCtx({ profiles: { stale: 1 } });
  await P.loadProfiles(ctx2);
  check('сбой loadProfiles → {}', Object.keys(ctx2.profiles).length === 0);
  apiMock.getProfilesAll = orig;
  // loadLocalProfiles: kv → состояние
  dbMock.kv.set('local-profiles', JSON.stringify({ 'a@x.ru': { name: 'L1' } }));
  const ctx3 = makeCtx();
  P.loadLocalProfiles(ctx3);
  await new Promise(r => setTimeout(r, 5));
  check('loadLocalProfiles: kv → localProfiles', ctx3.localProfiles['a@x.ru'].name === 'L1');
  // saveLocalProfiles
  const ctx4 = makeCtx({ localProfiles: { 'b@x.ru': { name: 'B' } } });
  P.saveLocalProfiles(ctx4);
  await new Promise(r => setTimeout(r, 5));
  check('saveLocalProfiles: → kv', JSON.parse(dbMock.kv.get('local-profiles'))['b@x.ru'].name === 'B');
  // bio
  const ctx5 = makeCtx();
  check('getBio пустой', (await P.getBio(ctx5)) === '');
  await P.setBio(ctx5, 'Мой статус');
  check('setBio: kv + myBio, слайс 200', dbMock.kv.get('bio') === 'Мой статус' && ctx5.myBio === 'Мой статус');
  await P.setBio(ctx5, 'x'.repeat(300));
  check('setBio: обрезка 200', (await P.getBio(ctx5)).length === 200);
}

// ── 3. broadcastProfile ────────────────────────────────────────
console.log('3. broadcastProfile (wire)');
{
  apiMock.sends.length = 0;
  cryptoMock.encVault.length = 0;
  cryptoMock.setPeerKeys.length = 0;
  dbMock.kv.set('bio', 'Статус из kv');
  const ctx = makeCtx({
    peerKeys: { 'a@x.ru': 'KA', 'b@x.ru': 'KB' },
    profiles: { 'me@x.ru': { avatar: 'STALE_AVA' } },
  });
  dbMock.kv.set('profiles', JSON.stringify({ 'me@x.ru': { avatar: 'FRESH_AVA' } }));
  await P.broadcastProfile(ctx);
  check('по письму каждому пиру (2)', apiMock.sends.length === 2 && apiMock.sends.map(s => s.peer).sort().join(',') === 'a@x.ru,b@x.ru');
  check('ключ пира ставится перед шифровкой (2 раза)', cryptoMock.setPeerKeys.length === 2);
  const body = JSON.parse(cryptoMock.encVault[0]);
  check('конверт: vault:1+type:profile+name+avatar+bio+key+ts',
    body.vault === 1 && body.type === 'profile' && body.name === 'Максим' && body.avatar === 'FRESH_AVA' && body.bio === 'Статус из kv' && body.key === 'MY_PUB' && typeof body.ts === 'number');
  check('аватар из kv в приоритете (гонка profiles)', body.avatar === 'FRESH_AVA');
  // без пиров — no-op
  apiMock.sends.length = 0;
  await P.broadcastProfile(makeCtx());
  check('без пиров — no-op', apiMock.sends.length === 0);
  // onProfileSave: тост даже при ошибке
  toasts.length = 0;
  const origSend = apiMock.sendReadReceipt;
  apiMock.sendReadReceipt = async () => { throw new Error('SMTP'); };
  await P.onProfileSave(makeCtx({ peerKeys: { 'a@x.ru': 'K' } }));
  check('onProfileSave: тост даже при SMTP-фейле (тихо)', toasts.length === 1);
  apiMock.sendReadReceipt = origSend;
  // onBioSave
  toasts.length = 0;
  const bctx = makeCtx();
  await P.onBioSave(bctx, 'Новый статус');
  check('onBioSave: setBio + тост', bctx.myBio === 'Новый статус' && toasts.length === 1);
}

// ── 4. UI-flow: карточка/правка ────────────────────────────────
console.log('4. UI-flow (карточка/правка)');
{
  const ctx = makeCtx({
    contacts: [{ email: 'a@x.ru', name: 'Wire' }],
    localProfiles: {},
  });
  // openContactCard: refresh profiles + флаги
  apiMock.profilesStore = { 'a@x.ru': { name: 'A' } };
  await P.openContactCard(ctx, 'a@x.ru');
  check('openContactCard: profiles обновлены + показ', ctx.showContactCard === true && ctx.contactCardEmail === 'a@x.ru' && ctx.profiles['a@x.ru']);
  check('openContactCard: notes/пусто — no-op', (await P.openContactCard(makeCtx(), '__notes__'), await P.openContactCard(makeCtx(), ''), true));
  // startEditFromCard
  ctx.localProfiles['a@x.ru'] = { name: 'Лок', avatar: 'AV' };
  P.startEditFromCard(ctx);
  check('startEditFromCard: карточка закрыта, правка открыта с локальными', ctx.showContactCard === false && ctx.showContactEdit === true && ctx.editContactName === 'Лок' && ctx.editContactAvatar === 'AV');
  // openContactEdit без локального
  const ctx2 = makeCtx();
  P.openContactEdit(ctx2, 'b@x.ru');
  check('openContactEdit: пустые поля без локального', ctx2.editContactName === '' && ctx2.editContactAvatar === '');
  // saveContactEdit: имя+аватар
  const ctx3 = makeCtx({ contacts: [{ email: 'a@x.ru', name: 'Wire' }], editingContact: 'a@x.ru', editContactName: '  Моё имя  ', editContactAvatar: 'AV' });
  P.saveContactEdit(ctx3);
  check('saveContactEdit: trim + localProfiles + контакт переименован', ctx3.localProfiles['a@x.ru'].name === 'Моё имя' && ctx3.contacts[0].name === 'Моё имя' && ctx3.showContactEdit === false);
  await new Promise(r => setTimeout(r, 5));
  check('saveContactEdit: персист kv', JSON.parse(dbMock.kv.get('local-profiles'))['a@x.ru'].name === 'Моё имя');
  // saveContactEdit: пусто = сброс
  const ctx4 = makeCtx({ localProfiles: { 'a@x.ru': { name: 'X' } }, contacts: [{ email: 'a@x.ru', name: 'X' }], profiles: { 'a@x.ru': { name: 'Real' } }, editingContact: 'a@x.ru', editContactName: '', editContactAvatar: '' });
  P.saveContactEdit(ctx4);
  check('saveContactEdit пусто → сброс на реальное имя', !ctx4.localProfiles['a@x.ru'] && ctx4.contacts[0].name === 'Real');
  // resetContactEdit
  const ctx5 = makeCtx({ localProfiles: { 'a@x.ru': { name: 'X' } }, contacts: [{ email: 'a@x.ru', name: 'X' }], profiles: { 'a@x.ru': { name: 'Real' } }, editingContact: 'a@x.ru' });
  P.resetContactEdit(ctx5);
  check('resetContactEdit: удаление локального + возврат имени', !ctx5.localProfiles['a@x.ru'] && ctx5.contacts[0].name === 'Real' && ctx5.showContactEdit === false);
}

// ── 5. Картинки ────────────────────────────────────────────────
console.log('5. shrinkAvatar/compressImage');
{
  // shrinkAvatar: маленький — как есть
  check('shrinkAvatar: ≤8192 символов — без изменений', (await P.shrinkAvatar('short')) === 'short');
  check('shrinkAvatar: пусто → пусто', (await P.shrinkAvatar('')) === '');
  // большой: canvas-мок вернёт маленький dataURL
  const big = 'data:image/png;base64,' + 'x'.repeat(20000);
  const small = await P.shrinkAvatar(big);
  check('shrinkAvatar: сжатие 64×64 JPEG (меньше оригинала)', small === 'data:image/jpeg;SMALL');
  // сжатие не помогло (результат больше) → оригинал
  toDataURLResult.value = 'data:image/jpeg;' + 'y'.repeat(30000);
  const big2 = 'data:image/png;base64,' + 'x'.repeat(20000);
  check('shrinkAvatar: сжатие хуже → оригинал', (await P.shrinkAvatar(big2)) === big2);
  toDataURLResult.value = 'data:image/jpeg;SMALL';
  // canvas недоступен → оригинал
  imgDecodeFail = true;
  check('shrinkAvatar: decode fail → оригинал', (await P.shrinkAvatar(big)) === big);
  imgDecodeFail = false;
  // compressImage: маленькая картинка → null (не нужно)
  globalThis.Image = class { constructor() { this.width = 100; this.height = 50; } set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
  check('compressImage: ≤ maxSide → null', (await P.compressImage('data:...', 128, 0.8)) === null);
  // большая → dataURL
  globalThis.Image = class { constructor() { this.width = 1000; this.height = 500; } set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
  check('compressImage: > maxSide → JPEG dataURL', (await P.compressImage('data:...', 128, 0.8)) === 'data:image/jpeg;SMALL');
  // decode fail → reject (класс с imgDecodeFail-гейтом)
  globalThis.Image = class { constructor() { this.width = 1000; this.height = 500; } set src(v) { if (imgDecodeFail) { setTimeout(() => this.onerror && this.onerror(new Error('decode fail')), 0); return; } setTimeout(() => this.onload && this.onload(), 0); } };
  imgDecodeFail = true;
  let rejected = false;
  try { await P.compressImage('data:...', 128, 0.8); } catch (e) { rejected = true; }
  check('compressImage: decode fail → reject', rejected);
  imgDecodeFail = false;
}

// ── 6. Presence ────────────────────────────────────────────────
console.log('6. Зелёная точка');
{
  const ctx = makeCtx();
  P.noteSeen(ctx, 'a@x.ru', 1000);
  check('noteSeen: фиксирует ts', ctx.lastSeenMap['a@x.ru'] === 1000);
  P.noteSeen(ctx, 'a@x.ru', 500); // старее — не откатывает
  check('noteSeen: старый ts не откатывает', ctx.lastSeenMap['a@x.ru'] === 1000);
  P.noteSeen(ctx, 'no-at-sign', 9999);
  check('noteSeen: не-email — игнор', ctx.lastSeenMap['no-at-sign'] === undefined);
  const nctx = makeCtx({ lastSeenMap: {} });
  P.noteSeen(nctx, 'b@x.ru');
  check('noteSeen: без ts → Date.now', typeof nctx.lastSeenMap['b@x.ru'] === 'number' && Math.abs(Date.now() - nctx.lastSeenMap['b@x.ru']) < 5000);
  // isRecentlySeen
  const fresh = makeCtx({ lastSeenMap: { 'a@x.ru': Date.now() - 60 * 1000 } });
  const stale = makeCtx({ lastSeenMap: { 'a@x.ru': Date.now() - 11 * 60 * 1000 } });
  check('isRecentlySeen: 1 мин назад → true', P.isRecentlySeen(fresh, 'a@x.ru') === true);
  check('isRecentlySeen: 11 мин назад → false (окно 10 мин)', P.isRecentlySeen(stale, 'a@x.ru') === false);
  check('isRecentlySeen: нет записи → false', P.isRecentlySeen(makeCtx(), 'zz@x.ru') === false);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
