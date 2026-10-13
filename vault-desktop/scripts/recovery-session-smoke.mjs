// Node-смоук устойчивости восстановления (fix/recovery-resilience).
// Паттерн recovery-smoke: без Vue/Tauri, живые модули (не копия алгоритма).
//
//   • api.js импортируется через data:URI с заменой внешних импортов
//     ('@tauri-apps/api/core' → mock invoke, './crypto.js' → mock) — все
//     остальные строки модуля исполняются как в проде. Никаких реальных
//     secret-invoke: мок не знает команд, которых не ждёт.
//   • features/recovery.js импортируется напрямую, зависимости
//     { api, crypto, invoke, db, relay, ... } инъектируются.
//   • features/recovery-session.js — pure-модуль, тестируется напрямую.
//   • App.vue проверяется через @vue/compiler-sfc (методы реальны, делегат
//     вызывает функцию, guard достижим) — как check-template.cjs.
//
// Все данные искусственные (fake@example.invalid), файлов пользователя и
// сети нет. Тесты детерминированы, без таймеров и обратных вызовов с
// состоянием результата. Гейт t_b5da2e97.
import { readFileSync } from 'node:fs';
import { parse as sfcParse, compileScript } from '@vue/compiler-sfc';

const ROOT = import.meta.dirname + '/..';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
// Тишина логов шагов (содержимого нет, только шум).
function mute() {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return () => { console.log = l; console.warn = w; console.error = e; };
}

// ══════════════════════════════════════════════════════════════════
// 1) Общий fake localStorage + загрузчик живого api.js через data:URI
// ══════════════════════════════════════════════════════════════════
// Маркер — ОБЩАЯ модель storage: переживает пересоздание ApiClient, поэтому
// можно доказать «новый ApiClient видит marker и не делает авто-вход».
const store = new Map();
function freshStore() { store.clear(); }
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// Счётчики invoke — общие, чтобы проверять «0 commit/creds/генерации» при
// провалах и точный порядок при успехе.
function makeInvoke(cfg) {
  const calls = { log: [], counters: {} };
  const bump = (name) => { calls.counters[name] = (calls.counters[name] || 0) + 1; };
  const impl = async (cmd, args) => {
    calls.log.push({ cmd, args });
    switch (cmd) {
      case 'email_connect': bump('email_connect'); return true;
      case 'load_credentials':
        bump('load_credentials');
        if (cfg.loadCreds === 'THROW') throw new Error('creds down');
        return cfg.creds || null;
      case 'save_credentials':
        bump('save_credentials');
        if (cfg.saveCreds === 'THROW') throw new Error('save boom');
        return true;
      case 'delete_credentials': bump('delete_credentials'); return true;
      case 'email_logout': bump('email_logout'); return true;
      case 'email_fetch_list': bump('email_fetch_list'); return cfg.list || [];
      case 'import_backup':
        bump('import_backup');
        if (cfg.importBackup === 'THROW') throw new Error('import boom');
        return true;
      case 'db_account_namespace': return cfg.namespace || 'fp:deadbeef';
      default:
        bump(cmd); // migrate/kv/db и прочее — молчаливый успех, но фиксируем
        return undefined;
    }
  };
  return { impl, calls };
}

let __loadSeq = 0; // бастим кэш data-URI модуля Node на каждый loadApi
async function loadApi(cfg) {
  cfg = cfg || {};
  const { impl, calls } = makeInvoke(cfg);
  globalThis.__INVOKE__ = async (cmd, args) => impl(cmd, args);
  globalThis.__CRYPTO__ = {
    default: {
      initFromStorage: async () => (cfg.storedKey
        ? { loaded: true, keypair: { public_key: 'pk-restored' } }
        : { loaded: false }),
      generateKeypair: async () => {
        cfg.genCount = (cfg.genCount || 0) + 1;
        return { public_key: 'pk-new' };
      },
      saveToStorage: async () => {},
      fingerprint: async () => 'fp-restored',
    },
  };
  const src = readFileSync(ROOT + '/src/api.js', 'utf8')
    .replace("import { invoke } from '@tauri-apps/api/core';", 'const invoke = globalThis.__INVOKE__;')
    .replace("import cryptoClient from './crypto.js';", 'const cryptoClient = globalThis.__CRYPTO__;')
    .replace("from './features/recovery-session.js'", `from '${new URL('../src/features/recovery-session.js', import.meta.url).href}'`);
  // Уникальная строка-комментарий меняет base64 → Node не переиспользует
  // закэшированный модуль (иначе invoke/cryptoClient привязались бы к
  // ПЕРВОМУ loadApi и счётчики calls были бы чужими).
  const uri = 'data:text/javascript;base64,'
    + Buffer.from('// loadApi #' + (++__loadSeq) + '\n' + src, 'utf8').toString('base64');
  return { mod: await import(uri), calls };
}

