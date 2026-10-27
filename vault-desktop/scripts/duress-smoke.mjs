// Node-смоук features/duress.js — замок, декой-PIN, panic-PIN, SOS.
//
// ПОЧЕМУ СМОУКА НЕ БЫЛО. На фичу был только `duress-state-smoke` (на модуль
// состояния) — то есть ПОВЕДЕНИЕ фичи (замок, пере-арм при возврате,
// декой-PIN, panic-PIN, отправка SOS) не проверял НИКТО. Для security-critical
// фичи (декой вместо реальных данных) это unacceptable: регресс в замке
// выглядит как «приложение открылось» — заметить его можно только на живом
// устройстве.
//
// ADR-005 W2 (партия 9): модуль не читает компонент — состояние замка
// приходит узкими доступами в deps, ключи пиров — у владельца identity-store,
// email — у владельца session-store.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/duress-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки ───────────────────────────────────────────────────────────────────
const apiMock = {
  sends: [],
  loggedOut: 0,
  sendEmail: async (kind, payload) => { apiMock.sends.push({ kind, payload }); },
  logout: async () => { apiMock.loggedOut++; },
};
const cryptoMock = {
  encVault: [],
  peerKeys: [],
  setPeerPublicKey: (k) => { cryptoMock.peerKeys.push(k); },
  encryptVault: async (p) => { cryptoMock.encVault.push(p); return 'ENC:' + p; },
  loadPeerKeys: async () => cryptoMock.loadedKeys || [],
};
// Аргументы, с которыми фронт зовёт ядро по тексту SOS: контракт «какие данные
// и под какими именами» проверяется именно здесь (gate:tauri-args следит за
// camelCase, но не за тем, что доехало).
const sosTextCalls = [];
const geoPhraseCalls = [];
const invokeMock = async (cmd, args) => {
  if (cmd === 'duress_get_config') return globalThis.__duressCfg;
  if (cmd === 'duress_get_recipients') return globalThis.__duressCfg;
  // Текст SOS и фраза координат — правило ЯДРА (ADR-005 партия 5k,
  // vault-client/src/vault/duress.rs::compose_sos_text и geo_phrase). Здесь —
  // тестовый ДВОЙНИК той же функции с теми же данными канала (webview:
  // дефолт из локали, разделителя нет). При правке правила в Rust правится и
  // здесь: расхождение = смоук проверяет не то, что в проде.
  if (cmd === 'duress_sos_text') {
    sosTextCalls.push(args);
    if (globalThis.__sosTextFails) throw new Error('bridge down');
    const configured = String(args.sosText ?? '');
    const base = configured.trim() ? configured : String(args.defaultText ?? '');
    const geo = String(args.geo ?? '');
    if (!geo) return base.replaceAll('{coords}', '');
    if (base.includes('{coords}')) return base.replaceAll('{coords}', geo);
    return args.geoOn ? base + geo : base;
  }
  if (cmd === 'duress_geo_phrase') {
    geoPhraseCalls.push(args);
    if (globalThis.__geoPhraseFails) throw new Error('bridge down');
    const label = String(args.label ?? '').trim();
    const nums = `${Number(args.lat).toFixed(5)}, ${Number(args.lon).toFixed(5)}`;
    return label ? `, ${label}: ${nums}` : `, ${nums}`;
  }
  // Формат конверта — в Rust (ADR-005 W4). Здесь — ТЕСТОВЫЙ ДВОЙНИК: та же
  // таблица правил, что и в vault-client/src/vault/envelope.rs. При правке
  // формата в Rust правится и здесь (расхождение = смоук проверяет не то, что
  // в проде).
  if (cmd === 'vault_build_envelope') {
    const env = {
      vault: 1,
      id: args.id || '',
      text: args.text == null ? '' : args.text,
      name: args.name || '',
      avatar: args.avatar || '',
    };
    if (args.msgType) env.type = args.msgType;
    if (args.gavatar) env.gavatar = args.gavatar;
    env.key = args.key || '';
    env.ts = args.tsMs || 0;
    if (args.pqEk) env.pq = args.pqEk;
    if (args.tok) env.tok = args.tok;
    if (Number(args.ttlSecs) > 0) env.ttl = Number(args.ttlSecs);
    return JSON.stringify(env);
  }
  return null;
};
globalThis.__apiMock = apiMock;
globalThis.__cryptoMock = cryptoMock;
globalThis.__invokeMock = invokeMock;

writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/tauri-core.js', 'export const invoke = (...a) => globalThis.__invokeMock(...a);');
// Динамический импорт трея: подменяем на заглушку (в /tmp пакет не резолвится).
writeFileSync(MOCKS + '/event-stub.js', 'export const listen = async () => () => {};\n');

prepareModuleCopy(
  ROOT + '/src/features/duress.js',
  MOCKS + '/duress.mjs',
  {
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../envelope-rule.js': 'envelope-rule.js',
    '@tauri-apps/api/core': 'tauri-core.js',
  },
  MOCKS,
  [["import('@tauri-apps/api/event')", "import('" + MOCKS + "/event-stub.js')"]],
);
// Адаптер сборки конверта (ADR-005 W4) — настоящий файл, подменён только
// Tauri-вызов (мост → мок invokeMock).
writeFileSync(
  MOCKS + '/envelope-rule.js',
  readFileSync(ROOT + '/src/envelope-rule.js', 'utf8').replaceAll(
    "from '@tauri-apps/api/core'",
    "from './tauri-core.js'",
  ),
);

// ── DOM-заглушки: модуль слушает visibilitychange/focus ────────────────────
const listeners = { visibilitychange: [], focus: [] };
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  removeEventListener: () => {},
};
globalThis.window = {
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  removeEventListener: () => {},
};
// navigator в Node — геттер без сеттера: переопределяем через defineProperty.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' },
  configurable: true, writable: true,
});

const { checkDuressLock, onLockUnlock, onLockDuress, onLockPanic, sendDuressSos } =
  await import(MOCKS + '/duress.mjs');

const { sessionStore } = await import(ROOT + '/src/features/session-store.js');
const { identityStore } = await import(ROOT + '/src/features/identity-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Логи SOS-пути — часть проверки. Тихий отказ ровно тем и плох, что его нигде
// не видно: «не ушло ни одного письма» обязано отличаться от «ушло», и здесь
// это меряет смоук, а не человек, всматривающийся в logcat.
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    const line = a.map((x) => (x && x.message ? x.message : String(x))).join(' ');
    if (line.includes('[duress]')) logs.push(level + ': ' + line);
    orig(...a);
  };
}
const duressLogged = (re) => logs.some((l) => re.test(l));

// ── Стенд ──────────────────────────────────────────────────────────────────
const state = { locked: false, unlockedThisSession: false, pending: false, loggedOut: 0 };
function makeDeps(over = {}) {
  const deps = {
    isLocked: () => state.locked,
    setLocked: (v) => { state.locked = v; },
    isUnlockedThisSession: () => state.unlockedThisSession,
    setUnlockedThisSession: (v) => { state.unlockedThisSession = v; },
    setPending: (v) => { state.pending = v; },
    logout: () => { state.loggedOut++; },
    displayName: () => 'Максим',
    nextTick: (cb) => cb(),
  };
  return Object.assign(deps, over);
}
function resetWorld(cfg = {}) {
  state.locked = false;
  state.unlockedThisSession = false;
  state.pending = false;
  state.loggedOut = 0;
  globalThis.__duressCfg = cfg;
  sosTextCalls.length = 0;
  geoPhraseCalls.length = 0;
  globalThis.__sosTextFails = false;
  globalThis.__geoPhraseFails = false;
  apiMock.sends = [];
  apiMock.loggedOut = 0;
  cryptoMock.encVault = [];
  cryptoMock.peerKeys = [];
  cryptoMock.loadedKeys = [];
  identityStore.state.peerKeys = {};
  identityStore.state.peerPqKeys = {};
  sessionStore.setCurrentEmail('me@x.ru');
  // Слушатели НЕ сбрасываем: модуль навешивает их ОДИН раз за жизнь процесса
  // (внутренний флаг), и сброс массива оставил бы сценарий без триггера.
}

