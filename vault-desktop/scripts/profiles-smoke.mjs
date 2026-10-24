// Node-смоук features/profiles.js — семантика профилей/алиасов/presence
// без Vue/Tauri (паттерн incoming-smoke.mjs). Image/canvas — моки.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = import.meta.dirname;

// ── Заглушки ───────────────────────────────────────────────────
const MOCKS = '/tmp/profiles-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const apiMock = {
  sends: [],
  saveProfileCalls: [],
  getProfilesAll: async () => apiMock.profilesStore,
  profilesStore: {},
  sendReadReceipt: async (peer, content) => { apiMock.sends.push({ peer, content }); },
  saveProfile: async (email, name, avatar, ts) => { apiMock.saveProfileCalls.push({ email, name, avatar, ts }); },
  setAvatar: async (email, avatar) => { apiMock.saveProfileCalls.push({ setAvatar: email, avatar }); },
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

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock; export const accountNamespace = (email) => globalThis.__accountNamespaceMock(email);');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
// Адаптер идентичности мокан ТОЛЬКО мостом: правило «это я?» живёт в Rust
// (`contacts_drop_own`, тест `groups::tests::…`), здесь проверяется, что
// broadcastProfile его ВООБЩЕ спрашивает и не шлёт себе (живые данные, 24.10).
writeFileSync(MOCKS + '/identity.js', `
export const accountNamespace = async (email) => globalThis.__accountNamespaceMock(email);
export const dropOwnEntries = async (list, email) => globalThis.__dropOwnMock(list, email);
export const peerContactFor = async (address, keys) => ({
  address: String(address || '').trim().toLowerCase(),
  key: (keys || {})[address] || (keys || {})[String(address || '').trim().toLowerCase()] || '',
});
export const addressVariants = async (address) => [String(address || '').trim().toLowerCase()];
`);
globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;
globalThis.__accountNamespaceMock = (email) => String(email || '').trim().toLowerCase();
globalThis.__cryptoMock = cryptoMock;
// Эмуляция ответа ядра: убираем свой адрес и записи с НАШИМ ключом.
globalThis.__dropOwnMock = (list, email) => {
  globalThis.__dropCalls = (globalThis.__dropCalls || 0) + 1;
  const mine = String(email || '').toLowerCase();
  const own = globalThis.__cryptoMock.publicKey || '';
  return list.filter(e => String(e.email || '').toLowerCase() !== mine
    && !(e.public_key && own && String(e.public_key).toLowerCase() === own.toLowerCase()));
};

prepareModuleCopy(
  ROOT + '/../src/features/profiles.js',
  MOCKS + '/features-profiles.mjs',
  {
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../identity.js': 'identity.js',
  },
  MOCKS,
);
// ADR-005 W2 (партия 8): модуль берёт владельца контактов (contacts-store) →
// тот тянет contacts-load → api.js, а api.js на уровне модуля создаёт
// ApiClient, которому нужен localStorage. Ставим заглушку ДО импорта копии —
// иначе копия падает на ReferenceError ещё до первого утверждения.
globalThis.localStorage ||= {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; },
};
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
// ADR-005 W2 (партия 8): состояние — у владельцев. Копия модуля импортирует
// РЕАЛЬНЫЕ session-store/contacts-store/identity-store, поэтому смоук берёт
// те же синглтоны — иначе проверял бы не тот объект.
const { uiStore, sessionStore } = await import(ROOT + '/../src/features/session-store.js');
const { contactsStore } = await import(ROOT + '/../src/features/contacts-store.js');
const { identityStore } = await import(ROOT + '/../src/features/identity-store.js');

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

