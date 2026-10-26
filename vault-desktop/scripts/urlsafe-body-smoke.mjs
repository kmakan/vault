// smoke: urlsafe-body-decode-smoke.mjs
// Контракт url-safe base64 ТЕЛА handshake-письма на стороне JS-транспорта
// (src/api.js, urlSafeB64 / urlSafeB64Decode) — третьей копии того же правила
// чтения тела (первая — ядро vault-client/src/crypto.rs, вторая — мост
// src-tauri/src/crypto.rs::b64_decode_mail; сравнение копий: docs/M0-WIRE-FORMAT-PARITY.md §3).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Тело письма пишет и читает ОДНО И ТО ЖЕ правило, но
// тремя реализациями: ядро (Rust), мост (Rust) и фронт (JS). Ядро и мост
// измерены мутациями (crypto.mjs +4, rust-bridge-crypto-mail 19/19), JS-копия
// не измерялась вообще — канбан t_7d2c1bb1.
//
// ЧТО ЗДЕСЬ НАГРУЗКА, А ЧТО НЕТ (замер 25.10 на Node и по WHATWG
// «forgiving-base64», которому следует и WebView телефона):
//   · алфавит `-`/`_` → `+`/`/` — ОБЯЗАТЕЛЕН: atob бросает
//     InvalidCharacterError на любом из этих байтов (проверено ниже);
//   · починка padding — ОБЯЗАТЕЛЕН по числу символов: недобор atob терпит,
//     перебор (2 и более `=`) бросает; поэтому мутация «repeat(len % 4)»
//     ловится фикстурой с длиной % 4 == 3;
//   · кириллица в полях — ОБЯЗАТЕЛЕН UTF-8-раундtrip (`escape`/
//     `decodeURIComponent`): без него имя группы превращается в mojibake,
//     JSON при этом остаётся валидным, так что поймать может только сверка
//     значения, а не «не упало»;
//   · снятие `\s` — ЗДЕСЬ ЭКВИВАЛЕНТНЫЙ мутант: atob сам выкидывает ASCII-
//     пробелы перед декодом (проверено: atob('QU\r\nJD') = 'ABC'). Строка
//     оставлена как защита от будущей замены декодера, ноcoverage по ней —
//     врать не будем — нулевая, и в набор она не включена намеренно.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/urlsafe-body-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function mute() {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return () => { console.log = l; console.warn = w; console.error = e; }
}

// ── фикстуры: подобраны так, чтобы url-safe тело ГАРАНТИРОВАННО содержало
//    и `-`, и `_` (иначе проверка алфавита превращается в декорацию) ──
const A = { kind: 'group-invite', gid: 'g-10', name: 'Тестовая группа',
            from: 'peer@example.invalid', fp: 'fp:test' };
const B = { kind: 'group-invite', gid: 'g-1', name: 'Группа для смоука',
            from: 'peer@example.invalid', fp: 'fp:test' };

// ── мир: только то, что реально дёргает мост ──────────────────────
const world = {
  cache: new Map(),
  batch: [],
};
globalThis.__W = world;
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  clear: () => lsStore.clear(),
};
globalThis.__INVOKE__ = async (cmd, args) => {
  const W = globalThis.__W;
  switch (cmd) {
    case 'db_account_namespace': return 'fp:testnamespace';
    case 'db_body_cache_get': return W.cache.has(args.cacheKey) ? W.cache.get(args.cacheKey) : null;
    case 'db_body_cache_set':
      W.cache.set(args.cacheKey, args.body);
      return true;
    case 'email_fetch_bodies': return W.batch;
    default: return undefined;
  }
};

writeFileSync(MOCKS + '/crypto.js', `
export default {
  initFromStorage: async () => {}, generateKeypair: async () => ({}),
  saveToStorage: async () => {}, fingerprint: async () => 'fp:test',
  setPeerPublicKey: () => {}, savePeerKey: async () => {},
  loadPeerKeys: async () => [], removePeerKey: async () => {},
};
`);
writeFileSync(MOCKS + '/identity.js', `
export const accountNamespace = async () => 'fp:testnamespace';
export const ensureAccountNamespace = async () => 'fp:testnamespace';
export const resetAccountNamespaceCache = () => {};
export const resolveAlias = async (a) => a;
export const rememberAlias = async () => {};
`);
writeFileSync(MOCKS + '/recovery-session.js', `
export const isRecoveryPending = () => false;
export const clearRecoveryPending = () => true;
`);

// Копия живого src/api.js: мост подменён,helpers экспортированы ДЛЯ ТЕСТА
// (в исходнике они модульные — наружу ничего не выносим).
const API_FILE = MOCKS + '/api-live.mjs';
prepareModuleCopy(
  ROOT + '/src/api.js',
  API_FILE,
  {
    './crypto.js': 'crypto.js',
    './identity.js': 'identity.js',
    './features/recovery-session.js': 'recovery-session.js',
  },
  MOCKS,
  [
    ["import { invoke } from '@tauri-apps/api/core';", 'const invoke = (...a) => globalThis.__INVOKE__(...a);'],
    ['export default new ApiClient();',
     'export default new ApiClient();\nexport { urlSafeB64 as _encodeBody, urlSafeB64Decode as _decodeBody };'],
  ],
);
const mod = await import('file://' + API_FILE);
const encode = mod._encodeBody, decode = mod._decodeBody;
const api = new mod.ApiClient();
api.email = 'me@example.invalid';