// ── 1. Замок: конфиг с hash → locked=true ────────────────────────────────
console.log('1. checkDuressLock: конфиг с hash → замок поднят');
{
  resetWorld({ lock_enabled: true, lock_hash: 'HASH' });
  await checkDuressLock(makeDeps());
  check('замок поднят', state.locked === true);
}

// ── 2. Замок выключен → locked=false ────────────────────────────────────
console.log('2. checkDuressLock: замок выключен → не блокируем');
{
  resetWorld({ lock_enabled: false, lock_hash: null });
  await checkDuressLock(makeDeps());
  check('замок не поднят', state.locked === false);
}

// ── 2b. Замок без хеша — не поднимается (недонастроенный конфиг) ────────
console.log('2b. checkDuressLock: lock_enabled без хеша → не блокируем');
{
  resetWorld({ lock_enabled: true, lock_hash: null });
  await checkDuressLock(makeDeps());
  check('без хеша пароля замок не поднят', state.locked === false, state);
}

// ── 2c. Android: свой замок не показываем (нативный LockActivity) ──────
console.log('2c. checkDuressLock: Android-ветка — свой замок не поднимаем');
{
  resetWorld({ lock_enabled: true, lock_hash: 'HASH' });
  // Android WebView: userAgent с 'Android'.
  const realNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120' },
    configurable: true,
  });
  await checkDuressLock(makeDeps());
  Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true });
  check('на Android свой замок не показывается', state.locked === false, state);
}

// ── 3. Пере-арм при возврате в приложение (visibilitychange) ────────────
console.log('3. relock: уход в фон снимает «разблокирован в сессии», возврат — армит');
{
  resetWorld({ lock_enabled: true, lock_hash: 'HASH' });
  await checkDuressLock(makeDeps());
  onLockUnlock(makeDeps());
  check('разблокировано в сессии', state.locked === false && state.unlockedThisSession === true);
  // Уход в фон: доверенный период кончился.
  globalThis.document.visibilityState = 'hidden';
  for (const fn of listeners.visibilitychange) fn();
  check('уход в фон снял флаг сессии', state.unlockedThisSession === false);
  // Возврат: замок армится заново.
  globalThis.document.visibilityState = 'visible';
  for (const fn of listeners.visibilitychange) fn();
  await new Promise((r) => setTimeout(r, 20));
  check('возврат в приложение → замок снова поднят', state.locked === true, state);
}

// ── 4. Декой-PIN: обычный вход + тихий SOS ─────────────────────────────
console.log('4. onLockDuress: декой-режим + отправка SOS');
{
  resetWorld({ lock_enabled: true, lock_hash: 'HASH', sos_recipients: ['peer@x.ru'], sos_text: 'SOS {coords}' });
  identityStore.state.peerKeys = { 'peer@x.ru': 'PUB' };
  // Замок УЖЕ поднят (пользователь на экране блокировки) — иначе «снят» нечего
  // проверять: состояние по умолчанию false.
  state.locked = true;
  onLockDuress(makeDeps());
  check('замок снят (декой — как обычный вход)', state.locked === false, state);
  check('SOS помечен как pending', state.pending === true);
  await new Promise((r) => setTimeout(r, 20));
  check('SOS-письмо отправлено получателю',
    apiMock.sends.length === 1 && apiMock.sends[0].payload.to === 'peer@x.ru', apiMock.sends);
  const body = apiMock.sends.length ? JSON.parse(cryptoMock.encVault[0]) : {};
  check('конверт SOS: vault:1 + type=sos + текст (без плейсхолдера) + имя',
    body.vault === 1 && body.type === 'sos' && body.text.startsWith('SOS')
    && !body.text.includes('{coords}') && body.name === 'Максим', body);
  check('pending сброшен после отправки', state.pending === false);
  // Учёт-отправки: успешный проход обязан быть записан как успех и НЕ как отказ.
  check('успех записан в лог, ложного отказа нет',
    duressLogged(/^log: \[duress\] SOS sent to 1/) && !duressLogged(/не дошёл/), logs.slice(-3));
}

