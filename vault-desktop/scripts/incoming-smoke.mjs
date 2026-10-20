// Node-смоук features/incoming.js — ХВОСТ роутера: дедуп, уведомления,
// свежесть, mute/visible, баунс, пул, порядок батча, ренейм, группа.
//
// РАЗДЕЛЕНИЕ С `incoming-routing-smoke` (kind → эффект). Там Rust-классификатор
// подменён и проверяется «какой kind → какой эффект». Здесь наоборот: тип
// задан смоуком, а проверяется то, что НИЖЕ маршрутизации —
//   · дедуп: uid|folder, mid:Message-ID, env:envId (кросс-канальный);
//   · разделение дедупа СЧЁТЧИКА и дедупа УВЕДОМЛЕНИЯ (инвариант 2fa9103:
//     тихий поллинг не должен съедать push монитора);
//   · окно свежести, mute, видимый чат;
//   · пул писем за прогон (MAX_POOL) и ХРОНОЛОГИЧЕСКИЙ разбор батча
//     (UID как число) — отсюда гонка call_request/call_cancel;
//   · путь «смена почты» (fingerprint-матчинг) и путь группы.
//
// Модуль копируется в /tmp с подменёнными импортами (общий хелпер
// prepareModuleCopy) — тестируется НАСТОЯЩИЙ роутер, а не его пересказ.
// Мост Rust (`@tauri-apps/api/core`) замокан: классификатор отдаёт заданный
// смоуком kind, персист — фиксируется вызовом.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ ВОЗРОДИЛСЯ. До W1 (19.10) роутер сам решал «что это за
// письмо» в JS и читал состояние из компонента. W1 перенёс решение в Rust
// (`vault_classify_incoming`) и перевёл модуль на явный контракт deps. Смоук
// остался на старом API: он звал `processIncoming(ctx, …, deps)` (четыре
// аргумента), ждал, что тип разберёт JS, и подменял только 5 импортов —
// `@tauri-apps/api/core` в копии остался настоящим, и копия падала при загрузке
// с ERR_MODULE_NOT_FOUND. Смоук не был подключён к сборке — поломку никто не
// видел (класс «смоук вне приёмки», см. journal 17.10).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/incoming-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Мост Rust ──────────────────────────────────────────────────────────────
// Классификатор: kind задаёт смоук (стенд). Персист: фиксируем вызов.
globalThis.__invoke = async (cmd, args) => {
  const st = globalThis.__state;
  st.bridgeCalls.push({ cmd, args });
  if (st.bridgeDown) throw new Error('мост недоступен (тест)');
  if (cmd === 'vault_classify_incoming') {
    const input = (args && args.input) || {};
    return st.classify(input.decrypted, input.from);
  }
  return null;
};

// ── Моки внешних модулей ───────────────────────────────────────────────────
const apiMock = {
  calls: [],
  bodies: {},
  fetchBodiesDbFirst: async (folder, uids) => {
    const out = {};
    for (const uid of uids) {
      const b = apiMock.bodies[folder + ':' + uid];
      if (b !== undefined) out[String(uid)] = b;
    }
    return out;
  },
  saveProfile: (...a) => { apiMock.calls.push(['saveProfile', ...a]); },
  identityLetterFresh: async () => true,
  renamePeerIdentity: async (a, b) => { apiMock.calls.push(['renamePeerIdentity', a, b]); },
  bumpIdentityRenameTs: async (k, ts) => { apiMock.calls.push(['bumpIdentityRenameTs', k, ts]); },
  removeContact: (e) => { apiMock.calls.push(['removeContact', e]); },
  deleteProfile: (e) => { apiMock.calls.push(['deleteProfile', e]); },
  getMyGroupKey: async () => null,
};
const cryptoMock = {
  publicKey: 'MY_PUB',
  isEncrypted: (s) => typeof s === 'string' && s.startsWith('ENC:'),
  setPeerPublicKey: (key) => { cryptoMock.currentKey = key; },
  removePeerKey: async (e) => { apiMock.calls.push(['removePeerKey', e]); },
  // Расшифровка с ключом, который поставил setPeerPublicKey. Если смоук задал
  // `plainForKey`, расшифровка идёт только этим ключом — иначе цикл
  // fingerprint-матчинга нашёл бы «чужое» письмо первым попавшим ключом.
  decryptVault: async (body) => {
    const st = globalThis.__state;
    if (st.plainForKey && cryptoMock.currentKey !== st.plainForKey) {
      throw new Error('не этим ключом');
    }
    // plainFromBody: тело САМО является конвертом (без шифртекста) — так
    // удобно для call-сигналов: роутер сам разбирает пришедший JSON.
    if (st.plainFromBody) return String(body).replace(/^ENC:/, '');
    if (st.plainForBody) return st.plainForBody(body);
    return st.plain;
  },
  decryptWithGroupKey: async () => globalThis.__state.groupPlain,
};
const relayMock = {
  getSettings: async () => ({ relays: [], active: 0, peers: {} }),
  fingerprintOf: async () => null,
  setPeerToken: async () => {},
};
const notifyMock = { fires: [] };
notifyMock.notifyNewMessage = (n) => { notifyMock.fires.push(n); };

writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);\n');
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;\n');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;\n');
writeFileSync(MOCKS + '/relay-client.js', [
  'const relay = globalThis.__relayMock;',
  'export default relay;',
  'export const getSettings = (...a) => relay.getSettings(...a);',
  'export const fingerprintOf = (...a) => relay.fingerprintOf(...a);',
  'export const setPeerToken = (...a) => relay.setPeerToken(...a);',
  '',
].join('\n'));
writeFileSync(MOCKS + '/notify.js', 'export const notifyNewMessage = (n) => globalThis.__notifyMock.notifyNewMessage(n);\n');
writeFileSync(MOCKS + '/session-store.js', 'export const uiStore = { tr: (k) => k };\n');
writeFileSync(MOCKS + '/identity-store.js', 'export const identityStore = { removePeerKey: (e) => globalThis.__state.removedPeerKeys.push(e) };\n');
writeFileSync(MOCKS + '/presence.js', [
  'export const noteHeartbeat = (...a) => globalThis.__state.heartbeats.push(a);',
  // Маршрутизатор после W1 НЕ решает, что это presence: тип приходит из Rust.
  'export const ingestSignal = () => { throw new Error("маршрутизатор не должен решать, что это presence"); };',
  '',
].join('\n'));

globalThis.__apiMock = apiMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__relayMock = relayMock;
globalThis.__notifyMock = notifyMock;

// Баунс — НАСТОЯЩИЙ модуль (чистые функции, без внешних импортов).
const BounceFeature = await import(pathToFileURL(ROOT + '/src/features/bounce.js').href);

// ── Копия настоящего incoming.js с подменёнными импортами ─────────────────
// ВСЕ импорты роутера обязаны быть здесь: '@tauri-apps/api/core' — не
// исключение (до W1 его не было, и смоук падал на загрузке копии).
prepareModuleCopy(
  ROOT + '/src/features/incoming.js',
  MOCKS + '/incoming.mjs',
  {
    './session-store.js': 'session-store.js',
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../relay-client.js': 'relay-client.js',
    '../notify.js': 'notify.js',
    './presence.js': 'presence.js',
    './identity-store.js': 'identity-store.js',
    '@tauri-apps/api/core': 'core.js',
  },
  MOCKS,
);
const { processIncoming } = await import(pathToFileURL(MOCKS + '/incoming.mjs').href);