// Стенд UI-flow: состояние раскладывается по владельцам, а модуль получает
// три узких доступа (deps) к картам профилей.
function makeWorld(over = {}) {
  const w = Object.assign({
    email: 'me@x.ru',
    profiles: {},
    localProfiles: {},
    peerKeys: {},
    peerPqKeys: {},
    contacts: [],
    contactCardEmail: '', showContactCard: false,
    editingContact: null, editContactName: '', editContactAvatar: '', showContactEdit: false,
  }, over);
  identityStore.state.peerKeys = w.peerKeys;
  identityStore.state.peerPqKeys = w.peerPqKeys;
  contactsStore.state.contacts = w.contacts;
  sessionStore.setCurrentEmail(w.email);
  uiStore.setFormField('contactCardEmail', w.contactCardEmail);
  uiStore.setFormField('editingContact', w.editingContact);
  uiStore.setFormField('editContactName', w.editContactName);
  uiStore.setFormField('editContactAvatar', w.editContactAvatar);
  uiStore.setModal('showContactCard', w.showContactCard);
  uiStore.setModal('showContactEdit', w.showContactEdit);
  const deps = {
    getProfiles: () => w.profiles,
    setProfiles: (v) => { w.profiles = v; },
    getLocalProfiles: () => w.localProfiles,
  };
  return { w, deps };
}

// ── 1. Резолв: nameOf/avatarOf/aliasesOf ───────────────────────
console.log('1. Резолв имён/аватаров');
{
  // алиасы: один ключ → несколько адресов
  const ctx = makeCtx({
    peerKeys: { 'a@x.ru': 'K1', 'A2@x.ru': 'K1', 'b@x.ru': 'K2' },
    profiles: { 'a@x.ru': { name: 'Анна', avatar: 'AVA' }, 'b@x.ru': { name: 'b@x.ru' } },
  });
  check('aliasesOf: ключ → все адреса', P.aliasesOf(ctx.peerKeys, 'a@x.ru').sort().join(',') === 'a2@x.ru,a@x.ru');
  check('aliasesOf без ключа → [email lowercase]', P.aliasesOf(ctx.peerKeys, 'zzz@X.ru').join(',') === 'zzz@x.ru');
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
  check('profileOf/localProfileOf', P.profileOf(ctx4.profiles, 'a@x.ru').name === 'Wire' && P.localProfileOf(ctx4.localProfiles, 'a@x.ru').name === 'Локально');
}

