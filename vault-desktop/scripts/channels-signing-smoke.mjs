// Смоук подписи постов канала (ADR-002) на стороне клиента.
//
// Что проверяем — ровно то, что не видно в зелёных тестах релея:
//   1. kid передаётся в Rust HEX-СТРОКОЙ и совпадает с первыми 8 байтами
//      read-токена, прочитанными BE (ключевая точка: JSON-число после 2^53
//      теряет точность, молча подменённый kid = подпись не того канала);
//   2. регистрация ключа уходит на релей ДО публикации и ровно один раз;
//   3. подпись кладётся в поле `sig` тела /pub;
//   4. 403 по подписи СБРАСЫВАЕТ пометку «зарегистрирован» — иначе канал
//      молча застревает в v1 навсегда, и дыра открывается без признака;
//   5. отказ регистрации (канал занял другой claimant, §7 ADR-002) не роняет
//      публикацию; то же без личного токена.
//
// Каждый сценарий — СВОЙ канал (свой kid). Пометка «зарегистрирован» живёт
// в модуле на (релей, kid), и общий канал протекал бы между случаями:
// проверка падала бы не из-за бага, а из-за залипшего состояния.
//
// Мок тот же, что в relay-client-smoke: подменяем Tauri-зависимости и
// переписываем импорты копии исходника. Копия, а не сам модуль: иначе тест
// проверял бы не то, что собирается в приложении.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;
const MOCKS = '/tmp/channels-signing-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const RELAY_URL = 'https://vault-msg.ru/relay';
const PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const SIG = 'SIGNATURE-BASE64URL';

// ── Токены каналов руками, по раскладке tokens.rs ────────────────────
// token = base64url(key_id(8) ‖ scope(1) ‖ expiry(4) ‖ mac(32))
// key_id НЕ нулевой: нули не показали бы, что hex-путь читает именно его.
const b64url = (b) => Buffer.from(b).toString('base64url');
function mkTok(idByte, scopeChar, macByte) {
  return b64url(Buffer.concat([
    Buffer.from([idByte, 2, 3, 4, 5, 6, 7, 8]), // key_id, BE
    Buffer.from(scopeChar),                    // 'c' read / 'C' write
    Buffer.from([255, 255, 255, 255]),         // expiry = MAX для канала
    Buffer.alloc(32, macByte),                 // mac
  ]));
}
// Каналы различаются broadcast-ключом (как в жизни): relay-client зовёт
// channelTokens(ch.key), поэтому разводим токены по ключу, а не по id.
const CH_A = 'aa'.repeat(32), CH_409 = 'bb'.repeat(32), CH_NTOK = 'cc'.repeat(32);
const TOKENS = {
  [CH_A]: { read: mkTok(1, 'c', 0xab), write: mkTok(1, 'C', 0xcd) },
  [CH_409]: { read: mkTok(2, 'c', 0xab), write: mkTok(2, 'C', 0xcd) },
  [CH_NTOK]: { read: mkTok(3, 'c', 0xab), write: mkTok(3, 'C', 0xcd) },
};

// ── Заглушки Tauri ───────────────────────────────────────────────────
const kv = new Map([
  ['relay-enabled', '1'],
  ['relay-list', JSON.stringify([{ url: RELAY_URL, myToken: 'MY-TOKEN', label: 'Vault' }])],
]);
globalThis.__kv = kv;
const signCalls = [];
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'db_kv_get') return kv.has(args.key) ? kv.get(args.key) : null;
  if (cmd === 'db_kv_set') { kv.set(args.key, String(args.value)); return null; }
  if (cmd === 'channel_signing_key') return PUBKEY;
  if (cmd === 'channel_sign_post') { signCalls.push(args); return SIG; }
  return null;
};
globalThis.__fp = 'aa:bb:cc:dd:ee:ff';
globalThis.window = globalThis;
globalThis.__nsOf = (e) => e;
globalThis.__tokOf = (keyHex) => TOKENS[keyHex];

writeFileSync(MOCKS + '/core.js',
  'export const invoke = (...a) => globalThis.__invoke(...a);');
// ADR-001 Этап 2: идентичность вынесена из api.js в identity.js
// (identity.js → api/relay-client, иначе транспорт тянул api, а api
// тянул транспорт — цикл). Мок повторяет НОВУЮ форму, иначе копия
// исходника не резолвится и тест падает на импорте, а не на логике.
writeFileSync(MOCKS + '/identity.js',
  'export const accountNamespace = (e) => globalThis.__nsOf(String(e || "").trim().toLowerCase());');
writeFileSync(MOCKS + '/api.js',
  'export const accountNamespace = (e) => globalThis.__nsOf(String(e || "").trim().toLowerCase());');
writeFileSync(MOCKS + '/crypto.js',
  'const c = { fingerprint: async () => globalThis.__fp }; export default c;');
// ADR-001 Этап 2: channelTokens уехал из фичи в примитив channels-tokens.js,
// и транспорт тянет его статическим импортом. Мок — на новом месте.
writeFileSync(MOCKS + '/channels-tokens.js',
  'export const channelTokens = async (keyHex) => globalThis.__tokOf(keyHex);');
writeFileSync(MOCKS + '/channels.js', 'export const __noop = 1;');