// ── Стенд ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Стенд на каждый сценарий: счётчики предыдущего не должны «доказывать» следующий.
function resetWorld(over = {}) {
  globalThis.__state = {
    bridgeCalls: [],
    bridgeDown: false,
    classify: () => ({ kind: 'message' }),
    plain: '',
    plainForKey: null,
    plainFromBody: false,
    plainForBody: null,
    groupPlain: null,
    unread: {},
    notifs: [],
    callSignals: [],
    heartbeats: [],
    healed: [],
    healedMsg: [],
    migratedGroups: [],
    migratedChain: [],
    setPeerKey: [],
    bounces: [],
    seen: [],
    removedPeerKeys: [],
    savedSeen: 0,
    savedCounts: 0,
    cached: [],
    ...over,
  };
  notifyMock.fires = [];
  apiMock.calls = [];
  apiMock.bodies = {};
  cryptoMock.currentKey = null;
}

// Контракт deps — ровно то, что собирает App.vue:processIncoming (ADR-005 R3).
function makeDeps(over = {}) {
  const st = globalThis.__state;
  const deps = {
    cryptoReady: true,
    email: 'me@x.ru',
    peerKeys: {},
    peerPqKeys: {},
    emailBodyCache: {},
    processedUnreadIds: new Set(),
    profiles: {},
    contactAliases: {},
    groupKeys: {},
    // Точная копия поведения message-format.senderEmail: адрес из «Имя <адрес>».
    // Упрощённый мок уводил кейсы в ветку «неизвестный адрес» — тест проходил
    // по чужой ветке и врал.
    senderEmail: (raw) => {
      const mm = String(raw || '').match(/<([^>]+)>/);
      return (mm ? mm[1] : String(raw || '')).trim().toLowerCase();
    },
    cacheBody: (k, v) => { st.cached.push([k, v]); },
    isIgnored: () => false,
    noteSeen: (e, ts) => { st.seen.push([e, ts]); },
    onMailBounce: async (r, why) => { st.bounces.push({ recipients: r, reason: why }); },
    handleCallSignal: async (sig, from) => { st.callSignals.push({ sig, from }); },
    canonicalOf: (x) => x,
    parseEnvelope: (plain) => {
      try {
        const o = JSON.parse(plain);
        return (o && o.vault === 1) ? o : null;
      } catch { return null; }
    },
    localProfileOf: () => null,
    nameOf: () => '',
    setPeerKey: (e, k, pq) => { st.setPeerKey.push([e, k, pq]); },
    migratePeerGroups: async (a, b) => { st.migratedGroups.push([a, b]); },
    migrateChatHistoryChain: async (a, b, c) => { st.migratedChain.push([a, b, c]); },
    tryMigrateGroupMember: async () => false,
    setGroupKey: (id, k) => { st.groupKeys[id] = k; },
    replyGroupAvatarHeal: async (id) => { st.healed.push(id); },
    healGroupAvatarFromMessage: async (id, av) => { st.healedMsg.push([id, av]); },
    saveUnreadSeen: async () => { st.savedSeen++; },
    saveUnreadCounts: async () => { st.savedCounts++; },
    chatVisible: () => false,
    isMuted: () => false,
    incUnread: (k) => { st.unread[k] = (st.unread[k] || 0) + 1; },
    // Геттеры: во время батча массив может быть переприсвоен (ренейм → loadGroups).
    channels: () => [],
    groups: () => [],
    // Баунс — настоящие чистые функции.
    isBounceMessage: BounceFeature.isBounceMessage,
    bounceRecipients: BounceFeature.bounceRecipients,
    bounceReason: BounceFeature.bounceReason,
    ingestChannelEnvelope: (obj) => (obj && obj.post ? 'post' : null),
  };
  return Object.assign(deps, over);
}

const NOW = Date.now();
// `from` в почтовом списке — СТРОКА («Имя <адрес>» или адрес), как её кладёт
// Rust-мост. Мок-объект {address: …} уводил роутер в ветку «[object Object]»
// — тест проходил по чужой ветке и врал.
function letter(over = {}) {
  return {
    uid: 1, folder: 'INBOX', from: 'peer@x.ru',
    message_id: '<m1@x>', date: new Date(NOW).toISOString(),
    ...over,
  };
}
// Письмо с телом в кэше: батч-догрузка тел не нужна, маршрутизация — сразу.
function withBody(deps, m, body) {
  deps.emailBodyCache[`${m.folder || 'INBOX'}:${m.uid}`] = body;
}

