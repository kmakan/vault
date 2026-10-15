// Node-смоук src/relay-client.js — только «заявка» токена (`keep`,
// t_b8f44bdf). Паттерн остальных смоуков: подменяем Tauri-зависимости
// заглушками и переписываем импорты копии исходника. Проверяем КОНТРАКТ с
// сервером: (1) при наличии токена отправляется `keep`; (2) токен без
// `keep` (чистая установка) — как раньше; (3) заявка уходит один раз за
// запуск; (4) ответ сервера (тот же токен / новый) кладётся в kv.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;
const MOCKS = '/tmp/relay-client-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const RELAY_URL = 'https://vault-msg.ru/relay';

// ── Заглушки Tauri ─────────────────────────────────────────────
const kv = new Map();
globalThis.__kv = kv;
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'db_kv_get') return kv.has(args.key) ? kv.get(args.key) : null;
  if (cmd === 'db_kv_set') { kv.set(args.key, String(args.value)); return null; }
  return null;
};
globalThis.__fp = 'aa:bb:cc:dd:ee:ff';
globalThis.window = globalThis; // relay-client трогает window.VaultFcm (FCM-мост)

writeFileSync(MOCKS + '/core.js',
  'export const invoke = (...a) => globalThis.__invoke(...a);');
// ADR-001 Этап 2: идентичность вынесена из api.js в identity.js
// (identity.js → api/relay-client, иначе транспорт тянул api, а api
// тянул транспорт — цикл). Мок повторяет НОВУЮ форму, иначе копия
// исходника не резолвится и тест падает на импорте, а не на логике.
// ADR-001 Этап 2: транспорт тянет примитив токенов канала статическим
// импортом. Мок отдаёт детерминированные токены: тест этого смоука
// про публикацию/токены, а не про вывод capability-токенов.
writeFileSync(MOCKS + '/channels-tokens.js',
  'export const channelTokens = async () => ({ read: \'RD\', write: \'WR\' });');
writeFileSync(MOCKS + '/identity.js',
  'export const accountNamespace = (e) => globalThis.__nsOf(String(e || "").trim().toLowerCase());');
writeFileSync(MOCKS + '/api.js',
  'export const accountNamespace = (e) => globalThis.__nsOf(String(e || "").trim().toLowerCase());');
writeFileSync(MOCKS + '/crypto.js',
  'const c = { fingerprint: async () => globalThis.__fp }; export default c;');
// По умолчанию namespace = почта (legacy). Тест 8 переключает на fp:,
// чтобы воспроизвести регресс 25dd18a (from уезжал отпечатком).
globalThis.__nsOf = (e) => e;

let src = readFileSync(ROOT + '/../src/relay-client.js', 'utf8');
src = src
  .replace("from '@tauri-apps/api/core'", 'from "' + MOCKS + '/core.js"')
  .replace("from './api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from './identity.js'", 'from "' + MOCKS + '/identity.js"')
  .replace("from './channels-tokens.js'", 'from "' + MOCKS + '/channels-tokens.js"')
  .replace("import('./crypto.js')", 'import("' + MOCKS + '/crypto.js")')
  .replace("import.meta.env.VITE_RELAY_URL || ''", "''");
writeFileSync(MOCKS + '/relay-client.mjs', src);

// ── HTTP-заглушка ──────────────────────────────────────────────
const fetchCalls = [];
let respToken = 'TOK-NEW';
let respStatus = 200;
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: respStatus >= 200 && respStatus < 300,
    status: respStatus,
    json: async () => ({ token: respToken, topic: 'h' + respToken.slice(-2), exp: 9e9,
      unlimited: false, kind: 'install' }),
  };
};

const RC = await import(MOCKS + '/relay-client.mjs');
const tick = () => new Promise(r => setTimeout(r, 5));

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}
const setRelays = (list, key = 'relay-list') => kv.set(key, JSON.stringify(list));
const getRelays = () => JSON.parse(kv.get('relay-list') || '[]');
const bodyOf = (i) => JSON.parse(fetchCalls[i].opts.body);
const ours = () => getRelays().find(r => r.url === RELAY_URL);

// ── 1. reRegisterOurRelay: заявка текущего токена ──────────────
console.log('1. reRegisterOurRelay — keep текущего токена');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK-OLD', label: 'Vault' }]);
  fetchCalls.length = 0;
  respToken = 'TOK-OLD'; // сервер принял заявку → тот же токен
  const ok = await RC.reRegisterOurRelay('Me@X.ru');
  check('вернул true при 200', ok === true);
  check('адрес запроса = наш релей /register', fetchCalls[0].url === RELAY_URL + '/register', fetchCalls[0].url);
  check('keep = текущий токен', bodyOf(0).keep === 'TOK-OLD', bodyOf(0));
  check('fp отправлен', bodyOf(0).fp === 'aa:bb:cc:dd:ee:ff', bodyOf(0));
  check('ringtone отправлен', typeof bodyOf(0).ringtone === 'string' && bodyOf(0).ringtone.startsWith('https://'));
  check('токен остался тем же (адрес очереди стабилен)', ours().myToken === 'TOK-OLD', ours());
}

