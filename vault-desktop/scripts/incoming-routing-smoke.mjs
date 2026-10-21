// Маршрутизация входящих: тип письма решает Rust, JS исполняет эффекты (W1, ADR-005).
//
// ЗАЧЕМ. W1 убрал из `features/incoming.js` решение «что это за конверт» и
// заменил его вызовом `vault_classify_incoming`. Ошибка в таком обмене не видна
// ни сборке, ни `check-template`, ни смоукам других модулей: письмо просто
// не считается и не уведомляет (или, хуже, считается дважды). Проверять это
// живьём на телефоне — дорого и не воспроизводимо, поэтому здесь маршрутизатор
// запускается целиком, с подделанными мостами, и проверяются РЕШЕНИЯ:
//
//   kind=message   → письмо учтено (бейдж/уведомление) + персист в Rust;
//   kind=profile   → профиль сохранён, но НЕ сообщение (не бейдж);
//   kind=call      → ушло в state machine звонка, не в бейджи;
//   kind=presence  → только noteHeartbeat (точка «онлайн»);
//   kind=channel   → пост канала считается как сообщение канала;
//   kind=group-service (hav) → ответ на запрос аватарки группы;
//   kind=null      → письмо не наше (ничего не происходит);
//   мост упал      → НИЧЕГО не считается и не помечается обработанным,
//                    ошибка громкая (письмо повторится на следующем поллинге).
//
// Модуль не импортируется напрямую: он тянет Tauri-мост, api, crypto, relay.
// Как и в groups-load-smoke, копия исходника пишется в /tmp с подменёнными
// импортами — тестируется НАСТОЯЩИЙ код маршрутизатора, а не его пересказ.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/incoming-routing-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Мосты: всё, что маршрутизатор зовёт наружу ────────────────────────────
const calls = [];
globalThis.__calls = calls;
globalThis.__invoke = async (cmd, args) => {
  calls.push({ cmd, args });
  const st = globalThis.__state;
  if (st.bridgeDown) throw new Error('мост недоступен (тест)');
  if (cmd === 'vault_classify_incoming') return st.kind;
  return null;
};

writeFileSync(MOCKS + '/core.js',
  'export const invoke = (...a) => globalThis.__invoke(...a);\n');
writeFileSync(MOCKS + '/api.js', [
  'const api = {',
  '  saveProfile: (...a) => { globalThis.__state.savedProfiles.push(a); },',
  '  fetchBodiesDbFirst: async () => ({}),',
  '};',
  'export default api;',
  '',
].join('\n'));
writeFileSync(MOCKS + '/crypto.js', [
  'export default {',
  '  isEncrypted: () => globalThis.__state.encrypted !== false,',
  '  setPeerPublicKey: () => {},',
  '  decryptVault: async () => globalThis.__state.plain,',
  '  decryptWithGroupKey: async () => globalThis.__state.plain,',
  '  publicKey: "MYKEY",',
  '};',
  '',
].join('\n'));
writeFileSync(MOCKS + '/relay-client.js', [
  'export const getSettings = async () => ({ relays: [], active: 0, peers: {} });',
  'export const fingerprintOf = async () => null;',
  'export const setPeerToken = async () => {};',
  '',
].join('\n'));
writeFileSync(MOCKS + '/notify.js',
  'export const notifyNewMessage = (m) => globalThis.__state.notifs.push(m);\n');
writeFileSync(MOCKS + '/session-store.js',
  'export const uiStore = { tr: (k) => "T:" + k };\n');
writeFileSync(MOCKS + '/presence.js', [
  'export const noteHeartbeat = (...a) => globalThis.__state.heartbeats.push(a);',
  // ingestSignal оставлен: другие модули его ещё используют, но маршрутизатор
  // после W1 обязан звать noteHeartbeat (без повторного решения о типе).
  'export const ingestSignal = () => { throw new Error("маршрутизатор не должен решать, что это presence"); };',
  '',
].join('\n'));
writeFileSync(MOCKS + '/identity-store.js',
  'export const identityStore = { removePeerKey: () => {} };\n');