// ── 1. Пустой батч и своё письмо — полный no-op ───────────────────────────
console.log('1. пустой батч / своё письмо — ничего не случилось');
{
  resetWorld();
  const deps = makeDeps();
  await processIncoming(deps, [], { notify: true });
  await processIncoming(deps, [letter({ from: 'me@x.ru' })], { notify: true });
  check('нет бейджа, нет уведомления, дедуп пуст',
    Object.keys(globalThis.__state.unread).length === 0 && notifyMock.fires.length === 0
    && deps.processedUnreadIds.size === 0);
}

// ── 1b. Классификатор сказал «не наше» — письмо не трогаем ────────────────
// Решение «что это за письмо» принимает RUST (vault_classify_incoming).
// Если JS решает сам — письмо, которое Rust отверг, будет обработано.
console.log('1b. классификатор отверг письмо — не обрабатываем');
{
  resetWorld();
  const deps = makeDeps({ classify: () => null });
  const m = letter();
  withBody(deps, m, 'ENC:x');
  await processIncoming(deps, [m], { notify: true });
  check('отвергнутое письмо: ни бейджа, ни уведомления, ни дедупа',
    Object.keys(globalThis.__state.unread).length === 0 && notifyMock.fires.length === 0
    && deps.processedUnreadIds.size === 0, {
      unread: Object.keys(globalThis.__state.unread).length,
      notify: notifyMock.fires.length,
      dedup: deps.processedUnreadIds.size,
    });
}

// ── 2. Не-Vault письмо — пропуск ──────────────────────────────────────────
console.log('2. plain-письмо без Vault-шифртекста — пропуск');
{
  resetWorld();
  const deps = makeDeps();
  const m = letter();
  withBody(deps, m, 'plain text');
  await processIncoming(deps, [m], { notify: true });
  check('не считается и не уведомляется',
    Object.keys(globalThis.__state.unread).length === 0 && notifyMock.fires.length === 0);
}

// ── 3. Ignore-лист: ДО расшифровки, ДО дедупа ─────────────────────────────
console.log('3. ignore-лист: письмо остаётся «необработанным»');
{
  // Ключ пира ЕСТЬ: иначе письмо и без ignore-листа никуда не дойдёт
  // (нечего расшифровывать) — и проверка была бы беззубой: сломанный
  // ignore-лист прошёл бы незамеченным.
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'ig1', key: 'PEERK', text: 'x' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' }, isIgnored: () => true });
  const m = letter();
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  check('нет unread, нет notify, в дедуп НЕ записан',
    Object.keys(globalThis.__state.unread).length === 0 && notifyMock.fires.length === 0
    && deps.processedUnreadIds.size === 0, [...deps.processedUnreadIds]);
}

// ── 4. Новое сообщение: бейдж + уведомление + дедуп ───────────────────────
console.log('4. kind=message: бейдж +1, уведомление, дедуп по трём ключам');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'env9', key: 'PEERK', text: 'hello' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const m = letter();
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  const st = globalThis.__state;
  check('бейдж вырос', st.unread['peer@x.ru'] === 1, st.unread);
  check('уведомление одно, id = mid:Message-ID',
    notifyMock.fires.length === 1 && notifyMock.fires[0].id === 'mid:<m1@x>', notifyMock.fires);
  check('в дедуп занесены uid|folder, mid: и env:',
    deps.processedUnreadIds.has('1|INBOX') && deps.processedUnreadIds.has('mid:<m1@x>')
    && deps.processedUnreadIds.has('env:env9'), [...deps.processedUnreadIds]);
  check('персист в Rust MessageStore вызван',
    st.bridgeCalls.some(c => c.cmd === 'vault_store_incoming_message'));
}