// ── 5. SOS без peer-ключа — получатель пропущен, не роняем остальных ────
console.log('5. sendDuressSos: без peer-ключа получатель пропускается');
{
  resetWorld({ sos_recipients: ['peer@x.ru'], sos_text: 'SOS' });
  identityStore.state.peerKeys = {};
  await sendDuressSos(makeDeps());
  check('письмо не отправлено (нет ключа)', apiMock.sends.length === 0, apiMock.sends);
  check('pending сброшен даже без успеха', state.pending === false);
  // До 25.10 здесь печаталось «SOS sent to 1 recipients» при нулевой отправке.
  check('нулевая доставка записана как ошибка, а не как отправка',
    duressLogged(/^error: \[duress\] SOS не дошёл ни до одного из 1/), logs.slice(-3));
}

// ── 5b. Получатели не настроены: громко в журнал, человеку — по-прежнему тишина ──
console.log('5b. sendDuressSos: получатели не настроены');
{
  resetWorld({ sos_recipients: [], sos_text: 'SOS' });
  const before = logs.length;
  await sendDuressSos(makeDeps());
  check('ни одного письма не отправлено', apiMock.sends.length === 0, apiMock.sends);
  check('отсутствие получателей записано как ошибка',
    logs.slice(before).some((l) => /^error: .*НЕ ОТПРАВЛЕН: получатели не настроены/.test(l)),
    logs.slice(before));
  check('человек ничего не увидел: без тоста и без смены экрана', state.pending === false && !state.locked);
}

// ── 5c. Частичная доставка: сколько ушло, а сколько — нет ────────────────
console.log('5c. sendDuressSos: один получатель без ключа, второй доставлен');
{
  resetWorld({ sos_recipients: ['peer@x.ru', 'other@x.ru'], sos_text: 'SOS' });
  identityStore.state.peerKeys = { 'other@x.ru': 'PUB' };
  await sendDuressSos(makeDeps());
  check('доставка состоялась только туда, где был ключ',
    apiMock.sends.length === 1 && apiMock.sends[0].payload.to === 'other@x.ru', apiMock.sends);
  check('частичная записана как частичная, а не как полный успех',
    duressLogged(/^warn: \[duress\] SOS ушёл 1 из 2, не ушёл: peer@x\.ru/), logs.slice(-3));
}