// ══════════════════════════════════════════════════════════════════
// 2) api.login — совместимость обычного входа + deferPersistence
// ══════════════════════════════════════════════════════════════════
console.log('\napi.login — обычный вход и режим восстановления:');
{
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const unmute = mute();
  await api.login('a@b.invalid', 'pw', { remember: true });
  unmute();
  check('обычный вход пишет vault-token (совместимость сохранена)',
    localStorage.getItem('vault-token') === 'serverless-a@b.invalid');
  check('обычный вход пишет vault-email',
    localStorage.getItem('vault-email') === 'a@b.invalid');
  check('обычный вход remember:true → save_credentials ровно 1',
    (calls.counters.save_credentials || 0) === 1);
}
{
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const unmute = mute();
  await api.login('a@b.invalid', 'pw', { remember: true, deferPersistence: true });
  unmute();
  check('deferPersistence: durable token НЕ пишется',
    localStorage.getItem('vault-token') === null);
  check('deferPersistence: durable email НЕ пишется',
    localStorage.getItem('vault-email') === null);
  check('deferPersistence: save_credentials 0',
    (calls.counters.save_credentials || 0) === 0);
  check('deferPersistence: сессия живёт в памяти (email/token)',
    api.email === 'a@b.invalid' && api.token === 'serverless-a@b.invalid');
}

// ══════════════════════════════════════════════════════════════════
// 3) commitRecoveryLogin — remember + снятие маркера последним
// ══════════════════════════════════════════════════════════════════
console.log('\ncommitRecoveryLogin:');
{
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const unmute = mute();
  await api.login('a@b.invalid', 'pw', { remember: false, deferPersistence: true });
  await api.commitRecoveryLogin({ remember: false });
  unmute();
  check('commit remember:false → creds 0, durable вход зафиксирован',
    (calls.counters.save_credentials || 0) === 0 &&
    localStorage.getItem('vault-token') === 'serverless-a@b.invalid' &&
    localStorage.getItem('vault-email') === 'a@b.invalid');
}
{
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const unmute = mute();
  await api.login('a@b.invalid', 'pw', { remember: true, deferPersistence: true });
  localStorage.setItem('vault-recovery-pending', '1'); // маркер стоял
  await api.commitRecoveryLogin({ remember: true });
  unmute();
  check('commit remember:true → save_credentials ровно 1',
    (calls.counters.save_credentials || 0) === 1);
  check('commit снимает маркер ПОСЛЕДНИМ',
    localStorage.getItem('vault-recovery-pending') === null);
}
{
  // save_credentials падает → commit бросает, маркер НЕ снят.
  freshStore();
  const { mod } = await loadApi({ saveCreds: 'THROW' });
  const api = new mod.ApiClient();
  const unmute = mute();
  await api.login('a@b.invalid', 'pw', { remember: true, deferPersistence: true });
  localStorage.setItem('vault-recovery-pending', '1');
  let threw = false;
  try { await api.commitRecoveryLogin({ remember: true }); } catch { threw = true; }
  unmute();
  check('save_credentials упал → commit бросает', threw);
  check('сбой save_credentials → маркер НЕ снят',
    localStorage.getItem('vault-recovery-pending') === '1');
}

{
  freshStore();
  const { mod } = await loadApi({});
  const api = new mod.ApiClient();
  await api.login('a@b.invalid', 'pw', { remember: false, deferPersistence: true });
  localStorage.setItem('vault-recovery-pending', '1');
  const remove = localStorage.removeItem;
  localStorage.removeItem = () => {};
  let threw = false;
  try { await api.commitRecoveryLogin({ remember: false }); } catch { threw = true; }
  localStorage.removeItem = remove;
  check('marker remove no-op: commit не подтверждён, restart остаётся заблокирован',
    threw && localStorage.getItem('vault-recovery-pending') === '1');
}


// ══════════════════════════════════════════════════════════════════
// 4) Маркер блокирует авто-вход: конструктор + restoreSession
// ══════════════════════════════════════════════════════════════════
console.log('\nмаркер блокирует авто-вход (новый ApiClient + restoreSession):');
{
  freshStore();
  localStorage.setItem('vault-token', 'serverless-old@b.invalid');
  localStorage.setItem('vault-email', 'old@b.invalid');
  const { mod } = await loadApi({});
  localStorage.setItem('vault-recovery-pending', '1'); // прерванное восстановление
  const api = new mod.ApiClient();
  check('конструктор при маркере игнорирует persisted token', api.token === null);
  check('конструктор при маркере игнорирует persisted email', api.email === null);
  const unmute = mute();
  const restored = await api.restoreSession();
  unmute();
  check('restoreSession при маркере → false', restored === false);
}
{
  // Маркер стоит, credentials на диске есть: restoreSession возвращает false
  // ДО load_credentials и НЕ удаляет их.
  freshStore();
  localStorage.setItem('vault-recovery-pending', '1');
  const cfg = { creds: { email: 'old@b.invalid', password: 'pw', imap_server: 'i', imap_port: 993, smtp_server: 's', smtp_port: 587 } };
  const { mod, calls } = await loadApi(cfg);
  const api = new mod.ApiClient();
  const unmute = mute();
  const restored = await api.restoreSession();
  unmute();
  check('restoreSession при маркере не вызывает load_credentials',
    (calls.counters.load_credentials || 0) === 0 && restored === false);
  check('restoreSession при маркере НЕ удаляет credentials',
    (calls.counters.delete_credentials || 0) === 0);
}