// ── Копия настоящего incoming.js с подменёнными импортами ─────────────────
const SRC = readFileSync(path.join(ROOT, 'src', 'features', 'incoming.js'), 'utf8');
const REWRITES = [
  ["'./session-store.js'", `"${MOCKS}/session-store.js"`],
  ['"./session-store.js"', `"${MOCKS}/session-store.js"`],
  ["'../api.js'", `"${MOCKS}/api.js"`],
  ["'../crypto.js'", `"${MOCKS}/crypto.js"`],
  ["'../relay-client.js'", `"${MOCKS}/relay-client.js"`],
  ["'../notify.js'", `"${MOCKS}/notify.js"`],
  ["'./presence.js'", `"${MOCKS}/presence.js"`],
  ["'./identity-store.js'", `"${MOCKS}/identity-store.js"`],
  ["'@tauri-apps/api/core'", `"${MOCKS}/core.js"`],
];
let patched = SRC;
for (const [from, to] of REWRITES) patched = patched.split(from).join(to);
// Ни один исходный импорт не должен остаться: иначе копия тянет настоящий
// Tauri-мост и тест падает не там, где сломан.
for (const [from] of REWRITES) {
  if (patched.includes(from)) die(`маршрутизатор не переписал импорт (${from}) — обнови моки смоука`);
}
const MODULE = MOCKS + '/incoming.mjs';
writeFileSync(MODULE, patched, 'utf8');

// ── Стенд ─────────────────────────────────────────────────────────────────
let failed = 0;
let checks = 0;
function die(msg) {
  console.log('✗ ' + msg);
  process.exit(1);
}
function ok(label, cond) {
  checks++;
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label); }
}

// Свежие зависимости: ровно то, что маршрутизатор читает на этих путях.
// Модуль после W1 не читает компонент как ctx — контракт явный (deps), поэтому
// и стенд собирает его явно: если маршрутизатор начнёт читать новое поле,
// которого нет в контракте, кейс упадёт, а не «просто не сработает».
function makeDeps(over = {}) {
  const st = globalThis.__state;
  return {
    cryptoReady: true,
    email: 'me@test.com',
    // Точная копия поведения message-format.senderEmail: адрес из «Имя <адрес>».
    // Первая версия мока просто lower()-ила строку, и все кейсы уходили в ветку
    // «неизвестный адрес» — тест «проходил» по чужой ветке (call) и врал в
    // остальных. Мок обязан повторять контракт, а не упрощать его.
    senderEmail: (raw) => {
      const mm = String(raw || '').match(/<([^>]+)>/);
      return (mm ? mm[1] : String(raw || '')).trim().toLowerCase();
    },
    emailBodyCache: {},
    cacheBody: () => {},
    isIgnored: () => false,
    peerKeys: {},
    peerPqKeys: {},
    parseEnvelope: (plain) => {
      try {
        const o = JSON.parse(plain);
        if (!o || o.vault !== 1 || typeof o.text !== 'string') return null;
        return { id: o.id || '', text: o.text, name: o.name || '', avatar: '', type: o.type || '', ts: o.ts || 0, key: o.key || '' };
      } catch { return null; }
    },
    handleCallSignal: async (sig, from) => { st.callSignals.push({ sig, from }); },
    // Разбор call-сигнала — в Rust (ADR-005 W4): двойник правил.
    parseCallSignal: async (plain) => (await import('./lib/wire-signal-mock.mjs')).callSignalParse(plain),
    canonicalOf: (x) => x,
    localProfileOf: () => null,
    nameOf: () => '',
    processedUnreadIds: new Set(),
    saveUnreadSeen: async () => {},
    saveUnreadCounts: async () => {},
    chatVisible: () => false,
    isMuted: () => false,
    incUnread: (k) => { st.unread[k] = (st.unread[k] || 0) + 1; },
    // Геттеры: во время батча массив может быть переприсвоен (ренейм → loadGroups).
    channels: () => [],
    groups: () => [],
    groupKeys: {},
    setGroupKey: () => {},
    tryMigrateGroupMember: async () => false,
    replyGroupAvatarHeal: async (id) => { st.healed.push(id); },
    healGroupAvatarFromMessage: async () => {},
    migratePeerGroups: async () => {},
    migrateChatHistoryChain: async () => {},
    contactAliases: {},
    profiles: {},
    setPeerKey: () => {},
    onMailBounce: async () => {},
    noteSeen: () => {},
    ...over,
  };
}