// ── 5. Инвариант 2fa9103: дедуп счётчика ≠ дедуп уведомления ─────────────
console.log('5. тихий поллинг не съедает push монитора (регресс 2fa9103)');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'env9', key: 'PEERK', text: 'hello' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const m = letter();
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: false });   // тихий поллинг
  const unreadAfterPoll = globalThis.__state.unread['peer@x.ru'] || 0;
  await processIncoming(deps, [m], { notify: true });    // монитор принёс то же письмо
  check('счётчик не удвоился', globalThis.__state.unread['peer@x.ru'] === unreadAfterPoll,
    globalThis.__state.unread);
  check('но уведомление ПРОШЛО (уведомление дедупится отдельно)',
    notifyMock.fires.length === 1, notifyMock.fires);
}

// ── 6. Кросс-канальный дедуп: relay-копия + email-копия ───────────────────
console.log('6. один env.id в двух каналах — один бейдж');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'envX', key: 'PEERK', text: 'dup' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const relayCopy = letter({ uid: 'rl-1', message_id: '<r1@x>' });
  const mailCopy = letter({ uid: 99, message_id: '<e1@x>' });
  withBody(deps, relayCopy, 'ENC:1');
  withBody(deps, mailCopy, 'ENC:1');
  await processIncoming(deps, [relayCopy, mailCopy], { notify: true });
  check('бейдж один', globalThis.__state.unread['peer@x.ru'] === 1, globalThis.__state.unread);
}

// ── 7. Свежесть: старое письмо — бейдж есть, уведомления нет ─────────────
console.log('7. stale-письмо: счётчик растёт, уведомления нет');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'e10', key: 'PEERK', text: 'old' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const old = letter({ uid: 10, message_id: '<o@x>', date: new Date(NOW - 16 * 60 * 1000).toISOString() });
  withBody(deps, old, 'ENC:1');
  await processIncoming(deps, [old], { notify: true });
  check('бейдж +1', globalThis.__state.unread['peer@x.ru'] === 1, globalThis.__state.unread);
  check('уведомления нет (старше окна свежести)', notifyMock.fires.length === 0, notifyMock.fires);
}

// ── 8. Muted / видимый чат ────────────────────────────────────────────────
console.log('8. muted и видимый чат: уведомления нет');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'e11', key: 'PEERK', text: 'm' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' }, isMuted: () => true });
  const m = letter({ uid: 11, message_id: '<mu@x>' });
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  check('muted: бейдж есть, уведомления нет',
    globalThis.__state.unread['peer@x.ru'] === 1 && notifyMock.fires.length === 0, notifyMock.fires);
}
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'e12', key: 'PEERK', text: 'v' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' }, chatVisible: () => true });
  const m = letter({ uid: 12, message_id: '<vi@x>' });
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  check('видимый чат: ни бейджа, ни уведомления',
    globalThis.__state.unread['peer@x.ru'] === undefined && notifyMock.fires.length === 0,
    { unread: globalThis.__state.unread, notifs: notifyMock.fires.length });
}

// ── 9. Группа: chatKey = group:<id>, title = имя группы ──────────────────
console.log('9. группа: письмо считается по ключу группы');
{
  resetWorld({ plain: '', groupPlain: JSON.stringify({ vault: 1, id: 'ge1', key: 'GK', text: 'gm' }) });
  const deps = makeDeps({
    peerKeys: {},
    groups: () => [{ id: 'g1', name: 'Группа', members: [{ email: 'peer@x.ru' }] }],
    groupKeys: { g1: 'GK' },
  });
  const m = letter();
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  check('бейдж группы +1', globalThis.__state.unread['group:g1'] === 1, globalThis.__state.unread);
  check('уведомление: title = имя группы',
    notifyMock.fires.length === 1 && notifyMock.fires[0].title === 'Группа', notifyMock.fires);
}