// ══════════════════════════════════════════════════════════════════
// 5) abandonSessionMemory — память без logout/delete_credentials
// ══════════════════════════════════════════════════════════════════
console.log('\nabandonSessionMemory (провал не трогает creds/токены):');
{
  freshStore();
  localStorage.setItem('vault-token', 'serverless-old@b.invalid');
  localStorage.setItem('vault-email', 'old@b.invalid');
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const unmute = mute();
  await api.login('a@b.invalid', 'pw', { remember: false, deferPersistence: true });
  localStorage.setItem('vault-recovery-pending', '1');
  api.abandonSessionMemory();
  unmute();
  check('abandonSessionMemory чистит RAM сессии',
    api.email === null && api.token === null && api.connected === false);
  check('abandonSessionMemory НЕ вызывает delete_credentials',
    (calls.counters.delete_credentials || 0) === 0);
  check('abandonSessionMemory НЕ трогает localStorage токены',
    localStorage.getItem('vault-token') === 'serverless-old@b.invalid' &&
    localStorage.getItem('vault-email') === 'old@b.invalid');
  check('abandonSessionMemory оставляет маркер на месте',
    localStorage.getItem('vault-recovery-pending') === '1');
}

// ══════════════════════════════════════════════════════════════════
// 6) recovery-session.js — pure маркер
// ══════════════════════════════════════════════════════════════════
console.log('\nrecovery-session.js (pure маркер):');
{
  const RS = await import(ROOT + '/src/features/recovery-session.js');
  check('ключ маркера совпадает с тем, что проверяет api.js',
    RS.RECOVERY_MARKER_KEY === 'vault-recovery-pending');
  freshStore();
  check('по умолчанию маркера нет', RS.isRecoveryPending() === false);
  RS.markRecoveryPending();
  check('после mark — pending', RS.isRecoveryPending() === true);
  check('blockMessage при pending — переведённая строка',
    RS.recoveryBlockMessage((k) => 'MSG:' + k) === 'MSG:recovery_interrupted');
  RS.clearRecoveryPending();
  check('после clear — не pending, blockMessage null',
    RS.isRecoveryPending() === false && RS.recoveryBlockMessage((k) => 'x') === null);
}

// ══════════════════════════════════════════════════════════════════
// 7) RecoveryFeature.loginWithRecovery — живой поток (fix/resilience)
// ══════════════════════════════════════════════════════════════════
// Живой features/recovery.js + живой ApiClient (data-URI). ctx — шпион,
// записывающий порядок действий; зависимости инъектируются.
console.log('\nRecoveryFeature.loginWithRecovery — поток:');
const RF = await import(ROOT + '/src/features/recovery.js');
const VALID_BACKUP = JSON.stringify({ version: 1, keys: { keypair: {
  public_key: '1'.repeat(64), private_key: '2'.repeat(64), created_at: '1970-01-01T00:00:00Z',
}, peer_keys: [] } });

// Marker write failure must stop before any connection or disk import.
{
  freshStore();
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('storage unavailable'); };
  const { ctx, deps, order } = makeFlow({});
  await RF.loginWithRecovery(ctx, deps);
  localStorage.setItem = original;
  check('сбой marker: видимая ошибка и 0 connect/import',
    ctx.loginError === 'T:recovery_state_unavailable' && order.length === 0 && !ctx.isLoggedIn);
}

