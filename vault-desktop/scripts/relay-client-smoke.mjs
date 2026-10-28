// Node-смоук src/relay-client.js — «заявка» токена (`keep`, t_b8f44bdf) и
// разбор отказа публикации (два разных 429). Паттерн остальных смоуков:
// подменяем Tauri-зависимости заглушками и переписываем импорты копии
// исходника. Проверяем КОНТРАКТ с сервером: (1) при наличии токена
// отправляется `keep`; (2) токен без `keep` (чистая установка) — как раньше;
// (3) заявка уходит один раз за запуск; (4) ответ сервера (тот же токен /
// новый) кладётся в kv; (5) 429 суточного лимита гасит pub до полуночи UTC,
// а 429 вспышки — нет (иначе пачка сигналов звонка лишала ускорения на сутки).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { relayRejectionHandler, RELAY_DAILY_BODY, RELAY_RATE_BODY } from './lib/relay-rejection-mock.mjs';
import { bodyDecodeHandler, writeBodyDecodeAdapter } from './lib/body-decode-mock.mjs';

const ROOT = import.meta.dirname;
const MOCKS = '/tmp/relay-client-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const RELAY_URL = 'https://vault-msg.ru/relay';

// ── Заглушки Tauri ─────────────────────────────────────────────
const kv = new Map();
globalThis.__kv = kv;
// Разбор 429 — двойник ядра (scripts/lib/relay-rejection-mock.mjs): смоук
// проверяет ПРОВОДКУ (пишем ли «лимит дня»), а не текст ответа.
const reject = relayRejectionHandler();
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'db_kv_get') return kv.has(args.key) ? kv.get(args.key) : null;
  if (cmd === 'db_kv_set') { kv.set(args.key, String(args.value)); return null; }
  if (cmd === 'relay_pub_rejection') {
    // Смоук 11 воспроизводит старую сборку моста БЕЗ команды: поведение —
    // fail-open на «вспышку», а не на «лимит дня».
    if (globalThis.__rejectionBroken) throw new Error('No such command: relay_pub_rejection');
    return reject({ status: args.status, body: args.body });
  }
  // kid канала считает ядро (28.10) — двойник отвечает на channel_kid_hex.
  const body = bodyDecodeHandler(cmd, args);
  return body === undefined ? null : body;
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
writeBodyDecodeAdapter(MOCKS, "import { invoke } from './core.js';");
// По умолчанию namespace = почта (legacy). Тест 8 переключает на fp:,
// чтобы воспроизвести регресс 25dd18a (from уезжал отпечатком).
globalThis.__nsOf = (e) => e;

prepareModuleCopy(
  ROOT + '/../src/relay-client.js',
  MOCKS + '/relay-client.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    './api.js': 'api.js',
    './identity.js': 'identity.js',
    './channels-tokens.js': 'channels-tokens.js',
    './crypto.js': 'crypto.js',
    './body-decode.js': 'body-decode.js',
  },
  MOCKS,
  [
    ["import.meta.env.VITE_RELAY_URL || ''", "''"],
  ],
);

// ── HTTP-заглушка ──────────────────────────────────────────────
const fetchCalls = [];
let respToken = 'TOK-NEW';
let respStatus = 200;
// Ответ /pub задаётся отдельно (смоуки 9-11 про два разных 429): /register при
// этом остаётся успешным, иначе публикация не доходит до разбора ответа.
let pubStatus = 0;
let pubBody = '';
const setPub = (status, body) => { pubStatus = status; pubBody = body; };
const clearPub = () => { pubStatus = 0; pubBody = ''; };
// Ответ GET /turn (временные TURN-креды) задаётся отдельно: свой статус и
// своё тело, остальные роуты живут на respStatus/respToken.
let turnStatus = 0;
let turnBody = null;
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  const isTurn = /\/turn$/.test(String(url));
  if (isTurn && turnStatus) {
    return {
      ok: turnStatus >= 200 && turnStatus < 300,
      status: turnStatus,
      text: async () => '',
      json: async () => turnBody,
    };
  }
  const isPub = /\/pub$/.test(String(url));
  const status = isPub && pubStatus ? pubStatus : respStatus;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (isPub ? pubBody : ''),
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
// Запросы именно публикации (в списке fetchCalls есть ещё /register фоном).
const pubCalls = () => fetchCalls.filter(c => /\/pub$/.test(String(c.url)));

// ── 0. normalizeRelayUrl: адрес релея нормализуется ───────────
// Только https и без хвостовых слэшей: иначе «тот же» релей заводится
// дважды (https://x/ и https://x — разные ключи в kv), а токен теряется.
console.log('0. normalizeRelayUrl');
{
  check('https без хвостовых слэшей — как есть',
    RC.normalizeRelayUrl('https://relay.example/relay') === 'https://relay.example/relay');
  check('хвостовые слэши срезаются',
    RC.normalizeRelayUrl('https://relay.example/relay///') === 'https://relay.example/relay');
  check('пробелы обрезаются',
    RC.normalizeRelayUrl('  https://relay.example/relay  ') === 'https://relay.example/relay');
  check('http-релей отвергается (только https)', RC.normalizeRelayUrl('http://relay.example/relay') === null);
  check('пустой адрес отвергается', RC.normalizeRelayUrl('') === null);
}

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