const DEPS = {
  // Каналы: мост связывает свой ctx сам (App.vue), модуль отдаёт только данные.
  ingestChannelEnvelope: (obj) => (obj && obj.post ? 'post' : null),
  isBounceMessage: () => false,
  bounceRecipients: () => [],
  bounceReason: () => '',
};

// Письмо с телом в кэше: батч-догрузка тел не нужна, маршрутизация — сразу.
function letter(over = {}) {
  return { from: 'Bob <bob@x>', uid: 1, folder: 'INBOX', date: new Date().toISOString(), subject: '', ...over };
}

const state = {
  kind: null,
  plain: '',
  encrypted: true,
  bridgeDown: false,
  unread: {},
  notifs: [],
  savedProfiles: [],
  callSignals: [],
  heartbeats: [],
  healed: [],
};
globalThis.__state = state;
const { processIncoming } = await import(pathToFileURL(MODULE).href);

async function run(name, { kind, plain, bridgeDown = false, ctxOver = {}, letterOver = {}, encrypted = true, expect }) {
  console.log('\n' + name);
  // Свежий стенд на каждый кейс: иначе счётчики предыдущего кейса «доказывают» следующий.
  state.kind = kind;
  state.plain = plain;
  state.encrypted = encrypted;
  state.bridgeDown = bridgeDown;
  state.unread = {};
  state.notifs = [];
  state.savedProfiles = [];
  state.callSignals = [];
  state.heartbeats = [];
  state.healed = [];
  calls.length = 0;
  const deps = { ...makeDeps(ctxOver), ...DEPS };
  for (const k of Object.keys(deps.emailBodyCache)) delete deps.emailBodyCache[k];
  deps.emailBodyCache['INBOX:1'] = 'encrypted-body';
  await processIncoming(deps, [letter(letterOver)], { notify: false });
  expect(deps);
}

const MSG = '{"vault":1,"id":"m1","text":"привет","name":"Bob","key":"BOBKEY"}';