// ── 10. Смена почты (fingerprint-матчинг) ──────────────────────────────────
console.log('10. смена почты: полный ренейм по цепочке алиасов');
{
  resetWorld({
    plain: JSON.stringify({ vault: 1, id: 'fe1', key: 'OLDK', text: 'moved' }),
    plainForKey: 'OLDK',
  });
  const aliases = { 'new@x.ru': ['mid@x.ru'], 'mid@x.ru': ['old@x.ru'] };
  const deps = makeDeps({
    peerKeys: { 'old@x.ru': 'OLDK' },
    contactAliases: aliases,
  });
  const m = letter({ from: 'new@x.ru', uid: 14, message_id: '<f@x>' });
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  const st = globalThis.__state;
  check('перенос истории вызван для ТЕКУЩЕГО адреса и получил карту алиасов',
    st.migratedChain.length === 1 && st.migratedChain[0][0] === 'new@x.ru'
    && st.migratedChain[0][2] === aliases, st.migratedChain);
  check('группы переименованы', st.migratedGroups.length === 1 && st.migratedGroups[0][1] === 'new@x.ru',
    st.migratedGroups);
  check('ключ привязан к новому адресу', st.setPeerKey.length === 1 && st.setPeerKey[0][0] === 'new@x.ru',
    st.setPeerKey);
  check('старый адрес убран из хранилищ',
    st.removedPeerKeys.includes('old@x.ru')
    && apiMock.calls.some(c => c[0] === 'removeContact' && c[1] === 'old@x.ru'), st.removedPeerKeys);
  check('письмо посчитано по новому адресу', st.unread['new@x.ru'] === 1, st.unread);
}

// ── 11. Эхо: письмо с моим ключом — seen, но не сообщение ─────────────────
console.log('11. эхо (свой ключ): помечено обработанным, но не считается');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'e1', key: 'MY_PUB', text: 'hi' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const m = letter({ uid: 15, message_id: '<ec@x>' });
  withBody(deps, m, 'ENC:1');
  await processIncoming(deps, [m], { notify: true });
  check('эхо в дедупе', deps.processedUnreadIds.has('15|INBOX'), [...deps.processedUnreadIds]);
  check('но нет бейджа и уведомления',
    globalThis.__state.unread['peer@x.ru'] === undefined && notifyMock.fires.length === 0);
}

// ── 12. Пул: за прогон обрабатывается не больше 50 писем ──────────────────
console.log('12. пул > 50: усечение до 50 за прогон');
{
  // У каждого письма СВОЙ env.id: иначе кросс-канальный дедуп (env:envId)
  // схлопнул бы все 70 писем в одно — и проверка считала бы не пул, а дедуп.
  resetWorld({
    plainForBody: (body) => JSON.stringify({
      vault: 1, id: 'env' + String(body).replace(/^ENC:/, ''), key: 'PEERK', text: 'm',
    }),
  });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const fetched = [];
  for (let i = 0; i < 70; i++) {
    const m = letter({ uid: 1000 + i, message_id: `<p${i}@x>` });
    withBody(deps, m, 'ENC:' + m.uid);
    fetched.push(m);
  }
  await processIncoming(deps, fetched, { notify: false });
  check('обработано ровно 50', globalThis.__state.unread['peer@x.ru'] === 50,
    globalThis.__state.unread);
}

// ── 13. Порядок батча: ХРОНОЛОГИЯ, а не «как вернул IMAP» ────────────────
console.log('13. гонка порядка: call_cancel (UID больше) разбирается ПОСЛЕ request');
{
  // Реальный сценарий: Rust отдаёт батч новыми сверху, поэтому cancel
  // (UID больше) приходит ПЕРВЫМ. Разбор по порядку доставки обязателен:
  // иначе terminal успевает записать call_id в 'call-seen' раньше, чем
  // request прочитает гвард, — и звонок гаснет без рингтона (t_674c770f).
  resetWorld({
    plainFromBody: true,
    classify: () => ({ kind: 'call' }),
  });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const order = [];
  deps.handleCallSignal = async (sig) => { order.push(sig.type); };
  const older = new Date(NOW - 20 * 1000).toISOString();
  const newer = new Date(NOW - 5 * 1000).toISOString();
  const req = letter({ uid: 101, message_id: '<req@x>', date: older });
  const can = letter({ uid: 102, message_id: '<can@x>', date: newer });
  withBody(deps, req, 'ENC:' + JSON.stringify({ type: 'call_request', call_id: 'cX' }));
  withBody(deps, can, 'ENC:' + JSON.stringify({ type: 'call_cancel', call_id: 'cX' }));
  await processIncoming(deps, [can, req], { notify: true }); // как вернул IMAP
  check('request разобран ПЕРВЫМ (звонок успел зазвонить)',
    order[0] === 'call_request' && order[1] === 'call_cancel', order);
}