// ── 9. 429 суточного лимита: релей молчит до конца UTC-дня ─────
console.log('9. relayPublish — 429 «daily relay limit» гасит pub до полуночи UTC');
{
  const publishCtx = () => {
    kv.clear();
    setRelays([{ url: RELAY_URL, myToken: 'TOK-MINE', label: 'Vault' }]);
    kv.set('relay-enabled', '1');
    kv.set('relay-peer-tokens', JSON.stringify({ [RELAY_URL]: { 'peer@x.ru': 'TOK-PEER' } }));
    fetchCalls.length = 0;
    clearPub();
  };
  publishCtx();
  setPub(429, RELAY_DAILY_BODY);
  const r = await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-d1' }, 'CIPHER');
  await tick(); await tick();
  const today = String(Math.floor(Date.now() / 86400000));
  check('why = daily-limit', r && r.why === 'daily-limit', r);
  check('UTC-день лимита записан в kv', kv.get('relay-limit-day') === today, kv.get('relay-limit-day'));
  const pubBefore = pubCalls().length;
  const r2 = await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-d2' }, 'CIPHER');
  await tick(); await tick();
  check('до конца дня pub на сервер не дёргается', pubCalls().length === pubBefore, pubCalls().length - pubBefore);
  check('и сразу отдаёт daily-limit', r2 && r2.why === 'daily-limit', r2);

  // ── 10. 429 вспышки (10 rps): релей остаётся включённым ──────
  // Тот же код, противоположный смысл: пачка сигналов звонка (setup +
  // ICE-кандидаты) — штатная вспышка. Записать её как «лимит дня» значило
  // «дозвонился — потерял ускорение до полуночи».
  console.log('10. relayPublish — 429 «rate limit» НЕ гасит релей на сутки');
  publishCtx();
  setPub(429, RELAY_RATE_BODY);
  const r3 = await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-r1' }, 'CIPHER');
  await tick(); await tick();
  check('why = rate-limit', r3 && r3.why === 'rate-limit', r3);
  check('лимит дня НЕ записан', kv.get('relay-limit-day') === undefined, kv.get('relay-limit-day'));
  clearPub();
  const r4 = await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-r2' }, 'CIPHER');
  await tick(); await tick();
  check('следующая публикация снова уходит на сервер', r4 && r4.ok === true, r4);
  check('на сервер было два pub-запроса', pubCalls().length === 2, pubCalls().length);

  // ── 11. Fail-open: без команды моста 429 = вспышка, не лимит ─
  // Старая сборка моста (команды нет) не имеет права молча выключать ускорение
  // на сутки: недооценить лимит безопасно (лишний запрос), переоценить — нет.
  console.log('11. relayPublish — разбор недоступен → считаем вспышку');
  publishCtx();
  setPub(429, RELAY_DAILY_BODY);
  globalThis.__rejectionBroken = true;
  const r5 = await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-x1' }, 'CIPHER');
  await tick(); await tick();
  check('why = rate-limit (fail-open)', r5 && r5.why === 'rate-limit', r5);
  check('лимит дня не записан при сбое разбора', kv.get('relay-limit-day') === undefined);
  globalThis.__rejectionBroken = false;
  setPub(429, '');
  const r6 = await RC.relayPublish('me@x.ru', 'peer@x.ru', { id: 'env-x2' }, 'CIPHER');
  await tick(); await tick();
  check('пустое тело 429 — тоже вспышка', r6 && r6.why === 'rate-limit', r6);
  clearPub();
}

