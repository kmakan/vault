// Смоук фильтра приглашений (ADR-005 W4, партия 4d).
//
// ЗАЧЕМ. «Этот инвайт уже принят — группа моя?» решался в api.js двумя
// сравнениями адреса (создатель/участник), и ни один смоук этого места не
// касался: invites-smoke подменяет api целиком, а api.js поднимают только
// recovery/body-absence — про другие методы. Ровно тот случай, ради которого
// заведена задача: решение жило при нулевом счётчике долга.
//
// Теперь решение — ответ моста `groups_access`. Здесь проверяется КОНТРАКТ
// пересылки: что уходит в мост (адрес, отпечаток, алиасы), что считается
// «моя группа» (только `is_mine`), и что `null`/отказ моста НЕ теряют попап.
//
// api.js исполняется живой копией из /tmp с замоканными Tauri-импортами —
// как в recovery-session-smoke; сети, файлов пользователя и таймеров нет.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/pending-invites-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api.js при загрузке создаёт singleton и читает localStorage.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const calls = [];
globalThis.__ownCalls = [];
globalThis.__invoke = async (cmd, args) => {
  calls.push({ cmd, args });
  if (args.groupId === 'g-bridge-down') throw new Error('мост недоступен');
  const answer = globalThis.__accessByGroup[args.groupId];
  return answer === undefined ? null : answer;
};
writeFileSync(MOCKS + '/core.mjs',
  'export const invoke = (...a) => globalThis.__invoke(...a);\n');
// Крипта в этом смоуке не вызывается: модуль нужен только для загрузки.
writeFileSync(MOCKS + '/crypto.mjs',
  'export default { initFromStorage: async () => {}, fingerprint: async () => "" };\n');
writeFileSync(MOCKS + '/identity.mjs', [
  'export const accountNamespace = async (e) => "fp:" + String(e || "").toLowerCase();',
  'export const ensureAccountNamespace = async () => "ns:me";',
  'export const resetAccountNamespaceCache = () => {};',
  'export const resolveAlias = async (a) => a;',
  'export const rememberAlias = async () => {};',
  // Гейт «это наше письмо?»: ядро сравнивает нормальные формы. Здесь —
  // его контракт без словаря; смена адреса приходит уже разрешённой сверху.
  'export const isOwnSender = async (a, e) => {',
  '  globalThis.__ownCalls.push(String(a || ""));',
  '  const r = String(a || "").trim().toLowerCase();',
  '  return !!r && r === String(e || "").trim().toLowerCase();',
  '};',
  '',
].join('\n'));
// Разбор тела письма — правило ядра (28.10); смоуку нужен только сам файл.
writeFileSync(MOCKS + '/body-decode.js',
  'export const decodeUrlSafeText = async (b) => globalThis.__invoke("vault_decode_url_safe_body", { body: b });\n' +
  'export const channelKidHex = async (t) => globalThis.__invoke("channel_kid_hex", { token: t });\n');
writeFileSync(MOCKS + '/recovery-session.mjs',
  'export const isRecoveryPending = () => false;\n'
  + 'export const clearRecoveryPending = () => {};\n');

const apiFile = MOCKS + '/api.mjs';
prepareModuleCopy(ROOT + '/src/api.js', apiFile, {
  '@tauri-apps/api/core': 'core.mjs',
  './crypto.js': 'crypto.mjs',
  './identity.js': 'identity.mjs',
  './features/recovery-session.js': 'recovery-session.mjs',
  './body-decode.js': 'body-decode.js',
}, MOCKS);
const { default: api } = await import(apiFile);

// ── Стенд ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ПРОВАЛ: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const invite = (groupId, uid = '1') => ({
  uid,
  date: '2026-10-20T10:00:00Z',
  parsed: {
    group_id: groupId,
    group_name: 'Группа ' + groupId,
    sender: '',
    created_by: 'owner@x',
  },
});

// Мост отвечает ПО ГРУППЕ: «моя» только g-own; g-foreign — чужая;
// g-absent — локально не сохранена (null); g-bridge-down — отказ.
globalThis.__accessByGroup = {
  'g-own': { is_mine: true },
  'g-foreign': { is_mine: false },
  'g-absent': null,
};

let handshake = [];
api.fetchAllHandshake = async () => ({ groupInvites: handshake });
api.getDeclinedInvites = async () => [];
api.getAcceptedInvites = async () => [];
api.email = 'me@local.example';

const reset = () => { calls.length = 0; globalThis.__ownCalls.length = 0; };