function makeFlow(cfg) {
  cfg = cfg || {};
  const order = [];
  const cryptoMock = {
    recoveryValidateMnemonic: async () => cfg.validMnemonic !== false,
    recoveryParseEscrowEmail: async (body) => {
      order.push('parse');
      if (body === 'PARSE-THROW') throw new Error('parse boom');
      if (body === 'NON-ESCROW') return null;
      if (body === 'WRONG') return 'WRAPPED-WRONG';
      return 'WRAPPED-GOOD';
    },
    recoveryUnwrapBackup: async (wrapped) => {
      order.push('unwrap');
      if (wrapped === 'WRAPPED-WRONG') throw new Error('wrong key');
      return VALID_BACKUP;
    },
    // Не должны вызываться в recovery-потоке (генерация запрещена).
    generateKeypair: async () => { order.push('GENERATE'); return { public_key: 'pk' }; },
  };
  const apiMock = {
    fetchEmails: async () => {
      order.push('fetchEmails');
      if (cfg.fetch === 'THROW') throw new Error('fetch down');
      return cfg.msgs || [{ folder: 'INBOX', uid: '1', subject: '' }];
    },
  };
  const invokeMock = async (cmd, args) => {
    order.push('invoke:' + cmd);
    if (cmd === 'email_fetch_bodies') {
      if (cfg.bodies === 'THROW') throw new Error('bodies down');
      return cfg.bodiesList || [['1', cfg.body || 'GOOD']];
    }
    if (cmd === 'import_backup') {
      if (cfg.importBackup === 'THROW') throw new Error('import boom');
      return true;
    }
    return undefined;
  };
  const ctx = {
    recoveryWordsInput: cfg.words || 'word word word',
    email: 'restore@example.invalid',
    password: 'pw',
    rememberMe: cfg.remember !== false,
    imapServer: '', imapPort: '', smtpServer: '', smtpPort: '',
    recoveryFileJson: cfg.fileJson || '',
    loginLoading: false, loginError: '', isLoggedIn: false, userId: null,
    ecoMode: false, relayEnabled: false,
    initCalls: [],
    initCrypto: async (opts) => {
      order.push('initCrypto:' + JSON.stringify(opts));
      ctx.initCalls.push(opts);
      ctx.publicKey = cfg.otherKey ? '3'.repeat(64) : '1'.repeat(64);
      return cfg.keyLoaded !== false;
    },
    initLocalDb: async () => order.push('initLocalDb'),
    loadUnreadCounts: () => order.push('loadUnreadCounts'),
    loadLocalProfiles: () => order.push('loadLocalProfiles'),
    loadBodyCache: async () => order.push('loadBodyCache'),
    loadContacts: async () => order.push('loadContacts'),
    loadGroups: async () => order.push('loadGroups'),
    loadChannels: async () => order.push('loadChannels'),
    onEcoMode: () => { order.push('onEcoMode'); return Promise.resolve(); },
    startPolling: () => order.push('startPolling'),
    startRelayTicker: () => order.push('startRelayTicker'),
    idleLoop: () => order.push('idleLoop'),
    loadEmails: () => { order.push('loadEmails'); return Promise.resolve(); },
    showToast: (m) => order.push('toast:' + m),
  };
  const deps = {
    api: apiMock,
    crypto: cryptoMock,
    invoke: invokeMock,
    db: { kvGet: async () => null, kvSet: async () => {} },
    relay: { getSettings: async () => ({ enabled: false }) },
    RelayFeature: { syncEcoWithRelay: async () => {} },
    initNotifications: async () => {},
    t: (k) => 'T:' + k,
  };
  return { ctx, deps, order };
}

// Успех через эскроу: порядок, marker снят, gen=0, commit учтён.
{
  freshStore();
  const cfg = { remember: false };
  const { mod } = await loadApi({});
  const api = new mod.ApiClient();
  const { ctx, deps, order } = makeFlow(cfg);
  deps.api = Object.assign(api, deps.api); // живой ApiClient + наш fetchEmails
  const unmute = mute();
  await RF.loginWithRecovery(ctx, deps);
  unmute();
  check('успех: isLoggedIn true, loginLoading false, loginError пуст',
    ctx.isLoggedIn === true && ctx.loginLoading === false && ctx.loginError === '');
  check('успех: marker снят (vault-recovery-pending отсутствует)',
    localStorage.getItem('vault-recovery-pending') === null);
  check('успех: initCrypto вызван с allowCreate:false (перезагрузка, не генерация)',
    ctx.initCalls.length === 1 && ctx.initCalls[0].allowCreate === false);
  check('успех: генерация новой пары НЕ вызывалась',
    !order.includes('GENERATE'));
  check('успех: remember:false → save_credentials НЕ вызван при входе',
    !order.some((o) => o === 'invoke:save_credentials'));
  check('успех: durable вход закоммичен (vault-token/vault-email записаны)',
    localStorage.getItem('vault-token') === 'serverless-restore@example.invalid' &&
    localStorage.getItem('vault-email') === 'restore@example.invalid');
  const idxImport = order.indexOf('invoke:import_backup');
  const idxInit = order.indexOf('initCrypto:{"allowCreate":false}');
  const idxPoll = order.indexOf('startPolling');
  const idxInitDb = order.indexOf('initLocalDb');
  check('успех: порядок import → initCrypto → (commit) → startPolling',
    idxImport >= 0 && idxInit > idxImport && idxPoll > idxInit);
  check('успех: initLocalDb после коммита (после initCrypto)',
    idxInitDb > idxInit);
}
// Успех через эскроу remember:true → save_credentials ровно 1, ПОСЛЕ import.
{
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const { ctx, deps } = makeFlow({ remember: true });
  deps.api = Object.assign(api, deps.api);
  const unmute = mute();
  await RF.loginWithRecovery(ctx, deps);
  unmute();
  check('успех remember:true → save_credentials ровно 1',
    (calls.counters.save_credentials || 0) === 1);
  check('успех remember:true → save_credentials ПОСЛЕ import_backup',
    calls.log.findIndex((c) => c.cmd === 'import_backup') <
    calls.log.findIndex((c) => c.cmd === 'save_credentials'));
}