// ── 2. Хранилище: localProfiles/bio ────────────────────────────
console.log('2. Хранилище (kv)');
{
  dbMock.kv.clear();
  // loadProfiles
  apiMock.profilesStore = { 'a@x.ru': { name: 'A' } };
  const ctx = makeCtx();
  await P.loadProfiles({ setProfiles: (v) => { ctx.profiles = v; } });
  check('loadProfiles из api', ctx.profiles['a@x.ru'].name === 'A');
  // сбой api → пустой объект
  const orig = apiMock.getProfilesAll;
  apiMock.getProfilesAll = async () => { throw new Error('db'); };
  const ctx2 = makeCtx({ profiles: { stale: 1 } });
  await P.loadProfiles({ setProfiles: (v) => { ctx2.profiles = v; } });
  check('сбой loadProfiles → {}', Object.keys(ctx2.profiles).length === 0);
  apiMock.getProfilesAll = orig;
  // loadLocalProfiles: kv → состояние
  dbMock.kv.set('local-profiles', JSON.stringify({ 'a@x.ru': { name: 'L1' } }));
  const ctx3 = makeCtx();
  await P.loadLocalProfiles({ email: ctx3.email, setLocalProfiles: (v) => { ctx3.localProfiles = v; } });
  check('loadLocalProfiles: kv → localProfiles', ctx3.localProfiles['a@x.ru'].name === 'L1');
  // saveLocalProfiles
  const ctx4 = makeCtx({ localProfiles: { 'b@x.ru': { name: 'B' } } });
  await P.saveLocalProfiles({ email: ctx4.email, localProfiles: ctx4.localProfiles });
  check('saveLocalProfiles: → kv', JSON.parse(dbMock.kv.get('local-profiles'))['b@x.ru'].name === 'B');
  // bio
  const ctx5 = makeCtx();
  check('getBio пустой', (await P.getBio({ email: ctx5.email })) === '');
  ctx5.myBio = await P.setBio({ email: ctx5.email, text: 'Мой статус' });
  check('setBio: kv + возврат, слайс 200', dbMock.kv.get('bio') === 'Мой статус' && ctx5.myBio === 'Мой статус');
  await P.setBio({ email: ctx5.email, text: 'x'.repeat(300) });
  check('setBio: обрезка 200', (await P.getBio({ email: ctx5.email })).length === 200);
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
  // Свой аккаунт в peer_keys (алиас своей сессии лежит там же, где чужие
  // ключи) — рассылателю письмо не уходит: без этого профиль писал сам себе.
  apiMock.sends.length = 0;
  globalThis.__dropCalls = 0;
  const selfCtx = makeCtx({
    peerKeys: { 'a@x.ru': 'KA', 'me@x.ru': 'MY_PUB', 'me@ya.ru': 'my_pub' },
    profiles: {},
  });
  await P.broadcastProfile(selfCtx);
  check('broadcast спросил ядро «это я?»', globalThis.__dropCalls === 1, globalThis.__dropCalls);
  check('себе (адрес или тот же ключ в другом регистре) не шлём',
    apiMock.sends.length === 1 && apiMock.sends[0].peer === 'a@x.ru', apiMock.sends);
  // без пиров — no-op
  apiMock.sends.length = 0;
  await P.broadcastProfile(makeCtx());
  check('без пиров — no-op', apiMock.sends.length === 0);
  // onProfileSave: тост даже при ошибке
  toasts.length = 0;
  const origSend = apiMock.sendReadReceipt;
  apiMock.sendReadReceipt = async () => { throw new Error('SMTP'); };
  const psCtx = makeCtx({ peerKeys: { 'a@x.ru': 'K' } });
  await P.onProfileSave({ showToast: psCtx.showToast, t: psCtx.t, broadcastProfile: () => P.broadcastProfile(psCtx) });
  check('onProfileSave: тост даже при SMTP-фейле (тихо)', toasts.length === 1);
  apiMock.sendReadReceipt = origSend;
  // onBioSave
  toasts.length = 0;
  const bctx = makeCtx();
  await P.onBioSave({ email: bctx.email, showToast: bctx.showToast, t: bctx.t }, 'Новый статус');
  check('onBioSave: тост + kv persisted', toasts.length === 1 && dbMock.kv.get('bio') === 'Новый статус');
}