// ── 14. UID сравнивается ЧИСЛОМ ───────────────────────────────────────────
console.log('14. сортировка батча: UID как число (\'9\' < \'10\')');
{
  resetWorld({ plainFromBody: true, classify: () => ({ kind: 'call' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const order = [];
  deps.handleCallSignal = async (sig) => { order.push(sig.uid); };
  const same = new Date(NOW).toISOString();
  const m9 = letter({ uid: 9, message_id: '<m9@x>', date: same });
  const m10 = letter({ uid: 10, message_id: '<m10@x>', date: same });
  withBody(deps, m9, 'ENC:' + JSON.stringify({ type: 'call_request', call_id: 'c9', uid: 9 }));
  withBody(deps, m10, 'ENC:' + JSON.stringify({ type: 'call_request', call_id: 'c10', uid: 10 }));
  await processIncoming(deps, [m10, m9], { notify: true });
  check('uid 9 разобран раньше uid 10 (строковая сортировка переставила бы)',
    order.length === 2 && order[0] === 9 && order[1] === 10, order);
}

// ── 15. Дедуп по env.id не ломается реордерингом ─────────────────────────
console.log('15. дедуп по env.id не зависит от порядка в батче');
{
  resetWorld({ plain: JSON.stringify({ vault: 1, id: 'envSame', key: 'PEERK', text: 'm' }) });
  const deps = makeDeps({ peerKeys: { 'peer@x.ru': 'PEERK' } });
  const a = letter({ uid: 201, message_id: '<a@x>', date: new Date(NOW - 60 * 1000).toISOString() });
  const b = letter({ uid: 202, message_id: '<b@x>', date: new Date(NOW - 10 * 1000).toISOString() });
  withBody(deps, a, 'ENC:1');
  withBody(deps, b, 'ENC:1');
  await processIncoming(deps, [b, a], { notify: true });
  check('один env.id учтён один раз', globalThis.__state.unread['peer@x.ru'] === 1,
    globalThis.__state.unread);
}

// ── 16. DSN / баунс: служебное письмо гасит звонок, а не «не наше» ───────
console.log('16. баунс (DSN): onMailBounce вызван, письмо НЕ сообщение');
{
  resetWorld();
  const deps = makeDeps();
  const dsn = [
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; peer@x.ru',
    'Action: failed',
    'Status: 5.7.1',
    'Diagnostic-Code: smtp; 554 5.7.1 Message rejected under suspicion of SPAM',
  ].join('\n');
  const m = letter({
    uid: 777, message_id: '<dsn@x>',
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery Status Notification (Failure)',
  });
  withBody(deps, m, dsn);
  await processIncoming(deps, [m], { notify: true });
  const b = globalThis.__state.bounces[0] || {};
  check('onMailBounce вызван 1 раз', globalThis.__state.bounces.length === 1, globalThis.__state.bounces);
  check('получатель распознан (peer@x.ru)', (b.recipients || []).includes('peer@x.ru'), b);
  check('причина = 554 5.7.1 SPAM', /554 5\.7\.1/.test(b.reason || ''), b);
  check('баунс не посчитан как сообщение',
    globalThis.__state.unread['mailer-daemon@googlemail.com'] === undefined && notifyMock.fires.length === 0);
}

// ── 17. Баунс по теме (не только по From) ─────────────────────────────────
console.log('17. баунс по теме от другого демона — тоже баунс');
{
  resetWorld();
  const deps = makeDeps();
  const m = letter({
    uid: 778, message_id: '<dsn2@x>',
    from: 'postmaster@ya.ru',
    subject: 'Undelivered Mail Returned to Sender',
  });
  withBody(deps, m, 'Reporting-MTA: dns\nTo: peer@x.ru\nStatus: 5.1.1');
  await processIncoming(deps, [m], { notify: true });
  check('баунс отдан в onMailBounce', globalThis.__state.bounces.length === 1, globalThis.__state.bounces);
  check('нет уведомления', notifyMock.fires.length === 0);
}

// ── 18. Звонок под незнакомым адресом (fp-namespace) ──────────────────────
console.log('18. звонок под новым адресом: сигнал уходит под ИЗВЕСТНЫЙ адрес');
{
  // Регресс 12.10.2026: десктоп публиковал конверты с from = fp:<…>.
  // У пира такого адреса в peerKeys нет → конверт уходил в ветку «смена
  // почты», где сигнал НЕ разбирался и молча терялся: звонок не доходил
  // вовсе. Теперь сигнал доходит до state machine — под известным адресом.
  resetWorld({
    plainFromBody: true,
    classify: () => ({ kind: 'call' }),
  });
  const deps = makeDeps({ peerKeys: { 'icemaksim@gmail.com': 'ANNAK' } });
  const got = [];
  deps.handleCallSignal = async (sig, from) => { got.push([sig.type, sig.call_id, from]); };
  const m = letter({
    from: 'fp:c7:3c:e5:5a:9f:7b:46:6f:xxxx',
    uid: 20, message_id: '<ns@x>',
  });
  withBody(deps, m, 'ENC:' + JSON.stringify({
    type: 'call_request', call_id: 'c-ns1', key: 'ANNAK',
  }));
  await processIncoming(deps, [m], { notify: true });
  check('сигнал звонка доставлен', got.length === 1 && got[0][0] === 'call_request', got);
  check('адрес — ИЗВЕСТНЫЙ адрес пира, не fp:',
    got.length === 1 && got[0][2] === 'icemaksim@gmail.com', got);
  check('звонок НЕ посчитан как сообщение',
    globalThis.__state.unread['fp:c7:3c:e5:5a:9f:7b:46:6f:xxxx'] === undefined);
}

// ── 19. Мост упал: письмо не считается и не помечается обработанным ──────
console.log('19. мост Rust упал: письмо повторится на следующем поллинге');
{
  resetWorld({
    bridgeDown: true,
    plain: JSON.stringify({ vault: 1, id: 'e19', key: 'PEERK', text: 'm' }),
  });
  // Канал настроен: «мост упал» ≠ «письмо не наше». При отказе моста письмо
  // не трогают ВООБЩЕ — ни в 1:1, ни в каналах, ни в группах. Если бы отказ
  // выглядел как «не наше» (null), роутер пошёл бы дальше по каналам и
  // группам и позвал классификатор ещё раз.
  const deps = makeDeps({
    peerKeys: { 'peer@x.ru': 'PEERK' },
    channels: () => [{ id: 'ch1', key: 'CHKEY', name: 'Chan' }],
  });
  const m = letter({ uid: 19, message_id: '<bd@x>' });
  withBody(deps, m, 'ENC:1');
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  try { await processIncoming(deps, [m], { notify: true }); } finally { console.error = orig; }
  const st = globalThis.__state;
  const classifyCalls = st.bridgeCalls.filter(c => c.cmd === 'vault_classify_incoming').length;
  check('бейдж НЕ вырос', st.unread['peer@x.ru'] === undefined, st.unread);
  check('в дедуп НЕ записано (письмо не потеряно)',
    deps.processedUnreadIds.size === 0, [...deps.processedUnreadIds]);
  check('классификатор позван ровно один раз (письмо не пошло дальше по путям)',
    classifyCalls === 1, classifyCalls);
  check('падение моста громкое (console.error), а не молча',
    seen.some(s => s.includes('Rust-классификатор недоступен')), seen);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