// Провалы: fetch down / escrow не найден / foreign-only / import reject /
// missing restored key → loginLoading false, isLoggedIn false, переведённая
// ошибка, marker уцелел (переживает новый ApiClient + restoreSession), 0
// commit/save/generate.
async function expectFailure(label, cfg, expectError) {
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  // Предсуществующие durable creds/токены (как у реального пользователя).
  localStorage.setItem('vault-token', 'serverless-old@b.invalid');
  localStorage.setItem('vault-email', 'old@b.invalid');
  const { ctx, deps, order } = makeFlow(cfg);
  deps.api = Object.assign(api, deps.api);
  const unmute = mute();
  await RF.loginWithRecovery(ctx, deps);
  unmute();
  const okErr = ctx.loginError === expectError;
  check(label + ': loginLoading false, isLoggedIn false, ошибка ' + expectError,
    ctx.loginLoading === false && ctx.isLoggedIn === false && okErr, ctx.loginError);
  check(label + ': 0 durable-commit (vault-token не перезаписан на restore@)',
    localStorage.getItem('vault-token') === 'serverless-old@b.invalid');
  check(label + ': 0 save_credentials', (calls.counters.save_credentials || 0) === 0);
  check(label + ': 0 генерации новой пары', !order.includes('GENERATE'));
  check(label + ': 0 initLocalDb (пост-вход не начат)', !order.includes('initLocalDb'));
  // marker уцелел → новый ApiClient видит его и restoreSession = false.
  check(label + ': marker уцелел', localStorage.getItem('vault-recovery-pending') === '1');
  const api2 = new mod.ApiClient();
  check(label + ': новый ApiClient при marker игнорирует persisted token',
    api2.token === null);
  const u2 = mute();
  const restored = await api2.restoreSession();
  u2();
  check(label + ': restoreSession при marker → false, load_credentials 0',
    restored === false && (calls.counters.load_credentials || 0) === 0);
  check(label + ': старые durable creds/токены не тронуты',
    localStorage.getItem('vault-email') === 'old@b.invalid' &&
    (calls.counters.delete_credentials || 0) === 0);
  return { order, ctx };
}

console.log('\nRecoveryFeature.loginWithRecovery — провалы (marker уцелел):');
await expectFailure('fetch down', { fetch: 'THROW' }, 'fetch down');
await expectFailure('escrow не найден (пустой ящик)', { msgs: [] }, 'T:recovery_not_found');
await expectFailure('foreign-only (unwrap чужой)', { bodiesList: [['1', 'WRONG']] }, 'T:recovery_not_found');
await expectFailure('import reject (эскроу)', { importBackup: 'THROW' }, 'import boom');
{
  // missing restored key: import ок, но initCrypto({allowCreate:false})=false.
  const { order } = await expectFailure('missing restored key', { keyLoaded: false }, 'T:recovery_missing_keys');
  check('missing restored key: initCrypto вызван с allowCreate:false',
    order.includes('initCrypto:{"allowCreate":false}'));
  check('missing restored key: commit НЕ вызван (нет durable token/email для restore@)',
    !order.some((o) => o.startsWith('invoke:save_credentials')));
}
// Файл: import rejection → escrow НЕ пробуем (нет фолбэка). fetchEmails=0.
{
  freshStore();
  const { mod } = await loadApi({});
  const api = new mod.ApiClient();
  const { ctx, deps, order } = makeFlow({ fileJson: VALID_BACKUP, importBackup: 'THROW' });
  deps.api = Object.assign(api, deps.api);
  const unmute = mute();
  await RF.loginWithRecovery(ctx, deps);
  unmute();
  check('файл import reject → ошибка в UI', ctx.loginError === 'import boom');
  check('файл import reject → escrow НЕ пробуем (fetchEmails 0)',
    !order.includes('fetchEmails'));
  check('файл import reject → marker уцелел',
    localStorage.getItem('vault-recovery-pending') === '1');
  check('файл import reject → isLoggedIn false, loading false',
    ctx.isLoggedIn === false && ctx.loginLoading === false);
}
// Битый JSON файла — падает видимо (не молчаливый фолбэк на эскроу).
{
  freshStore();
  const { mod } = await loadApi({});
  const api = new mod.ApiClient();
  const { ctx, deps, order } = makeFlow({ fileJson: '{}' });
  deps.api = Object.assign(api, deps.api);
  await RF.loginWithRecovery(ctx, deps);
  check('backup без keypair: 0 import, старый ключ не считается восстановленным',
    !ctx.isLoggedIn && ctx.loginError.startsWith('Invalid recovery backup') &&
    !order.includes('invoke:import_backup') && !order.some(o => o.startsWith('initCrypto:')));
}
await expectFailure('дисковый ключ не совпал с backup', { otherKey: true }, 'T:recovery_missing_keys');
{
  freshStore();
  const { mod } = await loadApi({});
  const api = new mod.ApiClient();
  const { ctx, deps, order } = makeFlow({ fileJson: '{ not json' });
  deps.api = Object.assign(api, deps.api);
  const unmute = mute();
  await RF.loginWithRecovery(ctx, deps);
  unmute();
  check('битый JSON файла → видимая ошибка (loginError непуст)',
    typeof ctx.loginError === 'string' && ctx.loginError.length > 0);
  check('битый JSON файла → escrow НЕ пробуем (нет молчаливого фолбэка)',
    !order.includes('fetchEmails'));
  check('битый JSON файла → isLoggedIn false', ctx.isLoggedIn === false);
}
// Прерывание между connect и import + смоделированная перезагрузка:
// маркер ставится ДО логина, поэтому падение на import оставляет блокировку.
{
  freshStore();
  const { mod, calls } = await loadApi({});
  const api = new mod.ApiClient();
  const { ctx, deps } = makeFlow({ importBackup: 'THROW' });
  deps.api = Object.assign(api, deps.api);
  const unmute = mute();
  await RF.loginWithRecovery(ctx, deps);
  unmute();
  // Логин прошёл (email_connect ушёл в живой ApiClient), но import упал —
  // marker блокирует повтор. Проверяем через calls.log живого ApiClient.
  check('прерывание connect→import: login прошёл, import упал',
    calls.log.some((c) => c.cmd === 'email_connect') && ctx.loginError === 'import boom');
  check('прерывание: marker остаётся → обычный путь заблокирован',
    localStorage.getItem('vault-recovery-pending') === '1');
}

