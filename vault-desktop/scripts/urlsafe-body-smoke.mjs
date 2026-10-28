// smoke: urlsafe-body-smoke.mjs
// Проводка handshake-классификатора (src/api.js) и контракт ЗАПИСИ тела
// (src/api.js::urlSafeB64 — единственная оставшаяся в JS половина правила).
//
// ЧТО ИЗМЕНИЛОСЬ 28.10 (t_7d2c1bb1). Чтение тела (folding SMTP, QP, padding,
// url-safe алфавит, UTF-8) больше НЕ живёт в JS: правило одно — в ядре
// vault_client::crypto::{decode_mail_body, decode_url_safe_text, channel_kid_hex}.
// Его мера — общая фикстура vault-client/tests/fixtures/body-decode-contract.json
// (Rust-тесты ядра и моста) + мутации ядра; адаптер проводки меряет
// body-decode-smoke.mjs.
//
// Здесь остаётся ПРОВОДКА: fetchAllHandshake классифицирует письма по kind из
// тела и по legacy-маркеру темы, кэширует пустое тело как «тело не придёт», и
// чужое письмо (тело декодируется, но это не JSON / нет kind) не роняет скан.
// Двойник моста — scripts/lib/body-decode-mock.mjs: смоук проверяет, что JS
// зовёт мост и правильно распоряжается результатом, а не повторяет правило.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { bodyDecodeHandler, writeBodyDecodeAdapter } from './lib/body-decode-mock.mjs';

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
  return () => { console.log = l; console.warn = w; console.error = e; };
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
  decodeCalls: [],
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
    default: {
      W.decodeCalls.push({ cmd, args });
      const v = bodyDecodeHandler(cmd, args);
      if (v === undefined) throw new Error('No such command: ' + cmd);
      return v;
    }
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
export const isOwnSender = async (a, e) => String(a||'').trim().toLowerCase() === String(e||'').trim().toLowerCase();
`);
writeFileSync(MOCKS + '/recovery-session.js', `
export const isRecoveryPending = () => false;
export const clearRecoveryPending = () => true;
`);
writeBodyDecodeAdapter(MOCKS, 'const invoke = (...a) => globalThis.__INVOKE__(...a);');

// Копия живого src/api.js: мост подменён, энкодер экспортирован ДЛЯ ТЕСТА
// (в исходнике он модульный — наружу ничего не выносим).
const API_FILE = MOCKS + '/api-live.mjs';
prepareModuleCopy(
  ROOT + '/src/api.js',
  API_FILE,
  {
    './crypto.js': 'crypto.js',
    './identity.js': 'identity.js',
    './features/recovery-session.js': 'recovery-session.js',
    './body-decode.js': 'body-decode.js',
  },
  MOCKS,
  [
    ["import { invoke } from '@tauri-apps/api/core';", 'const invoke = (...a) => globalThis.__INVOKE__(...a);'],
    ['export default new ApiClient();',
     'export default new ApiClient();\nexport { urlSafeB64 as _encodeBody };'],
  ],
);
const mod = await import('file://' + API_FILE);
const encode = mod._encodeBody;
const api = new mod.ApiClient();
api.email = 'me@example.invalid';

const fold76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
const b64text = (s) => Buffer.from(s, 'utf8').toString('base64');

console.log('\nПишем (urlSafeB64): алфавит URL_SAFE_NO_PAD — как CLI/Rust:');
const bA = encode(A), bB = encode(B);
check('фикстура A: тело содержит `-` (иначе проверка алфавита — декорация)', bA.includes('-'), bA);
check('фикстура A: тело содержит `_`', bA.includes('_'), bA);
check('фикстура B: длина тела % 4 == 3 (ловит перебор padding)', bB.length % 4 === 3, bB.length);
check('ни `+`, ни `/` в теле (IMAP/SMTP-хопы читают `+` как пробел)',
  !/[+/]/.test(bA) && !/[+/]/.test(bB), { bA, bB });
check('без хвостового `=` (URL_SAFE_NO_PAD — тот же контракт, что у ядра)',
  !/=/.test(bA) && !/=/.test(bB), { tailA: bA.slice(-3), tailB: bB.slice(-3) });

console.log('\n_parseHandshakeItem: тело читает мост, классифицирует api.js:');
async function safeParse(m, body) {
  try { return { item: await api._parseHandshakeItem(m, body) }; }
  catch (e) { return { threw: e && e.message }; }
}
{
  // Стелс-письмо: ПУСТАЯ тема, вид письма — только в теле.
  const r = await safeParse({ uid: '1', folder: 'INBOX', subject: '' }, fold76(bA));
  check('письмо без темы: kind из тела, разобран gid',
    !r.threw && r.item && r.item.kind === 'group-invite' && r.item.parsed.gid === 'g-10', r);
  check('имя группы из тела дошло без mojibake',
    r.item && r.item.parsed.name === 'Тестовая группа', r.item && r.item.parsed.name);
  check('тело ушло в мост ЦЕЛИКОМ (фолдинг чинит ядро, а не JS)',
    world.decodeCalls.some(c => c.cmd === 'vault_decode_url_safe_body'
      && c.args.body === fold76(bA)), world.decodeCalls);
}
{
  const r = await safeParse({ uid: '2', folder: 'INBOX', subject: '' }, b64text('просто текст'));
  check('тело декодируется, но это не JSON → null, БЕЗ исключения',
    !r.threw && r.item === null, r);
  const r2 = await safeParse({ uid: '3', folder: 'INBOX', subject: '' }, encode({ hello: 'world' }));
  check('валидный JSON без kind → null', !r2.threw && r2.item === null, r2);
  const r3 = await safeParse({ uid: '4', folder: 'INBOX', subject: '' }, 'Это вообще не base64 !!!');
  check('мусорное тело → null, БЕЗ исключения', !r3.threw && r3.item === null, r3);
}
{
  const r = await safeParse({ uid: '5', folder: 'INBOX', subject: 'VaultGroupInvite: peer@example.invalid' }, '');
  check('legacy-маркер темы с пустым телом: kind из темы',
    !r.threw && r.item && r.item.kind === 'group-invite' && r.item.parsed === null, r);
}

console.log('\nfetchAllHandshake: чужое тело рядом не утаскивает скан:');
{
  world.cache.clear();
  world.decodeCalls = [];
  // 100 — чужое: тело декодируется в текст, но это не JSON (кандидат по
  // пустой теме). 101 — наше приглашение с фолдингом и маркером темы.
  // 102 — приглашение БЕЗ темы: вид письма только в url-safe теле.
  api._emailsSource = [
    { uid: '100', folder: 'INBOX', subject: '', date: '2026-10-20' },
    { uid: '101', folder: 'INBOX', subject: 'VaultGroupInvite: peer@example.invalid', date: '2026-10-21' },
    { uid: '102', folder: 'INBOX', subject: '', date: '2026-10-22' },
  ];
  world.batch = [
    ['100', b64text('просто текст')],
    ['101', fold76(bA)],
    ['102', bB],
  ];
  api._handshakeParsed = null; api._handshakeCache = null;
  const unmute = mute();
  const out = await api.fetchAllHandshake();
  unmute();
  check('чужое тело не утащило скан: оба приглашения в выдаче',
    out.groupInvites.length === 2, { gi: out.groupInvites.length, inv: out.invites.length });
  const byUid = (u) => out.groupInvites.find(i => String(i.uid) === u);
  check('тело из письма с переносами разобрано по полям (не только по теме)',
    byUid('101') && byUid('101').parsed
      && byUid('101').parsed.name === 'Тестовая группа'
      && byUid('101').parsed.from === 'peer@example.invalid',
    byUid('101') && byUid('101').parsed);
  check('вид письма БЕЗ темы взят из тела (url-safe, без padding)',
    byUid('102') && byUid('102').kind === 'group-invite' && byUid('102').parsed.gid === 'g-1',
    byUid('102'));
  check('чужое письмо в выдаче не появилось', out.invites.length === 0 && out.accepts.length === 0);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
