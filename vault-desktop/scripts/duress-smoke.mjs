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
const invokeMock = async (cmd, args) => {
  if (cmd === 'duress_get_config') return globalThis.__duressCfg;
  if (cmd === 'duress_get_recipients') return globalThis.__duressCfg;
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