const fold76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

console.log('\nПишем (urlSafeB64): алфавит URL_SAFE_NO_PAD — как CLI/Rust:');
const bA = encode(A), bB = encode(B);
check('фикстура A: тело содержит `-` (иначе проверка алфавита — декорация)', bA.includes('-'), bA);
check('фикстура A: тело содержит `_`', bA.includes('_'), bA);
check('фикстура B: длина тела % 4 == 3 (ловит перебор padding)', bB.length % 4 === 3, bB.length);
check('ни `+`, ни `/` в теле (IMAP/SMTP-хопы читают `+` как пробел)',
  !/[+/]/.test(bA) && !/[+/]/.test(bB), { bA, bB });
check('без хвостового `=` (URL_SAFE_NO_PAD — тот же контракт, что у ядра)',
  !/=/.test(bA) && !/=/.test(bB), { tailA: bA.slice(-3), tailB: bB.slice(-3) });

console.log('\nЧитаем (urlSafeB64Decode): round-trip и переносы:');
const same = (o, s) => { try { return JSON.stringify(decode(s)) === JSON.stringify(o); } catch (e) { return 'THROW ' + e.name; } };
check('A без padding декодируется в исходный объект', same(A, bA) === true, same(A, bA));
check('B без padding декодируется (длина % 4 == 3 → ровно один `=`)', same(B, bB) === true, same(B, bB));
check('A после фолдинга ≤76 (так тело лежит в письме) — тот же объект', same(A, fold76(bA)) === true, same(A, fold76(bA)));
check('B после фолдинга ≤76 — тот же объект', same(B, fold76(bB)) === true, same(B, fold76(bB)));
check('кириллица имени группы прошла раундtrip без mojibake',
  decode(bA).name === 'Тестовая группа', decode(bA).name);
check('мутация «перебор padding» ловится: B с `===` на конце бросает',
  (() => { try { atob(bB + '==='); return false; } catch (e) { return e.name === 'InvalidCharacterError'; } })());
check('мутация «алфавит не переведён» ловится: atob бросает на `-`/`_`',
  (() => { try { atob(bA); return false; } catch (e) { return e.name === 'InvalidCharacterError'; } })());

console.log('\n_parseHandshakeItem — чужое письмо не ломает разбор:');
function safeParse(m, body) {
  try { return { item: api._parseHandshakeItem(m, body) }; }
  catch (e) { return { threw: e && e.message }; }
}
{
  const r = safeParse({ uid: '1', folder: 'INBOX', subject: 'VaultGroupInvite: peer@example.invalid' }, bA);
  check('своё письмо: kind из тела, разобран gid',
    !r.threw && r.item && r.item.kind === 'group-invite' && r.item.parsed.gid === 'g-10', r);
  const junk = safeParse({ uid: '2', folder: 'INBOX', subject: '' }, 'Это вообще не base64 !!!');
  check('чужое письмо (пустая тема, тело не декодируется) → null, БЕЗ исключения',
    !junk.threw && junk.item === null, junk);
  const b64noKind = safeParse({ uid: '3', folder: 'INBOX', subject: '' }, encode({ hello: 'world' }));
  check('чужое письмо (валидный base64, но без kind и без маркера темы) → null',
    !b64noKind.threw && b64noKind.item === null, b64noKind);
}

console.log('\nfetchAllHandshake: фолдинг из письма и чужое тело рядом:');
{
  world.cache.clear();
  // Стелс-письмо с пустой темой — кандидат на разбор; тело — мусор. Рядом
  // наше приглашение, уже с фолдингом (как его отдаёт IMAP после SMTP-хопов).
  api._emailsSource = [
    { uid: '100', folder: 'INBOX', subject: '', date: '2026-10-20' },
    { uid: '101', folder: 'INBOX', subject: 'VaultGroupInvite: peer@example.invalid', date: '2026-10-21' },
  ];
  world.batch = [['100', 'Это вообще не base64 !!!'], ['101', fold76(bA)]];
  api._handshakeParsed = null; api._handshakeCache = null;
  const unmute = mute();
  const out = await api.fetchAllHandshake();
  unmute();
  check('чужое тело не утащило весь скан: приглашение в выдаче',
    out.groupInvites.length === 1, { gi: out.groupInvites.length, inv: out.invites.length });
  check('тело из письма с переносами разобрано по полям (не только по теме)',
    out.groupInvites[0] && out.groupInvites[0].parsed
      && out.groupInvites[0].parsed.name === 'Тестовая группа'
      && out.groupInvites[0].parsed.from === 'peer@example.invalid',
    out.groupInvites[0] && out.groupInvites[0].parsed);
  check('чужое письмо в выдаче не появилось', out.invites.length === 0 && out.accepts.length === 0);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