// ── Отрицательные ветки роутера ───────────────────────────────────────────
// Без них смоук зелёный на сломанном роутере: успешный путь один, а ломать
// его — легко (мутационный гейт это и показал).
await run('cryptoReady=false — письма не разбираются вовсе', {
  kind: { kind: 'message', env_id: 'm1' },
  plain: MSG,
  ctxOver: { cryptoReady: false, peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('без криптографии бейдж не вырос', Object.keys(globalThis.__state.unread).length === 0);
    ok('без криптографии персист не вызван',
      !calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('своё письмо — не считается входящим', {
  kind: { kind: 'message', env_id: 'm1' },
  plain: MSG,
  letterOver: { from: 'me@test.com' },
  // Ключ для СВОЕГО адреса обязателен: иначе письмо отсеется на другом
  // основании (нет ключа пира) и проверка «своё письмо отброшено» прошла бы
  // даже при сломанном сравнении с myEmail.
  ctxOver: { peerKeys: { 'me@test.com': 'BOBKEY' } },
  expect: () => {
    ok('своё письмо не увеличивает бейдж', Object.keys(globalThis.__state.unread).length === 0);
    ok('своё письмо не пишется в персист',
      !calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('заблокированный отправитель — не считается входящим', {
  kind: { kind: 'message', env_id: 'm1' },
  plain: MSG,
  ctxOver: { isIgnored: () => true, peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('заблокированный отправитель не увеличивает бейдж', Object.keys(globalThis.__state.unread).length === 0);
    ok('заблокированный отправитель не пишется в персист',
      !calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('незашифрованное тело — не конверт', {
  kind: { kind: 'message', env_id: 'm1' },
  plain: MSG,
  encrypted: false,
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('незашифрованное тело не увеличивает бейдж', Object.keys(globalThis.__state.unread).length === 0);
    ok('незашифрованное тело не пишется в персист',
      !calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('нет ключа пира — письмо не декодируется (ждём ключ)', {
  kind: { kind: 'message', env_id: 'm1' },
  plain: MSG,
  ctxOver: { peerKeys: {} },
  expect: () => {
    ok('без ключа пира письмо не учитывается', Object.keys(globalThis.__state.unread).length === 0);
    ok('без ключа пира персист не вызван',
      !calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('kind=message — письмо учтено и ушло в персист', {
  kind: { kind: 'message', env_id: 'm1' },
  plain: MSG,
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('бейдж 1:1 вырос', globalThis.__state.unread['bob@x'] === 1);
    ok('персист vault_store_incoming_message вызван',
      calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('kind=profile — профиль сохранён, но это не сообщение', {
  kind: { kind: 'profile' },
  plain: '{"vault":1,"id":"p1","type":"profile","text":"","name":"Bob","ts":1,"key":"BOBKEY"}',
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('saveProfile вызван', globalThis.__state.savedProfiles.length === 1);
    ok('бейдж НЕ вырос', Object.keys(globalThis.__state.unread).length === 0);
  },
});

await run('kind=call — сигнал в state machine, не в бейджи', {
  kind: { kind: 'call' },
  plain: '{"vault":1,"id":"c1","type":"call_request","call_id":"c1"}',
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('handleCallSignal вызван', globalThis.__state.callSignals.length === 1);
    ok('бейдж НЕ вырос', Object.keys(globalThis.__state.unread).length === 0);
  },
});

await run('kind=presence — только heartbeat (без решения в JS)', {
  kind: { kind: 'presence' },
  plain: '{"presence":1,"ts":1}',
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('noteHeartbeat вызван', globalThis.__state.heartbeats.length === 1);
    ok('бейдж НЕ вырос', Object.keys(globalThis.__state.unread).length === 0);
  },
});

await run('kind=channel — пост канала считается как сообщение канала', {
  kind: { kind: 'channel' },
  plain: '{"channel":1,"chan":"ch1","post":{"body":"hi"},"id":"chp-1"}',
  ctxOver: { channels: () => [{ id: 'ch1', key: 'CHKEY', name: 'Chan' }] },
  expect: () => {
    ok('бейдж канала вырос', globalThis.__state.unread['channel:ch1'] === 1);
  },
});

await run('kind=group-service (hav) — ответ на запрос аватарки группы', {
  kind: { kind: 'group-service' },
  plain: '{"hav":1}',
  ctxOver: {
    groups: () => [{ id: 'g1', name: 'G', members: [{ email: 'bob@x' }] }],
    groupKeys: { g1: 'GK' },
  },
  expect: () => {
    ok('replyGroupAvatarHeal вызван для g1', globalThis.__state.healed[0] === 'g1');
    ok('бейдж НЕ вырос', Object.keys(globalThis.__state.unread).length === 0);
  },
});

await run('kind=null — письмо не наше: ничего не происходит', {
  kind: null,
  plain: '{"hello":"world"}',
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: () => {
    ok('бейдж НЕ вырос', Object.keys(globalThis.__state.unread).length === 0);
    ok('персист не вызывался', !calls.some(c => c.cmd === 'vault_store_incoming_message'));
  },
});

await run('мост упал — письмо не считается и не помечается обработанным', {
  kind: { kind: 'message' },
  plain: MSG,
  bridgeDown: true,
  ctxOver: { peerKeys: { 'bob@x': 'BOBKEY' } },
  expect: (deps) => {
    ok('бейдж НЕ вырос', Object.keys(globalThis.__state.unread).length === 0);
    ok('processedUnreadIds пуст (письмо повторится)', deps.processedUnreadIds.size === 0);
  },
});

// Мост валится именно на классификаторе: иначе тест «упал мост» ничего не проверяет.
console.log('\nмост упал громко (console.error), а не молча');
{
  state.bridgeDown = true;
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  const deps = { ...makeDeps({ peerKeys: { 'bob@x': 'BOBKEY' } }), ...DEPS };
  deps.emailBodyCache['INBOX:1'] = 'encrypted-body';
  try { await processIncoming(deps, [letter()], { notify: false }); } finally { console.error = orig; }
  ok('в логе есть «Rust-классификатор недоступен»',
    seen.some(s => s.includes('Rust-классификатор недоступен')));
}

console.log(`\nincoming-routing: ${checks} проверок, провалов ${failed}`);
if (failed) process.exit(1);