// ── 5d. Текст SOS: правило в ядре, фронт — только данные (ADR-005 5k) ───
console.log('5d. sendDuressSos: текст письма собирает ядро');
{
  // geolocation stub: позиция всегда одна и та же, ответ немедленный.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'smoke',
      geolocation: {
        getCurrentPosition: (ok) => ok({ coords: { latitude: 55.7515099, longitude: 37.6155 } }),
      },
    },
    configurable: true, writable: true,
  });
  resetWorld({ sos_recipients: ['peer@x.ru'], sos_text: 'Телефон не у меня{coords}', sos_geo: true });
  identityStore.state.peerKeys = { 'peer@x.ru': 'PUB' };
  await sendDuressSos(makeDeps());
  const body = apiMock.sends.length ? JSON.parse(cryptoMock.encVault[0]) : {};
  check('письмо ушло', apiMock.sends.length === 1, apiMock.sends);
  check('текст собран ядром: плейсхолдер занят фразой координат',
    body.text === 'Телефон не у меня, sos_coords_label: 55.75151, 37.61550', body);
  check('фронт передаёт ядру данные канала, а не решает сам',
    sosTextCalls.length === 1
    && sosTextCalls[0].sosText === 'Телефон не у меня{coords}'
    && sosTextCalls[0].defaultText === 'sos_default'
    && sosTextCalls[0].geoOn === true
    && typeof sosTextCalls[0].geo === 'string', sosTextCalls);
  check('подпись координат берётся из локали (не литерал во фронте)',
    geoPhraseCalls.length === 1 && geoPhraseCalls[0].label === 'sos_coords_label'
    && geoPhraseCalls[0].lat === 55.7515099 && geoPhraseCalls[0].lon === 37.6155, geoPhraseCalls);

  // Настраиваемого текста нет → дефолт подставляет ядро, фронт его не ищет.
  resetWorld({ sos_recipients: ['peer@x.ru'], sos_text: '', sos_geo: false });
  identityStore.state.peerKeys = { 'peer@x.ru': 'PUB' };
  await sendDuressSos(makeDeps());
  check('пустая настройка получает дефолт из локали, а не заглушку из JS',
    JSON.parse(cryptoMock.encVault[0]).text === 'sos_default', JSON.parse(cryptoMock.encVault[0]));

  // Гео включено, плейсхолдера в тексте нет → хвост дописывает ядро, флаг
  // доехал до него как данные, а не как решение фронта.
  resetWorld({ sos_recipients: ['peer@x.ru'], sos_text: 'Помоги', sos_geo: true });
  identityStore.state.peerKeys = { 'peer@x.ru': 'PUB' };
  await sendDuressSos(makeDeps());
  check('без плейсхолдера координаты дописаны ядром (флаг geoOn доехал)',
    JSON.parse(cryptoMock.encVault[0]).text === 'Помоги, sos_coords_label: 55.75151, 37.61550'
    && sosTextCalls[0].geoOn === true, JSON.parse(cryptoMock.encVault[0]));

  // Отказ ядра: текст НЕ собирается на месте — письмо уходит без него, но  // уходит (метку type:"sos" получатель читает и так), и отказ записан.
  resetWorld({ sos_recipients: ['peer@x.ru'], sos_text: 'Свой текст', sos_geo: false });
  globalThis.__sosTextFails = true;
  identityStore.state.peerKeys = { 'peer@x.ru': 'PUB' };
  const before = logs.length;
  await sendDuressSos(makeDeps());
  check('при отказе ядра письмо всё равно отправлено', apiMock.sends.length === 1, apiMock.sends);
  check('при отказе ядра текст пустой — локальной копии правила нет',
    JSON.parse(cryptoMock.encVault[0]).text === '', JSON.parse(cryptoMock.encVault[0]));
  check('отказ ядра записан громко',
    logs.slice(before).some((l) => /^error: \[duress\] SOS: ядро не собрало текст/.test(l)),
    logs.slice(before));

  // Отказ фразы координат: письмо уходит с текстом, но без места.
  resetWorld({ sos_recipients: ['peer@x.ru'], sos_text: 'Помоги{coords}', sos_geo: true });
  globalThis.__geoPhraseFails = true;
  identityStore.state.peerKeys = { 'peer@x.ru': 'PUB' };
  await sendDuressSos(makeDeps());
  check('без фразы координат письмо уходит с текстом и без плейсхолдера',
    apiMock.sends.length === 1 && JSON.parse(cryptoMock.encVault[0]).text === 'Помоги',
    JSON.parse(cryptoMock.encVault[0]));
}

// ── 6. Panic-PIN: данные стёрты, выход на login ─────────────────────────
console.log('6. onLockPanic: api.logout + email очищен');
{
  resetWorld({ lock_enabled: true, lock_hash: 'HASH' });
  sessionStore.setCurrentEmail('me@x.ru');
  await onLockPanic(makeDeps());
  check('замок снят', state.locked === false);
  check('api.logout вызван (Rust стёр данные)', apiMock.loggedOut === 1, apiMock.loggedOut);
  check('email аккаунта очищен (локально пусто)', !sessionStore.getCurrentEmail(), sessionStore.getCurrentEmail());
  check('сессия сброшена', state.loggedOut === 1, state.loggedOut);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