// ── 4. UI-flow: карточка/правка ────────────────────────────────
console.log('4. UI-flow (карточка/правка)');
{
  const { w: ctx, deps } = makeWorld({
    contacts: [{ email: 'a@x.ru', name: 'Wire' }],
    localProfiles: {},
  });
  // openContactCard: refresh profiles + флаги
  apiMock.profilesStore = { 'a@x.ru': { name: 'A' } };
  // Сначала no-op: он открывает СВОЙ стенд (makeWorld сбрасывает UI-состояние
  // владельца — синглона), иначе последующие шаги увидят пустую карточку.
  check('openContactCard: notes/пусто — no-op',
    (await P.openContactCard(makeWorld().deps, '__notes__'),
     await P.openContactCard(makeWorld().deps, ''), true));
  await P.openContactCard(deps, 'a@x.ru');
  check('openContactCard: profiles обновлены + показ',
    uiStore.getModal('showContactCard') === true
    && uiStore.getFormField('contactCardEmail') === 'a@x.ru' && ctx.profiles['a@x.ru']);
  // startEditFromCard
  ctx.localProfiles['a@x.ru'] = { name: 'Лок', avatar: 'AV' };
  P.startEditFromCard(deps);
  check('startEditFromCard: карточка закрыта, правка открыта с локальными',
    uiStore.getModal('showContactCard') === false && uiStore.getModal('showContactEdit') === true
    && uiStore.getFormField('editContactName') === 'Лок'
    && uiStore.getFormField('editContactAvatar') === 'AV');
  // openContactEdit без локального
  const w2 = makeWorld();
  P.openContactEdit(w2.deps, 'b@x.ru');
  check('openContactEdit: пустые поля без локального',
    uiStore.getFormField('editContactName') === '' && uiStore.getFormField('editContactAvatar') === '');
  // saveContactEdit: имя+аватар.
  // КОГО редактируем — берётся ИЗ openContactEdit (иначе смоук задавал
  // editingContact заранее и не проверял, что правка вообще помнит адрес).
  const w3 = makeWorld({ contacts: [{ email: 'a@x.ru', name: 'Wire' }], localProfiles: { 'a@x.ru': { name: 'Лок', avatar: 'AV' } } });
  P.openContactEdit(w3.deps, 'a@x.ru');
  uiStore.setFormField('editContactName', '  Моё имя  ');
  P.saveContactEdit(w3.deps);
  check('saveContactEdit: trim + localProfiles + контакт переименован',
    w3.w.localProfiles['a@x.ru'].name === 'Моё имя' && w3.w.contacts[0].name === 'Моё имя'
    && uiStore.getModal('showContactEdit') === false);
  await new Promise(r => setTimeout(r, 5));
  check('saveContactEdit: персист kv', JSON.parse(dbMock.kv.get('local-profiles'))['a@x.ru'].name === 'Моё имя');
  // saveContactEdit: пусто = сброс
  const w4 = makeWorld({ localProfiles: { 'a@x.ru': { name: 'X' } }, contacts: [{ email: 'a@x.ru', name: 'X' }], profiles: { 'a@x.ru': { name: 'Real' } }, editingContact: 'a@x.ru', editContactName: '', editContactAvatar: '' });
  P.saveContactEdit(w4.deps);
  check('saveContactEdit пусто → сброс на реальное имя', !w4.w.localProfiles['a@x.ru'] && w4.w.contacts[0].name === 'Real');
  // resetContactEdit
  const w5 = makeWorld({ localProfiles: { 'a@x.ru': { name: 'X' } }, contacts: [{ email: 'a@x.ru', name: 'X' }], profiles: { 'a@x.ru': { name: 'Real' } }, editingContact: 'a@x.ru' });
  P.resetContactEdit(w5.deps);
  check('resetContactEdit: удаление локального + возврат имени',
    !w5.w.localProfiles['a@x.ru'] && w5.w.contacts[0].name === 'Real'
    && uiStore.getModal('showContactEdit') === false);
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
  // ADR-005 W3 (партия 4): noteSeen/isRecentlySeen — чистые (возвращают значение).
  // Контракт deps: карта «видели» у владельца контактов → геттер/сеттер.
  let map = {};
  const seenDeps = (get, set) => ({ lastSeenMap: () => get(), setLastSeenMap: (v) => set(v) });
  const seen = (m, e, ts) => P.noteSeen(seenDeps(() => m, (v) => { m = v; }), e, ts);
  map = seen(map, 'a@x.ru', 1000);
  check('noteSeen: фиксирует ts', map['a@x.ru'] === 1000);
  map = seen(map, 'a@x.ru', 500); // старее — не откатывает
  check('noteSeen: старый ts не откатывает', map['a@x.ru'] === 1000);
  map = seen(map, 'no-at-sign', 9999);
  check('noteSeen: не-email — игнор', map['no-at-sign'] === undefined);
  let map2 = seen({}, 'b@x.ru');
  check('noteSeen: без ts → Date.now', typeof map2['b@x.ru'] === 'number' && Math.abs(Date.now() - map2['b@x.ru']) < 5000);
  // isRecentlySeen
  const fresh = { 'a@x.ru': Date.now() - 60 * 1000 };
  const stale = { 'a@x.ru': Date.now() - 11 * 60 * 1000 };
  check('isRecentlySeen: 1 мин назад → true', P.isRecentlySeen(fresh, 'a@x.ru') === true);
  check('isRecentlySeen: 11 мин назад → false (окно 10 мин)', P.isRecentlySeen(stale, 'a@x.ru') === false);
  check('isRecentlySeen: нет записи → false', P.isRecentlySeen({}, 'zz@x.ru') === false);
}