// ── 1. Своя группа скрыта, остальные показаны ─────────────────────────────
reset();
handshake = [invite('g-own'), invite('g-foreign'), invite('g-absent'), invite('g-bridge-down')];
const identity = () => ({ email: 'me@alias.example', fingerprint: 'FP-ME', aliases: ['old@x.example'] });
let shown = [];
let threw = null;
try { shown = await api.fetchPendingInvites(identity); } catch (e) { threw = e; }
ok('отказ моста не вылетает наружу (попап не теряем)', threw === null);
ok('свой инвайт по уже импортированной группе НЕ показывается',
  !shown.some(i => i.group_id === 'g-own'), shown.map(i => i.group_id));
ok('чужой инвайт показывается', shown.some(i => i.group_id === 'g-foreign'));
ok('группа не сохранена локально (мост ответил null) — инвайт показывается',
  shown.some(i => i.group_id === 'g-absent'));
ok('отказ моста не теряет попап', shown.some(i => i.group_id === 'g-bridge-down'));

// ── 2. В мост уходят адрес, отпечаток и алиасы идентичности ───────────────
const ownCall = calls.find(c => c.args.groupId === 'g-own');
ok('запрос прав идёт командой groups_access', !!ownCall && ownCall.cmd === 'groups_access');
ok('в мост ушёл текущий адрес идентичности, а не поле транспорта',
  ownCall && ownCall.args.email === 'me@alias.example', ownCall && ownCall.args.email);
ok('в мост ушёл отпечаток', ownCall && ownCall.args.fingerprint === 'FP-ME');
ok('в мост ушли алиасы (смена почты участником)',
  ownCall && JSON.stringify(ownCall.args.aliases) === JSON.stringify(['old@x.example']));

// ── 3. Без функции идентичности — адрес сессии, пустые fp/алиасы ───────────
reset();
handshake = [invite('g-own')];
shown = await api.fetchPendingInvites();
ok('без identity адрес берётся у сессии', calls[0] && calls[0].args.email === 'me@local.example');
ok('без identity отпечаток пуст', calls[0] && calls[0].args.fingerprint === '');
ok('без identity алиасов нет', calls[0] && Array.isArray(calls[0].args.aliases) && calls[0].args.aliases.length === 0);
ok('своя группа всё равно скрыта', shown.length === 0, shown);

// ── 4. accept-письмо: запись ключа пира ────────────────────────────────────
// Здесь свой аккаунт и возвращался в контакты: `fetchPendingContactAccepts`
// писал `save_peer_key` без `own_email` (Option-аргумент — `gate:tauri-args`
// его отсутствие прощает), а гейт «это моё письмо» терялся при правке
// пересылки. Мера — форма вызова команды + поведение на своём отправителе.
const acceptLetter = (sender, uid = '5') => ({
  uid,
  date: '2026-10-24T00:00:00Z',
  parsed: { sender, public_key: 'PEERPK', sender_name: 'Peer', pq_public_key: 'PEERPQ' },
});
{
  const writes = [];
  api.fetchAllHandshake = async () => ({ accepts: [
    acceptLetter('peer@x.example'),
    acceptLetter('me@local.example', '9'),
    // Письмо СТАРОГО нашего адреса: резолв alias'а приводит его к текущему —
    // второй гейт («это мы») иначе пропустил бы свой ключ в peer_keys.
    acceptLetter('old@local.example', '8'),
    // Свой адрес в ДРУГОМ РЕГИСТРЕ: прежнее сравнение строк после резолва
    // пропускало его, и наш ключ возвращался в контакты.
    acceptLetter('ME@Local.Example', '7'),
  ] });
  api.loadPeerKeyEmails = async () => new Set();
  api.getAcceptedContacts = async () => [];
  api.getInvitedSenders = async () => [
    'peer@x.example', 'me@local.example', 'old@local.example', 'ME@Local.Example',
  ];
  api.resolvePeerAlias = async (s) => (s === 'old@local.example' ? 'me@local.example' : s);
  api.saveProfile = async () => {};
  api.markAcceptedContact = () => {};
  api.removeInvitedSender = async () => {};
  api.contacts = [];
  globalThis.__invoke = async (cmd, args) => { writes.push([cmd, args]); return null; };
  reset();
  const out = await api.fetchPendingContactAccepts();
  const save = writes.find(([cmd]) => cmd === 'save_peer_key');
  ok('письмо пира записало его ключ', !!save && save[1].email === 'peer@x.example' && save[1].publicKey === 'PEERPK', writes);
  ok('PQ-ключ ушёл вместе с основным', !!save && save[1].pqPublicKey === 'PEERPQ', save && save[1]);
  ok('запись ушла со своей почтой (OWN-ADDRESS GUARD включён)', !!save && save[1].ownEmail === 'me@local.example', save && save[1]);
  ok('СВОИ accept-письма не записывают ключ (ни текущий адрес, ни старый alias)',
    writes.length === 1 && save[1].email === 'peer@x.example', writes.map(([c, a]) => [c, a.email]));
  ok('регистр в адресе не делает своё письмо чужим',
    !!save && writes.length === 1 && save[1].email === 'peer@x.example',
    writes.map(([c, a]) => [c, a.email]));
  ok('гейт «это мы» спрашивает ядро, а не сравнивает строки на месте',
    globalThis.__ownCalls.includes('ME@Local.Example'), globalThis.__ownCalls);
  ok('принятый возвращён списком ({sender})', JSON.stringify(out) === JSON.stringify([{ sender: 'peer@x.example' }]), out);
}