// recovery-session.js — чистый модуль без цикла (не тянет api/crypto).
{
  const rsSrc = readFileSync(ROOT + '/src/features/recovery-session.js', 'utf8');
  check('recovery-session.js не импортирует api/crypto (нет цикла)',
    !rsSrc.includes("from './api.js'") &&
        !rsSrc.includes("from './crypto.js'") &&
        !rsSrc.includes('import api') &&
        !rsSrc.includes('import crypto'));
}

// ══════════════════════════════════════════════════════════════════
// 8) App.initCrypto — политика генерации (живой метод через compiler-sfc)
// ══════════════════════════════════════════════════════════════════
// Достаём РЕАЛЬНЫЙ метод initCrypto из App.vue (compiler-sfc → source) и
// вызываем как функцию с инъектированным crypto. Доказываем: startup
// (allowCreate:false) при отсутствии ключа НЕ генерирует; явный вход
// (allowCreate:true) генерирует; recovery после import — генерация запрещена.
console.log('\nApp.initCrypto — политика генерации:');
function extractInitCryptoBody(scriptSrc) {
  const sig = 'async initCrypto(';
  const s = scriptSrc.indexOf(sig);
  if (s < 0) return null;
  // Пропускаем список параметров (там свои {} в дефолте allowCreate), берём
  // открывающую скобку ТЕЛА — первую '{' после парной ')' сигнатуры.
  const parenOpen = s + sig.length - 1;
  let pdepth = 0, i = parenOpen, q = null, parenClose = -1;
  for (; i < scriptSrc.length; i++) {
    const c = scriptSrc[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') pdepth++;
    else if (c === ')') { pdepth--; if (pdepth === 0) { parenClose = i; break; } }
  }
  if (parenClose < 0) return null;
  const open = scriptSrc.indexOf('{', parenClose);
  let depth = 0, j = open, q2 = null;
  for (; j < scriptSrc.length; j++) {
    const c = scriptSrc[j];
    if (q2) { if (c === '\\') { j++; continue; } if (c === q2) q2 = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q2 = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return scriptSrc.slice(open, j + 1); }
  }
  return null;
}
const APP_SRC = readFileSync(ROOT + '/src/App.vue', 'utf8');
{
  const { descriptor } = sfcParse(APP_SRC, { filename: 'App.vue' });
  const compiled = compileScript(descriptor, { id: 'app' });
  const body = extractInitCryptoBody(compiled.content);
  check('App.vue: метод initCrypto найден компилятором', !!body);
  if (body) {
    // Вырезанный метод использует инъектированные в замыкание символы: crypto,
    // invoke, resetAccountNamespaceCache, ensureAccountNamespace и this.*
    // (loadStoredPeerKeys/cryptoReady/fingerprint). Передаём их параметрами +
    // self-контекстом, чтобы вызвать РЕАЛЬНЫЙ метод App.vue как функцию.
    const makeInitCrypto = new Function('crypto', 'invoke', 'resetAccountNamespaceCache', 'ensureAccountNamespace',
      'return async function initCrypto({ allowCreate = false } = {})' + body);
    const runInit = async (cryptoMock, opts, self) => {
      // Мутируем переданный self на месте (this внутри метода = этот объект),
      // чтобы вызывающий видел выставленный this.publicKey.
      self.publicKey = self.publicKey === undefined ? null : self.publicKey;
      self.cryptoReady = self.cryptoReady === undefined ? false : self.cryptoReady;
      self.fingerprint = self.fingerprint === undefined ? null : self.fingerprint;
      if (typeof self.loadStoredPeerKeys !== 'function') self.loadStoredPeerKeys = async () => {};
      const noopInvoke = async () => undefined;
      return await makeInitCrypto(cryptoMock, noopInvoke, () => {}, async () => {}).call(self, opts);
    };
    // startup/load: нет ключа → false, БЕЗ генерации.
    {
      let gen = 0;
      const c = {
        initFromStorage: async () => ({ loaded: false }),
        generateKeypair: async () => { gen++; return { public_key: 'pk' }; },
        saveToStorage: async () => {},
      };
      const r = await runInit(c, { allowCreate: false }, {});
      check('startup allowCreate:false, нет ключа → false', r === false);
      check('startup allowCreate:false, нет ключа → 0 генерации', gen === 0);
    }
    // explicit login: нет ключа → true, генерация ровно 1.
    {
      let gen = 0;
      const c = {
        initFromStorage: async () => ({ loaded: false }),
        generateKeypair: async () => { gen++; return { public_key: 'pk' }; },
        saveToStorage: async () => {},
        fingerprint: async () => 'fp',
      };
      const self = { publicKey: null, email: null };
      const r = await runInit(c, { allowCreate: true }, self);
      check('явный вход allowCreate:true, нет ключа → true', r === true);
      check('явный вход allowCreate:true, нет ключа → генерация ровно 1', gen === 1);
      check('явный вход: publicKey выставлен', self.publicKey === 'pk');
    }
    // recovery после import: нет ключа → false, БЕЗ генерации.
    {
      let gen = 0;
      const c = {
        initFromStorage: async () => ({ loaded: false }),
        generateKeypair: async () => { gen++; return { public_key: 'pk' }; },
        saveToStorage: async () => {},
      };
      const r = await runInit(c, { allowCreate: false }, {});
      check('recovery после import allowCreate:false, нет ключа → false (не генерим)', r === false && gen === 0);
    }
    // ключ на диске есть → true, 0 генерации (restored key загружен).
    {
      let gen = 0;
      const c = {
        initFromStorage: async () => ({ loaded: true, keypair: { public_key: 'pk-restored' } }),
        generateKeypair: async () => { gen++; return { public_key: 'pk' }; },
        saveToStorage: async () => {},
        fingerprint: async () => 'fp-restored',
      };
      const self = { publicKey: null, email: 'me@x.invalid' };
      const r = await runInit(c, { allowCreate: false }, self);
      check('восстановленный ключ загружен allowCreate:false → true', r === true);
      check('восстановленный ключ: 0 генерации, publicKey восстановлен',
        gen === 0 && self.publicKey === 'pk-restored');
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 9) App.vue wiring: mounted-guard, тонкий делегат loginWithRecovery
// ══════════════════════════════════════════════════════════════════
console.log('\nApp.vue — wiring (compiler-sfc + static):');
{
  const { descriptor } = sfcParse(APP_SRC, { filename: 'App.vue' });
  const compiled = compileScript(descriptor, { id: 'app2' });
  const delSig = 'async loginWithRecovery(';
  const ds = compiled.content.indexOf(delSig);
  check('App.vue: loginWithRecovery — метод компонента', ds >= 0);
  // Тело делегата: от открытия метода до парной закрывающей скобки.
  let delBody = null;
  if (ds >= 0) {
    const open = compiled.content.indexOf('{', ds);
    let depth = 0, i = open, q = null;
    for (; i < compiled.content.length; i++) {
      const c = compiled.content[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { delBody = compiled.content.slice(open, i + 1); break; } }
    }
  }
  check('App.vue: loginWithRecovery — тонкий делегат (RecoveryFeature.*)',
    !!delBody && /RecoveryFeature\.loginWithRecovery/.test(delBody));
  check('App.vue: loginWithRecovery НЕ содержит старой копии (email_fetch_bodies)',
    !delBody || !/email_fetch_bodies/.test(delBody));
  if (delBody) {
    let called = false;
    const names = ['api', 'crypto', 'invoke', 'db', 'relay', 'RelayFeature', 'initNotifications'];
    // Execute the ACTUAL delegate without a global `t`. The old shorthand
    // compiled successfully but threw ReferenceError on the real button.
    const delegate = new Function('RecoveryFeature', ...names,
      'return async function()' + delBody);
    const t = (k) => 'T:' + k;
    await delegate({ loginWithRecovery: async (_, deps) => { called = deps.t === t; } },
      ...names.map(() => ({}))).call({ t });
    check('App.vue: живой делегат передаёт this.t без ReferenceError', called);
  }
  // mounted: guard маркера ДО авто-входа; initCrypto загрузка-only.
  check('App.vue mounted: guard recovery-pending перед авто-входом',
    /RecoverySession\.isRecoveryPending\(\)/.test(compiled.content));
  check('App.vue mounted: при маркере showRecovery=true, перевод ошибки',
    /this\.showRecovery = true/.test(compiled.content) &&
    /this\.t\('recovery_interrupted'\)/.test(compiled.content));
  check('App.vue: обычный login вызывает initCrypto({ allowCreate: true })',
    /initCrypto\(\{ allowCreate: true \}\)/.test(compiled.content));
  check('App.vue: mounted/auto-login/recovery initCrypto({ allowCreate: false })',
    /initCrypto\(\{ allowCreate: false \}\)/.test(compiled.content));
  check('App.vue auto-login: при отсутствии ключа → recovery_missing_keys (не генерация)',
    /recovery_missing_keys/.test(compiled.content));
}

// ══════════════════════════════════════════════════════════════════
// 10) Локали: новые ключи recovery присутствуют во всех трёх
// ══════════════════════════════════════════════════════════════════
console.log('\nЛокали en/ru/zh:');
const NEEDED = ['recovery_interrupted', 'recovery_not_found', 'recovery_missing_keys', 'recovery_state_unavailable'];

// ── App.initCrypto политика генерации (живой метод из App.vue) ──
// Доказываем на САМОМ методе (скомпилированном compiler-sfc), а не на копии:
//   • startup/load (allowCreate по умолчанию false): загружает ключ, НЕ
//     генерирует при отсутствии → возвращает false;
//   • успешная загрузка/создание → true;
//   • явный обычный логин (allowCreate:true) РАЗРЕШАЕТ генерацию;
//   • падение crypto → false.
console.log('\nApp.initCrypto — политика генерации (живой метод):');
{
  const { descriptor } = sfcParse(APP_SRC, { filename: 'App3' });
  const compiled = compileScript(descriptor, { id: 'app3' });
  const sig = 'initCrypto({ allowCreate = false } = {})';
  const s = compiled.content.indexOf(sig);
  check('App.initCrypto: сигнатура содержит allowCreate (фикс применён)', s >= 0);
  // Тело метода: от «{» ПОСЛЕ закрывающей скобки параметров. indexOf('{', s)
  // уткнулся бы в деструктуризацию { allowCreate = false }, поэтому стартуем
  // от парной «)» сигнатуры.
  let body = null;
  if (s >= 0) {
    const afterParams = compiled.content.indexOf(')', s);
    const open = afterParams >= 0 ? compiled.content.indexOf('{', afterParams) : -1;
    let depth = 0, i = open, q = null;
    for (; i < compiled.content.length; i++) {
      const c = compiled.content[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { body = compiled.content.slice(open, i + 1); break; } }
    }
  }
  check('App.initCrypto: тело извлечено', !!body && /initFromStorage/.test(body));

  // Собираем исполняемый метод. Заглушки модульных зависимостей, которые
  // дёргает хвост метода (fingerprint/backfill/peers/namespace).
  function makeInit(storedKey) {
    const gen = { count: 0 };
    const cryptoMock = {
      initFromStorage: async () => (storedKey
        ? { loaded: true, keypair: { public_key: 'pk-restored' } }
        : { loaded: false }),
      generateKeypair: async () => { gen.count++; return { public_key: 'pk-new' }; },
      saveToStorage: async () => {},
      fingerprint: async () => 'fp-restored',
      ensurePeerKey: async () => {},
      getPublicKey: async () => 'pk-restored',
    };
    const app = {
      crypto: cryptoMock,
      publicKey: '',
      email: null,
      cryptoReady: false,
      fingerprint: '',
      keypair: null,
      peerKeys: {},
      peerKeysLoaded: {},
      peerPqKeys: {},
      loadStoredPeerKeys: async () => {},
    };
    // Минимальные модульные функции, что использует хвост initCrypto.
    const g = {
      crypto: cryptoMock,
      invoke: async () => {},
      resetAccountNamespaceCache: () => {},
      ensureAccountNamespace: async () => {},
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('crypto', 'invoke', 'resetAccountNamespaceCache', 'ensureAccountNamespace', 'opts',
      'return (async function(){ var allowCreate=false; if(opts&&opts.allowCreate)allowCreate=true;'
      + body.replace(/^\{\s*/, '').replace(/\s*\}$/, '')
      + ' }).call(this);');
    return {
      gen,
      run: (opts) => fn.call(app,
        g.crypto, g.invoke, g.resetAccountNamespaceCache, g.ensureAccountNamespace, opts),
    };
  }

  // startup/load (по умолчанию allowCreate=false), ключа нет → false, gen 0.
  {
    const k = makeInit(false);
    const u = mute();
    const r = await k.run();
    u();
    check('initCrypto(): ключа нет, allowCreate=false → false (генерации нет)',
      r === false && k.gen.count === 0);
  }
  // startup с ключом на диске → true, gen 0.
  {
    const k = makeInit(true);
    const u = mute();
    const r = await k.run();
    u();
    check('initCrypto(): ключ на диске → true, генерации нет',
      r === true && k.gen.count === 0);
  }
  // явный обычный логин (allowCreate:true), ключа нет → создаёт → true.
  {
    const k = makeInit(false);
    const u = mute();
    const r = await k.run({ allowCreate: true });
    u();
    check('initCrypto({allowCreate:true}): ключа нет → генерирует → true',
      r === true && k.gen.count === 1);
  }
  // pending recovery (allowCreate:false после import) при отсутствии ключа →
  // НЕ генерирует (это запрещено), возвращает false.
  {
    const k = makeInit(false);
    const u = mute();
    const r = await k.run({ allowCreate: false });
    u();
    check('recovery allowCreate:false: ключа нет → НЕ генерирует → false',
      r === false && k.gen.count === 0);
  }
}

for (const loc of ['en', 'ru', 'zh']) {
  const src = readFileSync(ROOT + '/src/locales/' + loc + '.js', 'utf8');
  for (const key of NEEDED) {
    check(loc + ': ключ ' + key + ' присутствует',
      new RegExp("['\"]?" + key + "['\"]?\\s*:").test(src));
  }
}

console.log('\nИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);