// ── ADR-005 W3 (партия 8): свой профиль — аватар, имя, био ──────────────
console.log('Свой профиль: аватар, имя, био');
{
  const st = { alerts: [], uploaded: false, displayName: '', myBio: null, userAvatarUrl: '' };
  const profiles = {};
  const deps = {
    email: () => 'me@x.ru',
    displayName: () => st.displayName || 'me@x.ru',
    setDisplayName: (v) => { st.displayName = v; },
    profiles: () => profiles,
    setUserAvatarUrl: (v) => { st.userAvatarUrl = v; },
    setShowAvatarUpload: (v) => { st.uploaded = !v; },
    setMyBio: (v) => { st.myBio = v; },
    alert: (m) => { st.alerts.push(m); },
  };

  // 1. setMyBio: kv + состояние
  await P.setMyBio(deps, 'Мой статус');
  check('setMyBio: значение в kv', dbMock.kv.get('bio') === 'Мой статус', dbMock.kv.get('bio'));
  check('setMyBio: состояние обновлено', st.myBio === 'Мой статус', st.myBio);

  // 2. onAvatarUpdate: аватар в профиле + saveProfile
  await P.onAvatarUpdate(deps, 'data:image/png;base64,AAA');
  check('onAvatarUpdate: аватар в профиле', profiles['me@x.ru'].avatar === 'data:image/png;base64,AAA', profiles['me@x.ru']);
  check('onAvatarUpdate: аватар в состоянии', st.userAvatarUrl === 'data:image/png;base64,AAA');
  check('onAvatarUpdate: профиль сохранён', (apiMock.saveProfileCalls || []).length === 1, apiMock.saveProfileCalls);

  // 3. onNameUpdate: имя, без рассылки
  await P.onNameUpdate(deps, 'Моё имя');
  check('onNameUpdate: имя обновлено', st.displayName === 'Моё имя', st.displayName);
  check('onNameUpdate: письмо НЕ отправлено', (apiMock.saveProfileCalls || []).length === 1, apiMock.saveProfileCalls);

  // 4. onNameUpdate: пустое имя → адрес
  await P.onNameUpdate(deps, '');
  check('onNameUpdate: пустое имя → email', st.displayName === 'me@x.ru', st.displayName);

  // 5. onAvatarFileSelect: большой файл — отказ
  const big = { size: 3 * 1024 * 1024 };
  P.onAvatarFileSelect(deps, { target: { files: [big] } });
  check('onAvatarFileSelect: большой файл → отказ', st.alerts.length === 1, st.alerts);

  // 6. onAvatarFileSelect: нормальный файл → dataURL → профиль + закрытие
  const uploaded = [];
  const prevFileReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL() {
      this.onload({ target: { result: 'data:image/png;base64,BBB' } });
    }
  };
  P.onAvatarFileSelect(deps, { target: { files: [{ size: 100 }] } });
  globalThis.FileReader = prevFileReader;
  check('onAvatarFileSelect: аватар в состоянии', st.userAvatarUrl === 'data:image/png;base64,BBB', st.userAvatarUrl);
  check('onAvatarFileSelect: аватар в профиле', profiles['me@x.ru'].avatar === 'data:image/png;base64,BBB', profiles['me@x.ru']);
  check('onAvatarFileSelect: окно загрузки закрыто', st.uploaded === true, st.uploaded);
  check('onAvatarFileSelect: аватар записан в kv (setAvatar)',
    (apiMock.saveProfileCalls || []).some((c) => c.setAvatar === 'me@x.ru'), apiMock.saveProfileCalls);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