let src = readFileSync(ROOT + '/../src/relay-client.js', 'utf8');
src = src
  .replace("from '@tauri-apps/api/core'", 'from "' + MOCKS + '/core.js"')
  .replace("from './api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from './identity.js'", 'from "' + MOCKS + '/identity.js"')
  .replace("import('./crypto.js')", 'import(' + JSON.stringify(MOCKS + '/crypto.js') + ')')
  .replace("'./features/channels.js'", JSON.stringify(MOCKS + '/channels.js'))
  .replace("'./channels-tokens.js'", JSON.stringify(MOCKS + '/channels-tokens.js'))
  .replace("import.meta.env.VITE_RELAY_URL || ''", "''");
writeFileSync(MOCKS + '/relay-client.mjs', src);

// ── HTTP-заглушка ────────────────────────────────────────────────────
const calls = [];
let pubStatus = 200, keyStatus = 200;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  const u = String(url);
  if (u.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (u.endsWith('/channel-key')) {
    const good = keyStatus >= 200 && keyStatus < 300;
    return { ok: good, status: keyStatus, text: async () => (good ? '' : 'kid already registered') };
  }
  if (u.endsWith('/pub')) {
    const good = pubStatus >= 200 && pubStatus < 300;
    return { ok: good, status: pubStatus,
      text: async () => (good ? '' : 'channel post signature invalid') };
  }
  return { ok: true, status: 200, json: async () => ({ token: 'TOK' }), text: async () => '' };
};

const RC = await import(MOCKS + '/relay-client.mjs');
const tick = () => new Promise(r => setTimeout(r, 5));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ ПРОВАЛ:', name); }
}
const pubs = () => calls.filter(c => c.url.endsWith('/pub'));
const keys = () => calls.filter(c => c.url.endsWith('/channel-key'));
const lastPub = () => JSON.parse(pubs()[pubs().length - 1].opts.body);
const signFor = (kidHex) => signCalls.filter(s => s.kidHex === kidHex);

const publish = (id, keyHex) => RC.relayChannelPublish({ id, key: keyHex }, { id: 'env-1' }, 'шифрованное тело', 'a@b.c');

console.log('\nADR-002 · подпись постов канала — клиент');

// ── 1. Стыковка: регистрация → подпись → /pub ─────────────────────────
const A_KID = '0102030405060708';
await publish('chn_a', CH_A);
await tick();
ok('регистрация ключа ушла на релей', keys().length === 1);
ok('регистрация несёт токен канала и pubkey', (() => {
  const b = JSON.parse(keys()[0].opts.body);
  return b.token === TOKENS[CH_A].read && b.pubkey === PUBKEY;
})());
ok('подпись запрошена у Rust', signFor(A_KID).length === 1);
ok('kid передан HEX-строкой, а не числом', typeof signFor(A_KID)[0].kidHex === 'string');
ok('kid = первые 8 байт read-токена, BE', signFor(A_KID)[0].kidHex === A_KID);
ok('подпись привязана к id конверта', signFor(A_KID)[0].envId === 'env-1');
ok('подписывается ровно та body, что уйдёт в JSON', signFor(A_KID)[0].body === lastPub().body);
ok('в теле /pub есть sig', lastPub().sig === SIG);

// ── 2. Повторная публикация: регистрация не дублируется ──────────────
await publish('chn_a', CH_A);
await tick();
ok('регистрация не повторяется на каждый пост', keys().length === 1);
ok('при этом подпись берётся на каждый пост', signFor(A_KID).length === 2);

// ── 3. 403 по подписи сбрасывает пометку ──────────────────────────────
// Сброс происходит в конце публикации, поэтому проверяем СЛЕДУЮЩУЮ: если
// пометка залипла, регистрация навечно прекратится и канал останется в v1.
pubStatus = 403;
const r403 = await publish('chn_a', CH_A);
await tick();
ok('403 распознан как отказ по подписи', r403.why === 'signature-rejected');
ok('во время 403-публикации регистрация ещё не переспрашивается (кэш)', keys().length === 1);

pubStatus = 200;
await publish('chn_a', CH_A);
await tick();
ok('после 403 пометка сброшена — регистрация повторена', keys().length === 2);
ok('и канал снова подписывается', lastPub().sig === SIG);

// ── 4. Релей отклонил регистрацию (канал занял другой claimant, §7) ───
// Пост обязан уйти: потерянный пост хуже, чем пост без подписи (v1).
keyStatus = 409;
const keysBefore = keys().length, pubsBefore = pubs().length;
const r409 = await publish('chn_409', CH_409);
await tick();
ok('отказ регистрации не роняет публикацию', pubs().length === pubsBefore + 1 && r409.ok === true);
ok('подпись при неудачной регистрации всё равно ставится',
  signFor('0202030405060708').length === 1);
ok('в теле /pub sig на месте несмотря на отказ регистрации', lastPub().sig === SIG);

// ── 5. Нет личного токена: регистрации нет, публикация жива ───────────
kv.set('relay-list', JSON.stringify([{ url: RELAY_URL, myToken: '', label: 'Vault' }]));
keyStatus = 200;
const keysBefore2 = keys().length, pubsBefore2 = pubs().length;
const rNtok = await publish('chn_ntok', CH_NTOK);
await tick();
ok('без личного токена ключ НЕ регистрируется', keys().length === keysBefore2);
ok('пост без регистрации всё равно уходит', pubs().length === pubsBefore2 + 1 && rNtok.ok === true);
ok('и всё равно подписан — релей отвергнет только если ключ чужой',
  signFor('0302030405060708').length === 1);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);