// ── 5. Sweep старых handshake-писем: пометки только для чужих ─────────────
// Тот же гейт живёт в `sweepStaleHandshake` (одноразовые пометки declined/
// accepted). Своё письмо в другом регистре не должно оставить пометку под
// своим адресом.
{
  const writes = [];
  api.fetchAllHandshake = async () => ({
    invites: [
      { uid: '12', date: '2026-10-24T00:00:00Z', parsed: { sender: 'peer@x.example', group_id: 'g-f', group_name: 'F', created_by: 'peer@x.example' } },
      { uid: '13', date: '2026-10-24T00:00:00Z', parsed: { sender: 'ME@Local.Example', group_id: 'g-f', group_name: 'F', created_by: 'ME@Local.Example' } },
    ],
    accepts: [
      { uid: '21', date: '2026-10-24T00:00:00Z', parsed: { sender: 'peer@x.example' } },
      { uid: '22', date: '2026-10-24T00:00:00Z', parsed: { sender: 'old@local.example' } },
      { uid: '23', date: '2026-10-24T00:00:00Z', parsed: { sender: 'Me@LOCAL.example' } },
    ],
  });
  api.getDeclinedContacts = async () => [];
  api.getAcceptedContacts = async () => [];
  globalThis.__invoke = async (cmd, args) => { writes.push([cmd, args]); return null; };
  reset();
  await api.sweepStaleHandshake();
  const kv = key => {
    const w = writes.find(([cmd, a]) => cmd === 'db_kv_set' && a.key === key);
    return w ? JSON.parse(w[1].value) : null;
  };
  const declined = kv('declined-contacts') || [];
  const accepted = kv('accepted-contacts') || [];
  ok('sweep пометил чужой инвайт и только его',
    JSON.stringify(declined) === JSON.stringify(['peer@x.example|12']), declined);
  ok('sweep пометил чужой accept и только его',
    JSON.stringify(accepted) === JSON.stringify(['peer@x.example|21']), accepted);
  ok('sweep закрывает проход даже без единой своей пометки',
    !!writes.find(([cmd, a]) => cmd === 'db_kv_set' && a.key === 'handshake-sweep-done'),
    writes.map(([c, a]) => [c, a.key]));
}

// ── 6. Попап контактного инвайта: свой отправитель не показывается ────────
// Четвёртая точка того же гейта: `fetchPendingContactInvites`. Свой адрес в
// другом регистре и старый наш адрес (через alias) не должны рождать попап
// «Добавить контакт».
{
  const contactInvite = (sender, uid) => ({
    uid,
    date: '2026-10-24T00:00:00Z',
    parsed: { sender, public_key: 'INVK', sender_name: 'Peer' },
  });
  api.fetchAllHandshake = async () => ({ invites: [
    contactInvite('peer@x.example', '31'),
    contactInvite('ME@Local.Example', '32'),
    contactInvite('old@local.example', '33'),
  ] });
  api.getDeclinedContacts = async () => [];
  api.getAcceptedContacts = async () => [];
  api.loadPeerKeyEmails = async () => new Set();
  api.isKnownPeerKey = async () => false;
  api.saveProfile = async () => {};
  api.resolvePeerAlias = async (s) => (s === 'old@local.example' ? 'me@local.example' : s);
  globalThis.__invoke = async () => null;
  reset();
  const list = await api.fetchPendingContactInvites();
  ok('попап показывает только чужой инвайт (свои в любом регистре и через alias скрыты)',
    list.length === 1 && list[0].sender === 'peer@x.example', list.map(i => i.sender));
  ok('гейт попапа спрашивает ядро о смешанном регистре',
    globalThis.__ownCalls.includes('ME@Local.Example'), globalThis.__ownCalls);
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