// ── 12. fetchTurnCredentials: временные TURN-креды ─────────────
// Без relay-кандидата звонок возможен только внутри одной Wi-Fi, а телефоном
// пользуются в сети оператора. Креды выдаёт релей и живут час, поэтому
// важны четыре правила: не жечь квоту на каждый звонок (кэш), обновить до
// истечения (запас 120 с), при отказе релея НЕ срывать звонок (null = STUN),
// и не принимать битый ответ (пустые поля = null, иначе webrtc-rs падает на
// «turn server credentials required»).
console.log('12. fetchTurnCredentials — TURN-креды и их кэш');
{
  // monoNow() читает performance — подменяем часы, чтобы ловить границу
  // обновления (иначе тест ждал бы реальный час). timeOrigin НЕ нулевой:
  // monoNow трактует 0 как «нет performance» и уходит на Date.now().
  let fakeSec = 1_700_000_000;
  const realPerf = globalThis.performance;
  globalThis.performance = { timeOrigin: 1, now: () => fakeSec * 1000 };

  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK', label: 'Vault' }]);
  fetchCalls.length = 0;
  turnStatus = 200;
  turnBody = { username: (fakeSec + 3600) + ':tag', credential: 'CRED-1',
    uris: ['turn:h:3478', 'turn:h:3478?transport=tcp'], ttl: 3600 };

  const first = await RC.fetchTurnCredentials('me@x.ru');
  const turnCalls = () => fetchCalls.filter(c => /\/turn$/.test(String(c.url)));
  check('креды получены', !!first && first.credential === 'CRED-1');
  check('запрос на /relay/turn', turnCalls().length === 1 && turnCalls()[0].url === RELAY_URL + '/turn');
  check('токен в Authorization', /VaultRelay TOK/.test(JSON.stringify(Object.values(turnCalls()[0].opts.headers))));
  check('uris и username переданы как есть',
    first.uris.length === 2 && first.username === ((fakeSec + 3600) + ':tag'));

  // Повторный звонок через минуту: из кеша, без нового запроса (квота издателя).
  fakeSec += 60;
  const second = await RC.fetchTurnCredentials('me@x.ru');
  check('второй вызов взят из кеша (без запроса)',
    second.credential === 'CRED-1' && turnCalls().length === 1);

  // До истечения осталось 100 с (< запас 120) → обновляем.
  fakeSec += 3600 - 100;
  turnBody = { username: (fakeSec + 3600) + ':tag', credential: 'CRED-2',
    uris: ['turn:h:3478'], ttl: 3600 };
  const third = await RC.fetchTurnCredentials('me@x.ru');
  check('у границ запаса креды обновлены',
    third.credential === 'CRED-2' && turnCalls().length === 2);

  // Релей отказал (нет конфигурации / 401 / 429), а полученные креды ещё в
  // силе: запрос всё равно нужен (до обновления осталось меньше запаса), и
  // звонок идёт на прежней паре, а не срывается.
  fakeSec += 3540; // осталось 60 с — меньше запаса 120 с, кэш уже не отвечает сам
  turnStatus = 429;
  const stale = await RC.fetchTurnCredentials('me@x.ru');
  check('отказ релея при живых кэшированных кредах = прежние креды',
    stale && stale.credential === 'CRED-2', stale && 'null');
  check('отказ действительно был запросом', turnCalls().length === 3, turnCalls().length);

  // Креды протухли и релей отказал — null: мост останется на STUN.
  fakeSec += 3600;
  const none = await RC.fetchTurnCredentials('me@x.ru');
  check('протухшие креды + отказ = null (STUN-only)', none === null);

  // Срок читаем из ответа, а не из головы: релей вправе выдать меньше часа.
  // «Вечный» кэш отдавал бы протухшую пару, coturn её отвергает — и
  // relay-кандидата как не бывало.
  turnStatus = 200;
  turnBody = { username: (fakeSec + 60) + ':tag', credential: 'CRED-3',
    uris: ['turn:h:3478'], ttl: 60 };
  const short = await RC.fetchTurnCredentials('me@x.ru');
  check('короткий ttl из ответа принят',
    !!short && short.credential === 'CRED-3' && turnCalls().length === 5, turnCalls().length);
  fakeSec += 70;
  turnBody = { username: (fakeSec + 60) + ':tag', credential: 'CRED-4',
    uris: ['turn:h:3478'], ttl: 60 };
  const after = await RC.fetchTurnCredentials('me@x.ru');
  check('по истечении ttl креды обновлены (срок берём из ответа)',
    !!after && after.credential === 'CRED-4' && turnCalls().length === 6, turnCalls().length);

  // Без токена спрашивать нечего: запрос к /turn с пустым Authorization —
  // гарантированный 401 и зря потраченный сетевой раунд на старте звонка.
  turnStatus = 0;
  const callsBefore = turnCalls().length;
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: '', label: 'Vault' }]);
  check('без myToken запрос не уходит',
    (await RC.fetchTurnCredentials('me@x.ru')) === null && turnCalls().length === callsBefore,
    turnCalls().length - callsBefore);

  // Битый ответ (пустые поля) не уходит в мост: webrtc-rs отвергает TURN без
  // username/credential и звонок падал бы на сборке PeerConnection.
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK', label: 'Vault' }]);
  turnStatus = 200;
  turnBody = { username: '', credential: '', uris: [] };
  check('пустые поля ответа = null', (await RC.fetchTurnCredentials('me@x.ru')) === null);

  turnStatus = 503; turnBody = null;
  fakeSec += 120; // прежняя пара к этому моменту уже истекла
  kv.clear();
  setRelays([{ url: RELAY_URL, myToken: 'TOK', label: 'Vault' }]);
  check('503 (релей без TURN) = null', (await RC.fetchTurnCredentials('me@x.ru')) === null);

  globalThis.performance = realPerf;
  turnStatus = 0;
  turnBody = null;
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