// ── 2. Чистая установка: keep НЕ отправляем ────────────────────
console.log('2. reRegisterOurRelay — токена нет');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: '', label: 'Vault' }]);
  fetchCalls.length = 0;
  respToken = 'TOK-NEW';
  await RC.reRegisterOurRelay('me@x.ru');
  check('keep отсутствует (нечего заявлять)', bodyOf(0).keep === undefined, bodyOf(0));
  check('новый токен записан в kv', ours().myToken === 'TOK-NEW', ours());
}

// ── 3. Сервер отказал в заявке (токен чужой) → берём новый ─────
console.log('3. reRegisterOurRelay — сервер выдал другой токен');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK-STALE', label: 'Vault' }]);
  fetchCalls.length = 0;
  respToken = 'TOK-FRESH';
  await RC.reRegisterOurRelay('me@x.ru');
  check('keep отправлен (токен был)', bodyOf(0).keep === 'TOK-STALE');
  check('ответ сервера заменяет токен', ours().myToken === 'TOK-FRESH', ours());
}

// ── 4. Список релеев и порядок сохраняются ─────────────────────
console.log('4. reRegisterOurRelay — прочие релеи не теряются');
{
  kv.clear();
  setRelays([
    { url: RELAY_URL, myToken: 'TOK-OLD', label: 'Vault' },
    { url: 'https://other.example/relay', myToken: 'TOK-OTHER', label: 'Community' },
  ]);
  fetchCalls.length = 0;
  respToken = 'TOK-OLD';
  await RC.reRegisterOurRelay('me@x.ru');
  const l = getRelays();
  check('наш релей первый, токен сохранён', l[0].url === RELAY_URL && l[0].myToken === 'TOK-OLD');
  check('чужой релей на месте', l.length === 2 && l[1].url === 'https://other.example/relay' && l[1].myToken === 'TOK-OTHER');
}

// ── 5. ensureOurRelayToken: заявка один раз за запуск ──────────
console.log('5. ensureOurRelayToken — заявка ровно один раз за запуск');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK-MINE', label: 'Vault' }]);
  fetchCalls.length = 0;
  respToken = 'TOK-MINE';
  await RC.ensureOurRelayToken('me@x.ru');
  await tick(); await tick();
  check('заявка ушла (keep = мой токен)', fetchCalls.length === 1 && bodyOf(0).keep === 'TOK-MINE', fetchCalls.length);
  const n = fetchCalls.length;
  await RC.ensureOurRelayToken('me@x.ru');
  await tick(); await tick();
  check('повторный ensure за запуск — без новой заявки', fetchCalls.length === n, fetchCalls.length);
  check('токен не изменился', ours().myToken === 'TOK-MINE', ours());
}

// ── 6. ensureOurRelayToken: чистая установка (без keep) ────────
console.log('6. ensureOurRelayToken — чистая установка');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: '', label: 'Vault' }]);
  fetchCalls.length = 0;
  respToken = 'TOK-FRESH2';
  const ok = await RC.ensureOurRelayToken('fresh@x.ru');
  await tick();
  check('ensure вернул true', ok === true);
  check('регистрация без keep', fetchCalls.length === 1 && bodyOf(0).keep === undefined, fetchCalls.length);
  check('новый токен записан', ours().myToken === 'TOK-FRESH2', ours());
}

// ── 7. ensureOurRelayToken: заявка фонов (не блокирует) ────────
console.log('7. ensureOurRelayToken — заявка фоном');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK-BG', label: 'Vault' }]);
  fetchCalls.length = 0;
  respToken = 'TOK-BG';
  const t0 = Date.now();
  await RC.ensureOurRelayToken('bg@x.ru');
  const waited = Date.now() - t0;
  check('ensure не ждёт заявку (фон)', fetchCalls.length === 0 && waited < 500, { calls: fetchCalls.length, waited });
  await tick(); await tick();
  check('заявка всё же ушла фоном', fetchCalls.length === 1 && bodyOf(0).keep === 'TOK-BG');
}

// ── 8. relayPublish: from — АДРЕС, а не namespace (регресс 25dd18a) ──
// Пир читает конверт как senderEmail(m.from) → peerKeys[from]. Если в from
// уехал fp:<…> (как делала нормализация account внутри relayPublish), адрес
// пиру незнаком → конверт, включая call_request, МОЛЧА отбрасывался:
// десктоп звонил телефону — телефон молчал; телефон звонил десктопу —
// доходило. Симметрия ломалась односторонне.
console.log('8. relayPublish — from = адрес, не fp-namespace');
{
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK-MINE', label: 'Vault' }]);
  kv.set('relay-enabled', '1');
  kv.set('relay-peer-tokens', JSON.stringify({ [RELAY_URL]: { 'peer@x.ru': 'TOK-PEER' } }));
  globalThis.__nsOf = (e) => 'fp:aa:bb:cc:dd:ee:ff'; // namespace = отпечаток
  fetchCalls.length = 0;
  await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-1' }, 'CIPHER');
  await tick(); await tick();
  const pub = fetchCalls.find(c => c.url.endsWith('/pub'));
  check('публикация ушла', !!pub, fetchCalls.map(c => c.url));
  if (pub) {
    const b = JSON.parse(pub.opts.body);
    check('from = почта отправителя (не fp:)', b.from === 'me@x.ru', b.from);
    check('to = токен получателя', b.to === 'TOK-PEER', b.to);
  }
  globalThis.__nsOf = (e) => e;
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
